import { parseUtcOffset, resolveStart } from "./icsTime.js";

/**
 * Parses a meeting-invite email (decoded from SendGrid Inbound Parse, see inbound.ts) into the data the orchestrator needs: the meeting
 * link (Teams, Zoom or Google Meet), which interview alias it was sent to, and (from the ICS attachment, when present)
 * the stable meeting UID, method and start time.
 *
 * Email content is UNTRUSTED input: only links whose host AND path match a known meeting format are returned.
 */

export interface InviteAttachment {
  name: string;
  contentType?: string;
  /** base64 content of the calendar attachment */
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
  /** UTC start time (`YYYY-MM-DDTHH:MM:SSZ`), when the invite's start could be resolved with confidence */
  startsAt?: string;
  /** Why startsAt is missing (e.g. `unknown_timezone:Foo`, `floating_time`); absent when there is no calendar data at all */
  startIssue?: string;
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
  startIssue?: string;
}

function unfold(ics: string): string[] {
  return ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

/** Zones defined inside the invite (VTIMEZONE) that have no daylight-saving rule: TZID -> fixed offset in minutes. */
function fixedZoneOffsets(lines: string[]): Map<string, number> {
  const out = new Map<string, number>();
  let tzid: string | undefined;
  let hasDaylight = false;
  let standard: number | undefined;
  let inZone = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VTIMEZONE") {
      inZone = true;
      tzid = undefined;
      hasDaylight = false;
      standard = undefined;
    } else if (upper === "END:VTIMEZONE") {
      if (inZone && tzid && !hasDaylight && standard !== undefined) out.set(tzid, standard);
      inZone = false;
    } else if (inZone) {
      if (upper.startsWith("TZID:")) tzid = line.slice(5).trim().replace(/^"|"$/g, "");
      else if (upper === "BEGIN:DAYLIGHT") hasDaylight = true;
      else if (upper.startsWith("TZOFFSETTO:") && standard === undefined) standard = parseUtcOffset(line.slice(11));
    }
  }
  return out;
}

export function parseIcs(ics: string): IcsInfo {
  const out: IcsInfo = {};
  const lines = unfold(ics);
  const fixed = fixedZoneOffsets(lines);
  // Outlook puts a VTIMEZONE block (with its own placeholder DTSTART:16010101T000000 lines) BEFORE the event, so the
  // event's UID and start must be read only from inside BEGIN:VEVENT, and only from the first event of a series.
  let inEvent = false;
  let eventDone = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = !eventDone;
      continue;
    }
    if (upper === "END:VEVENT") {
      if (inEvent) eventDone = true;
      inEvent = false;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    const [rawName, ...params] = key.split(";");
    const name = rawName?.toUpperCase();
    if (name === "METHOD" && !inEvent) out.method = value.toUpperCase();
    else if (!inEvent) continue;
    else if (name === "UID" && !out.uid) out.uid = value;
    else if (name === "DTSTART" && !out.startsAt && !out.startIssue) {
      const tzParam = params.find((p) => p.toUpperCase().startsWith("TZID="));
      const tzid = tzParam ? tzParam.slice(5).trim().replace(/^"|"$/g, "") : undefined;
      const result = resolveStart(value, tzid, tzid ? fixed.get(tzid) : undefined);
      if (result.iso) out.startsAt = result.iso;
      else out.startIssue = result.issue;
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
    startIssue: ics.startsAt ? undefined : ics.startIssue,
    subject: email.subject,
    from: email.from,
  };
}
