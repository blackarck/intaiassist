import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { anyOf, googleVerifier, microsoftVerifier } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { fakeController } from "./helpers.js";

const CLIENT = "11111111-2222-3333-4444-555555555555";
const TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey as CryptoKey;
  const pub = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JWK;
  jwks = createLocalJWKSet({ keys: [pub] });
});

const sign = (claims: Record<string, unknown>, o: { aud?: string; iss?: string; exp?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(o.iss ?? `https://login.microsoftonline.com/${TID}/v2.0`).setAudience(o.aud ?? CLIENT).setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(privateKey);

describe("microsoftVerifier", () => {
  const v = () => microsoftVerifier({ clientId: CLIENT, jwks });
  it("accepts a token for our app and builds the subject from tenant + account id, not from e-mail", async () => {
    const p = await v().verify(await sign({ tid: TID, oid: "oid-1", preferred_username: "Asha@Acme.com", name: "Asha" }));
    expect(p).toEqual({ provider: "microsoft", subject: `microsoft:${TID}:oid-1`, email: "asha@acme.com", name: "Asha" });
  });
  it("prefers the email claim and falls back to sub when there is no oid", async () => {
    const p = await v().verify(await sign({ tid: TID, sub: "sub-9", email: "x@y.com", preferred_username: "other@z.com" }));
    expect(p).toMatchObject({ subject: `microsoft:${TID}:sub-9`, email: "x@y.com" });
  });
  it("rejects wrong audience, expired, tampered, foreign issuer, tenant mismatch, and tokens without an address", async () => {
    const ok = { tid: TID, oid: "o", preferred_username: "a@b.com" };
    expect(await v().verify(await sign(ok, { aud: "someone-else" }))).toBeUndefined();
    expect(await v().verify(await sign(ok, { exp: "-1m" }))).toBeUndefined();
    expect(await v().verify((await sign(ok)).slice(0, -3) + "abc")).toBeUndefined();
    expect(await v().verify(await sign(ok, { iss: "https://evil.example.com/v2.0" }))).toBeUndefined();
    expect(await v().verify(await sign(ok, { iss: `https://login.microsoftonline.com/${TID}/v2.0.evil` }))).toBeUndefined();
    expect(await v().verify(await sign({ ...ok, tid: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee" }))).toBeUndefined();
    expect(await v().verify(await sign({ tid: TID, oid: "o", preferred_username: "no-at-sign" }))).toBeUndefined();
    expect(await v().verify("not a jwt")).toBeUndefined();
  });
});

describe("googleVerifier", () => {
  const v = () => googleVerifier({ clientId: CLIENT, jwks });
  const g = (claims: Record<string, unknown>) => sign(claims, { iss: "https://accounts.google.com" });
  it("accepts a verified address and refuses an unverified one", async () => {
    expect(await v().verify(await g({ sub: "123", email: "A@Gmail.com", email_verified: true }))).toEqual({ provider: "google", subject: "google:accounts:123", email: "a@gmail.com", name: undefined });
    expect(await v().verify(await g({ sub: "123", email: "a@gmail.com", email_verified: false }))).toBeUndefined();
    expect(await v().verify(await sign({ sub: "1", email: "a@b.c", email_verified: true }))).toBeUndefined(); // Microsoft-issued, not Google
  });
  it("anyOf tries each provider", async () => {
    const both = anyOf(microsoftVerifier({ clientId: CLIENT, jwks }), v());
    expect((await both.verify(await g({ sub: "1", email: "a@b.com", email_verified: true })))?.provider).toBe("google");
    expect((await both.verify(await sign({ tid: TID, oid: "o", email: "a@b.com" })))?.provider).toBe("microsoft");
  });
});

describe("API access policy", () => {
  const OP = { authorization: "Bearer op-token" };
  async function setup(extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
    const store = new InMemoryStore();
    const app = buildApp({
      store, transcripts: store, controller: fakeController(), aliasDomain: "invite.askproso.ai", intakeToken: "op-token", enableDevRoutes: false,
      verifier: microsoftVerifier({ clientId: CLIENT, jwks }), allowedOrigins: ["https://intassist.askproso.ai"], ...extra,
    });
    const asha = { authorization: `Bearer ${await sign({ tid: TID, oid: "asha", preferred_username: "asha@acme.com", name: "Asha" })}` };
    const bob = { authorization: `Bearer ${await sign({ tid: TID, oid: "bob", preferred_username: "bob@acme.com" })}` };
    const call = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method, url, headers, payload: payload as never });
    return { app, store, asha, bob, call };
  }

  it("lets a signed-in person create and list their own interviews, and see only those", async () => {
    const { call, asha, bob } = await setup();
    expect((await call("GET", "/api/me", asha)).json()).toMatchObject({ email: "asha@acme.com", subject: `microsoft:${TID}:asha`, isAdmin: false });
    const made = (await call("POST", "/api/me/interviews", asha)).json();
    expect(made).toMatchObject({ status: "paid", address: expect.stringMatching(/^iv-[0-9a-hjkmnp-tv-z]{10}@invite\.askproso\.ai$/) });
    expect(JSON.stringify(made)).not.toMatch(/ownerSubject|ownerEmail|recallBotId/);
    expect((await call("GET", "/api/me/interviews", asha)).json().interviews.map((i: { id: string }) => i.id)).toEqual([made.id]);
    expect((await call("GET", "/api/me/interviews", bob)).json().interviews).toEqual([]);
  });

  it("owner can read their interview; another person gets 404, not 403; the operator can read any", async () => {
    const { call, asha, bob } = await setup();
    const made = (await call("POST", "/api/me/interviews", asha)).json();
    expect((await call("GET", `/api/interviews/${made.id}`, asha)).statusCode).toBe(200);
    expect((await call("GET", `/api/interviews/${made.id}`, bob)).statusCode).toBe(404);
    expect((await call("GET", `/api/interviews/${made.id}/transcript`, bob)).statusCode).toBe(404);
    expect((await call("GET", `/api/interviews/${made.id}`, OP)).statusCode).toBe(200);
    expect((await call("GET", `/api/interviews/does-not-exist`, asha)).statusCode).toBe(404);
  });

  it("an interview created by the operator (no owner) is not reachable by any user", async () => {
    const { call, asha } = await setup();
    const made = (await call("POST", "/api/interviews", OP, { ownerEmail: "asha@acme.com" })).json();
    expect((await call("GET", `/api/interviews/${made.id}`, asha)).statusCode).toBe(404); // same e-mail is not enough
  });

  it("keeps operator-only routes closed to users, and /api/me closed to the operator token", async () => {
    const { call, asha } = await setup();
    expect((await call("POST", "/api/interviews", asha, { ownerEmail: "a@b.com" })).statusCode).toBe(403);
    expect((await call("POST", "/api/intake/link", asha, {})).statusCode).toBe(403);
    expect((await call("GET", "/api/me", OP)).statusCode).toBe(403);
    expect((await call("GET", "/api/me", {})).statusCode).toBe(401);
    expect((await call("GET", "/api/me", { authorization: "Bearer garbage" })).statusCode).toBe(401);
  });

  it("admin routes need the operator or an allow-listed login", async () => {
    const { call, asha } = await setup({ adminSubjects: [`microsoft:${TID}:asha`], ai: undefined });
    expect((await call("GET", "/api/admin/ai/config", asha)).statusCode).toBe(501); // allowed in, AI just not configured here
    const other = await setup();
    expect((await other.call("GET", "/api/admin/ai/config", other.bob)).statusCode).toBe(403);
    expect((await other.call("GET", "/api/me", asha)).statusCode).toBe(200);
    expect((await call("GET", "/api/me", asha)).json().isAdmin).toBe(true);
  });

  it("dev auth works only when switched on", async () => {
    const dev = { authorization: "Dev tester@local.test" };
    expect((await (await setup()).call("GET", "/api/me", dev)).statusCode).toBe(401);
    const on = await setup({ devAuth: true });
    expect((await on.call("GET", "/api/me", dev)).json()).toMatchObject({ email: "tester@local.test", subject: "dev:local:tester@local.test" });
  });

  it("answers CORS preflight for the web app origin only", async () => {
    const { app } = await setup();
    const pre = (origin: string) => app.inject({ method: "OPTIONS", url: "/api/me/interviews", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    const ok = await pre("https://intassist.askproso.ai");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://intassist.askproso.ai");
    expect(ok.headers["access-control-allow-headers"]).toMatch(/authorization/i);
    expect((await pre("https://evil.example.com")).headers["access-control-allow-origin"]).toBeUndefined();
  });
});
