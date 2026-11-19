import { WINDOWS_TO_IANA } from "./windowsZones.js";

/**
 * Meeting start times from calendar invites (iCalendar DTSTART) -> UTC.
 *
 * Invites come in three shapes:
 *   20261120T100000Z                                    UTC: trivial
 *   DTSTART;TZID=Europe/London:20261120T100000          local time + IANA zone id
 *   DTSTART;TZID=India Standard Time:20261120T153000    local time + WINDOWS zone name (Outlook / Exchange)
 *   DTSTART:20261120T153000                             "floating": no zone, cannot be resolved
 *
 * Getting this wrong is expensive in one direction (a bot that joins hours early or late), so anything we cannot resolve
 * with confidence returns an `issue` and NO time: the bot is then created for an immediate join instead of a wrong schedule.
 */

const LOCAL = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const UTC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export interface StartResult {
  /** `YYYY-MM-DDTHH:MM:SSZ` */
  iso?: string;
  /** Why no time was produced. Contains only a zone name or a fixed word, never personal data. */
  issue?: string;
}

export function isIanaZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `zone` from UTC at the instant `utcMs`: local wall-clock minus UTC. */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

const toIso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Local wall-clock time in an IANA zone -> UTC, correct across daylight-saving changes. */
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): string {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // The offset depends on the instant we are trying to find, so evaluate it twice: once at the naive guess, once at the corrected instant.
  const first = wallAsUtc - zoneOffsetMs(wallAsUtc, zone);
  return toIso(wallAsUtc - zoneOffsetMs(first, zone));
}

/** "+0530", "-0800", "+053000" -> minutes east of UTC. */
export function parseUtcOffset(text: string): number | undefined {
  const m = text.trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return undefined;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/**
 * @param value  the DTSTART value, e.g. "20261120T153000" or "20261120T100000Z"
 * @param tzid   the TZID parameter if present (quotes already removed)
 * @param fixedOffsetMinutes  offset from the invite's own VTIMEZONE block when that zone has no daylight-saving rule
 */
export function resolveStart(value: string, tzid: string | undefined, fixedOffsetMinutes?: number): StartResult {
  const utc = value.match(UTC);
  if (utc) return { iso: `${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}Z` };

  const local = value.match(LOCAL);
  if (!local) return { issue: /^\d{8}$/.test(value) ? "date_only" : "unrecognised_format" };
  const [y, mo, d, h, mi, s] = local.slice(1).map(Number) as [number, number, number, number, number, number];

  if (!tzid) return { issue: "floating_time" };

  if (isIanaZone(tzid)) return { iso: localToUtc(y, mo, d, h, mi, s, tzid) };

  const iana = WINDOWS_TO_IANA[tzid];
  if (iana && isIanaZone(iana)) return { iso: localToUtc(y, mo, d, h, mi, s, iana) };

  if (fixedOffsetMinutes !== undefined) {
    return { iso: toIso(Date.UTC(y, mo - 1, d, h, mi, s) - fixedOffsetMinutes * 60_000) };
  }
  return { issue: `unknown_timezone:${tzid.slice(0, 60)}` };
}
