/**
 * Parses a meeting-invite email (as forwarded by the Logic App) into the data the orchestrator needs: the meeting
 * link (Teams, Zoom or Google Meet), which interview alias it was sent to, and (from the ICS attachment, when present)
 * the stable meeting UID, method and start time.
 *
 * Email content is UNTRUSTED input: only links whose host AND path match a known meeting format are returned.
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
export type MeetingPlatform = "teams" | "zoom" | "meet";

export interface MeetingLink {
  url: string;
  platform: MeetingPlatform;
}

export interface ParsedInvite {
  meeting?: MeetingLink;
  /** alias tags found among recipients, e.g. "7KQ2" */
  aliasTags: string[];
  method: InviteMethod;
  /** ICS UID, stable across updates/reschedules */
  icalUid?: string;
  /** ISO string, only when ICS DTSTART was UTC */
  startsAt?: string;
  subject: string;
  from: string;
}

// Any https URL; each candidate is then validated strictly by host and path.
const URL_RE = /https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s"'<>)]*/g;

const SAFELINK_RE = /https:\/\/[a-z0-9.-]*safelinks\.protection\.outlook\.com\/[^\s"'<>]*/gi;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#43;/g, "+")
    .replace(/&#x2b;/gi, "+")
    .replace(/&quot;/gi, '"');
}

/** Unwrap Defender Safe Links so the real meeting URL is visible. */
function unwrapSafeLinks(text: string): string {
  return text.replace(SAFELINK_RE, (m) => {
    try {
      const u = new URL(decodeHtmlEntities(m));
      return u.searchParams.get("url") ?? m;
    } catch {
      return m;
    }
  });
}

/** Returns the platform if the URL is a real meeting join link, otherwise undefined. */
export function classifyMeetingUrl(u: URL): MeetingPlatform | undefined {
  if (u.protocol !== "https:" || u.port) return undefined;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (
    (host === "teams.microsoft.com" && (path.startsWith("/l/meetup-join/") || /^\/meet\/\d+/.test(path))) ||
    (host === "teams.live.com" && /^\/meet\/\d+/.test(path))
  ) {
    return "teams";
  }
  if ((host === "zoom.us" || host.endsWith(".zoom.us")) && /^\/(j|wc\/join)\/\d{9,12}/.test(path)) {
    return "zoom";
  }
  if (host === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(path)) {
    return "meet";
  }
  return undefined;
}

/** First valid meeting link in the text (HTML or plain), or undefined. */
export function extractMeetingLink(body: string): MeetingLink | undefined {
  const text = unwrapSafeLinks(decodeHtmlEntities(body));
  for (const raw of text.match(URL_RE) ?? []) {
    const cleaned = raw.replace(/[.,;]+$/, "");
    try {
      const u = new URL(cleaned);
      const platform = classifyMeetingUrl(u);
      if (platform) return { url: u.toString(), platform };
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
 *   assistant+7KQ2@domain (plus addressing; verify it survives in the To header)
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
    meeting: extractMeetingLink(email.body),
    aliasTags,
    method: isCancel ? "cancel" : "request",
    icalUid: ics.uid,
    startsAt: ics.startsAt,
    subject: email.subject,
    from: email.from,
  };
}
