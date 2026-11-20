import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";

/**
 * Models the coaching tasks may use. The list is data: a model is assigned to a task (primary + fallback) in the AI
 * configuration (see configStore.ts), so swapping one is a settings change, not a deploy.
 *
 * Azure ids are DEPLOYMENT names on our Foundry resource (checked against its deployment list on 2026-11-19).
 * Models that are not deployed there (deepseek, qwen, mai-*, microsoft-decision) can be added once they are.
 */
export interface ModelSpec {
  id: string;
  label: string;
  provider: "azure" | "anthropic";
  /** Azure deployment name, or Anthropic model id. */
  name: string;
  /** Azure only: OpenAI-family models use the Responses API; other families use Chat Completions. */
  api?: "responses" | "chat";
  /** Reasoning models reject a temperature; leave false for them. */
  acceptsTemperature: boolean;
}

export const CATALOG: ModelSpec[] = [
  { id: "azure:DeepSeek-V4.1-Flash-1017", label: "DeepSeek Flash", provider: "azure", name: "DeepSeek-V4.1-Flash-1017", api: "responses", acceptsTemperature: false },
  { id: "azure:gpt-5.4-nano", label: "GPT-5.4 nano", provider: "azure", name: "gpt-5.4-nano", api: "responses", acceptsTemperature: false },
  { id: "azure:gpt-5.4-mini", label: "GPT-5.4 mini", provider: "azure", name: "gpt-5.4-mini", api: "responses", acceptsTemperature: false },
  // { id: "azure:gpt-5.4", label: "GPT-5.4", provider: "azure", name: "gpt-5.4", api: "responses", acceptsTemperature: false },
  // { id: "azure:gpt-5.6-terra", label: "GPT-5.6 terra", provider: "azure", name: "gpt-5.6-terra", api: "responses", acceptsTemperature: false },
  { id: "azure:gpt-6-luna", label: "GPT-6 luna", provider: "azure", name: "gpt-6-luna", api: "responses", acceptsTemperature: false },
  { id: "anthropic:haiku", label: "Claude Haiku 5.5", provider: "anthropic", name: "claude-haiku-5-5", acceptsTemperature: true },
  // { id: "anthropic:sonnet", label: "Claude Sonnet 5.5", provider: "anthropic", name: "claude-sonnet-5-5", acceptsTemperature: true },
 ];

export const findModel = (id: string): ModelSpec | undefined => CATALOG.find((m) => m.id === id);

/** Builds the SDK model object for a catalog entry. Injectable so tests never touch the network. */
export type ModelFactory = (spec: ModelSpec) => LanguageModel;

export interface ProviderEnv {
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

/** Catalog ids whose provider has credentials in this environment: what a person may pick for an interview. */
export function availableModels(env: ProviderEnv): ModelSpec[] {
  return CATALOG.filter((m) => (m.provider === "anthropic" ? !!env.ANTHROPIC_API_KEY : !!env.AZURE_OPENAI_API_KEY && !!env.AZURE_OPENAI_ENDPOINT));
}

export function envModelFactory(env: ProviderEnv): ModelFactory {
  // Providers are created lazily: a missing key only matters if a task is actually routed to that provider.
  let azure: ReturnType<typeof createAzure> | undefined;
  let anthropic: ReturnType<typeof createAnthropic> | undefined;
  return (spec) => {
    if (spec.provider === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
      anthropic ??= createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return anthropic(spec.name);
    }
    if (!env.AZURE_OPENAI_API_KEY || !env.AZURE_OPENAI_ENDPOINT) throw new Error("AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY are not set");
    azure ??= createAzure({ resourceName: new URL(env.AZURE_OPENAI_ENDPOINT).hostname.split(".")[0]!, apiKey: env.AZURE_OPENAI_API_KEY });
    return spec.api === "chat" ? azure.chat(spec.name) : azure(spec.name);
  };
}
