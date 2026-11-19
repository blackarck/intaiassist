import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** A signed-in person, from a verified Microsoft or Google ID token. */
export interface Principal {
  provider: "microsoft" | "google";
  /** "<provider>:<tenant or pool>:<account id>". Ownership and admin rights are decided by this, never by e-mail. */
  subject: string;
  email: string;
  name?: string;
}

export interface TokenVerifier {
  /** The principal for a valid token, or undefined for anything else (wrong audience, expired, forged...). Never throws. */
  verify(token: string): Promise<Principal | undefined>;
}

const MS_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;

/**
 * Microsoft Entra ID (work and school accounts of any tenant, and personal Microsoft accounts).
 * The token is the ID token the browser got for OUR application, so `aud` must be our client id. `iss` carries the
 * user's tenant, so it is matched by shape and must agree with the `tid` claim.
 *
 * `jwks` is injectable for tests; production uses Microsoft's published signing keys.
 */
export function microsoftVerifier(opts: { clientId: string; jwks?: JWTVerifyGetKey }): TokenVerifier {
  const keys = opts.jwks ?? createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, keys, { audience: opts.clientId });
        const m = typeof payload.iss === "string" ? MS_ISSUER.exec(payload.iss) : null;
        const tid = m?.[1];
        if (!tid || (typeof payload.tid === "string" && payload.tid !== tid)) return undefined;
        const oid = typeof payload.oid === "string" ? payload.oid : typeof payload.sub === "string" ? payload.sub : undefined;
        // Work accounts carry e-mail in `email` (optional claim) or `preferred_username` (the UPN, normally an address).
        const raw = typeof payload.email === "string" ? payload.email : typeof payload.preferred_username === "string" ? payload.preferred_username : undefined;
        if (!oid || !raw || !raw.includes("@")) return undefined;
        return { provider: "microsoft", subject: `microsoft:${tid}:${oid}`, email: raw.toLowerCase(), name: typeof payload.name === "string" ? payload.name : undefined };
      } catch {
        return undefined;
      }
    },
  };
}

/** Google Sign-In ID tokens. The e-mail must be verified by Google. */
export function googleVerifier(opts: { clientId: string; jwks?: JWTVerifyGetKey }): TokenVerifier {
  const keys = opts.jwks ?? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, keys, { audience: opts.clientId, issuer: ["https://accounts.google.com", "accounts.google.com"] });
        if (typeof payload.sub !== "string" || typeof payload.email !== "string" || payload.email_verified !== true) return undefined;
        return { provider: "google", subject: `google:accounts:${payload.sub}`, email: payload.email.toLowerCase(), name: typeof payload.name === "string" ? payload.name : undefined };
      } catch {
        return undefined;
      }
    },
  };
}

/** Tries each verifier in turn. */
export function anyOf(...verifiers: TokenVerifier[]): TokenVerifier {
  return {
    async verify(token) {
      for (const v of verifiers) {
        const p = await v.verify(token);
        if (p) return p;
      }
      return undefined;
    },
  };
}

export type Auth = { kind: "operator" } | { kind: "user"; principal: Principal };
