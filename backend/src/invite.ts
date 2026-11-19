/**
 * Parses a meeting-invite email (as forwarded by the Logic App) into the data
 * the orchestrator needs: Teams join URL, which interview alias it was sent to,
 * and (from the ICS attachment, when present) the stable meeting UID, method
 * and start time.
 *
 * Email content is UNTRUSTED input: only strictly-matched Teams URLs are returned.
 */

export interface InviteAttachment {
  name: string;
  contentType?: string;
  /** base64 content as provided by the Logic App connector */
  contentBytes: string;
}

export interface InviteEmail {
  messageId: string;
  from: string;
  /** Office 365 connector gives semicolon-separated strings */
  to: string;
  cc?: string;
  subject: string;
  body: string;
  receivedAt?: string;
  attachments?: InviteAttachment[];
}

export type InviteMethod = "request" | "cancel";

export interface ParsedInvite {
  joinUrl?: string;
  /** alias tags found among recipients, e.g. "7KQ2" */
  aliasTags: string[];
  method: InviteMethod;
  /** ICS UID — stable across updates/reschedules */
  icalUid?: string;
  /** ISO string, only when ICS DTSTART was UTC */
  startsAt?: string;
  subject: string;
  from: string;
}

const ALLOWED_HOSTS = new Set(["teams.microsoft.com", "teams.live.com"]);

// Matches https://teams.microsoft.com/l/meetup-join/..., /meet/<id>?p=..., teams.live.com/meet/...
const TEAMS_URL_RE =
  /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\/(?:l\/meetup-join\/[^\s"'<>)]+|meet\/[^\s"'<>)]+)/gi;

const SAFELINK_RE = /https:\/\/[a-z0-9.-]*safelinks\.protection\.outlook\.com\/[^\s"'<>]*/gi;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#43;/g, "+")
    .replace(/&#x2b;/gi, "+")
    .replace(/&quot;/gi, '"');
}

/** Unwrap Defender Safe Links so the real Teams URL is visible. */
function unwrapSafeLinks(text: string): string {
  return text.replace(SAFELINK_RE, (m) => {
    try {
      const u = new URL(decodeHtmlEntities(m));
      const inner = u.searchParams.get("url");
      return inner ?? m;
    } catch {
      return m;
    }
  });
}

export function extractJoinUrl(body: string): string | undefined {
  const text = unwrapSafeLinks(decodeHtmlEntities(body));
  const matches = text.match(TEAMS_URL_RE);
  if (!matches) return undefined;
  for (const raw of matches) {
    // trim trailing punctuation that regex may have swallowed
    const cleaned = raw.replace(/[.,;]+$/, "");
    try {
      const u = new URL(cleaned);
      if (u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname)) return u.toString();
    } catch {
      /* ignore malformed */
    }
  }
  return undefined;
}

/** "Name <a@b.com>; c@d.com" -> ["a@b.com","c@d.com"] */
export function splitAddresses(list: string | undefined): string[] {
  if (!list) return [];
  return list
    .split(/[;,]/)
    .map((p) => {
      const m = p.match(/<([^>]+)>/);
      return (m?.[1] ?? p).trim().toLowerCase();
    })
    .filter((p) => p.includes("@"));
}

/**
 * Supports both alias styles:
 *   iv-7KQ2@domain        (proxy alias)
 *   assistant+7KQ2@domain (plus addressing — verify it survives in the To header)
 */
export function extractAliasTags(addresses: string[], aliasDomain: string): string[] {
  const tags = new Set<string>();
  for (const addr of addresses) {
    const [local, domain] = addr.split("@");
    if (!local || domain !== aliasDomain.toLowerCase()) continue;
    const m = local.match(/^(?:iv-|assistant\+)([a-z0-9]{3,32})$/i);
    if (m?.[1]) tags.add(m[1].toUpperCase());
  }
  return [...tags];
}

interface IcsInfo {
  method?: string;
  uid?: string;
  startsAt?: string;
}

function unfold(ics: string): string[] {
  return ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

export function parseIcs(ics: string): IcsInfo {
  const out: IcsInfo = {};
  for (const line of unfold(ics)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    const name = key.split(";")[0]?.toUpperCase();
    if (name === "METHOD") out.method = value.toUpperCase();
    else if (name === "UID" && !out.uid) out.uid = value;
    else if (name === "DTSTART" && !out.startsAt) {
      // Only trust UTC form; TZID-based times need a tz database mapping (Windows tz names).
      const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (m) out.startsAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    }
  }
  return out;
}

export function parseInvite(email: InviteEmail, aliasDomain: string): ParsedInvite {
  const recipients = [...splitAddresses(email.to), ...splitAddresses(email.cc)];
  const aliasTags = extractAliasTags(recipients, aliasDomain);

  let ics: IcsInfo = {};
  const icsAtt = email.attachments?.find(
    (a) => /\.ics$/i.test(a.name) || /calendar/i.test(a.contentType ?? ""),
  );
  if (icsAtt) {
    try {
      ics = parseIcs(Buffer.from(icsAtt.contentBytes, "base64").toString("utf8"));
    } catch {
      /* ignore bad attachment */
    }
  }

  const isCancel = ics.method === "CANCEL" || /^\s*(canceled|cancelled)\s*:/i.test(email.subject);

  return {
    joinUrl: extractJoinUrl(email.body),
    aliasTags,
    method: isCancel ? "cancel" : "request",
    icalUid: ics.uid,
    startsAt: ics.startsAt,
    subject: email.subject,
    from: email.from,
  };
}
