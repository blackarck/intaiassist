/**
 * Thin client for the Recall.ai meeting-bot API (https://docs.recall.ai).
 *
 * - Auth: `Authorization: <API key>` (their documented format; no "Bearer" prefix).
 * - A bot is created with the meeting URL, real-time transcription (Recall's own streaming provider, separate
 *   audio streams per speaker where available) and a real-time webhook endpoint for transcript events.
 * - `join_at` more than 10 minutes ahead creates a *scheduled* bot (guaranteed on time); anything nearer is *ad hoc*
 *   and can hit 507 when Recall's warm pool is empty, so 507 is retried (their guidance: every 30 s, up to 10 times).
 */

export interface RecallConfig {
  apiKey: string;
  /** us-west-2 | us-east-1 | eu-central-1 | ap-northeast-1. Credentials are per region. */
  region: string;
  /** Public URL Recall posts real-time transcript events to, e.g. https://host/webhooks/recall */
  webhookUrl: string;
  botName?: string;
  language?: string;
  /** 507 retry policy; defaults follow Recall's guidance. Tests set retryDelayMs to 0. */
  retryDelayMs?: number;
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface CreateBotArgs {
  meetingUrl: string;
  /** ISO time. Omit to join immediately. */
  joinAt?: string;
  metadata?: Record<string, string>;
}

export interface RecallApi {
  createBot(args: CreateBotArgs): Promise<{ id: string }>;
  /** Removes a bot that has not started joining yet. */
  deleteBot(botId: string): Promise<void>;
  /** Asks a bot that is in (or joining) the call to leave. */
  leaveCall(botId: string): Promise<void>;
}

export class RecallError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    detail: string,
  ) {
    super(`Recall ${operation} failed: HTTP ${status} ${detail}`.trim());
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RecallClient implements RecallApi {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: RecallConfig) {
    if (!cfg.apiKey) throw new Error("Recall API key is required");
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(cfg.region)) throw new Error(`Unexpected Recall region "${cfg.region}"`);
    this.base = `https://${cfg.region}.recall.ai/api/v1`;
    this.f = cfg.fetchImpl ?? fetch;
  }

  private headers() {
    return { authorization: this.cfg.apiKey, accept: "application/json", "content-type": "application/json" };
  }

  /** Body of Create Bot. Exposed for tests. */
  buildCreateBody(args: CreateBotArgs) {
    return {
      meeting_url: args.meetingUrl,
      bot_name: this.cfg.botName ?? "Interview Assistant",
      ...(args.joinAt ? { join_at: args.joinAt } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
      recording_config: {
        transcript: {
          provider: {
            recallai_streaming: { mode: "prioritize_low_latency", language_code: this.cfg.language ?? "en" },
          },
          diarization: { use_separate_streams_when_available: true },
        },
        realtime_endpoints: [
          {
            type: "webhook",
            url: this.cfg.webhookUrl,
            events: ["transcript.data", "transcript.partial_data"],
          },
        ],
      },
    };
  }

  async createBot(args: CreateBotArgs): Promise<{ id: string }> {
    const max = this.cfg.maxRetries ?? 10;
    const delay = this.cfg.retryDelayMs ?? 30_000;
    for (let attempt = 1; ; attempt++) {
      const res = await this.f(`${this.base}/bot/`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildCreateBody(args)),
      });
      if (res.status === 507 && attempt < max) {
        await sleep(delay); // ad-hoc bot pool momentarily empty
        continue;
      }
      if (!res.ok) throw new RecallError(res.status, "create bot", (await res.text()).slice(0, 300));
      const json = (await res.json()) as { id?: string };
      if (!json.id) throw new RecallError(res.status, "create bot", "response had no bot id");
      return { id: json.id };
    }
  }

  async deleteBot(botId: string): Promise<void> {
    const res = await this.f(`${this.base}/bot/${encodeURIComponent(botId)}/`, { method: "DELETE", headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new RecallError(res.status, "delete bot", (await res.text()).slice(0, 300));
  }

  async leaveCall(botId: string): Promise<void> {
    const res = await this.f(`${this.base}/bot/${encodeURIComponent(botId)}/leave_call/`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    if (!res.ok && res.status !== 404) throw new RecallError(res.status, "leave call", (await res.text()).slice(0, 300));
  }
}
