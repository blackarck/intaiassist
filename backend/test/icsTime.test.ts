import { describe, expect, it } from "vitest";
import { isIanaZone, localToUtc, parseUtcOffset, resolveStart } from "../src/icsTime.js";
import { parseIcs, parseInvite } from "../src/invite.js";
import { WINDOWS_TO_IANA } from "../src/windowsZones.js";

describe("localToUtc", () => {
  it("handles daylight saving: New York is UTC-5 in winter and UTC-4 in summer", () => {
    expect(localToUtc(2026, 12, 1, 10, 0, 0, "America/New_York")).toBe("2026-12-01T15:00:00Z");
    expect(localToUtc(2026, 7, 1, 10, 0, 0, "America/New_York")).toBe("2026-07-01T14:00:00Z");
  });
  it("handles zones with a half-hour offset and no DST", () => {
    expect(localToUtc(2026, 11, 20, 15, 30, 0, "Asia/Kolkata")).toBe("2026-11-20T10:00:00Z");
    expect(localToUtc(2026, 11, 20, 15, 30, 0, "Asia/Calcutta")).toBe("2026-11-20T10:00:00Z");
  });
  it("handles London both sides of the clock change", () => {
    expect(localToUtc(2026, 1, 15, 10, 0, 0, "Europe/London")).toBe("2026-01-15T10:00:00Z");
    expect(localToUtc(2026, 7, 15, 10, 0, 0, "Europe/London")).toBe("2026-07-15T09:00:00Z");
  });
  it("is correct right after a clock change (US spring-forward 2026-03-08)", () => {
    expect(localToUtc(2026, 3, 8, 3, 30, 0, "America/New_York")).toBe("2026-03-08T07:30:00Z"); // EDT, UTC-4
    expect(localToUtc(2026, 3, 8, 1, 30, 0, "America/New_York")).toBe("2026-03-08T06:30:00Z"); // still EST, UTC-5
  });
  it("does not throw on a local time that does not exist (inside the spring-forward gap)", () => {
    expect(localToUtc(2026, 3, 8, 2, 30, 0, "America/New_York")).toMatch(/^2026-03-08T0[67]:30:00Z$/);
  });
  it("crosses midnight and month boundaries correctly", () => {
    expect(localToUtc(2026, 12, 1, 1, 0, 0, "Asia/Kolkata")).toBe("2026-11-30T19:30:00Z");
  });
});

describe("resolveStart", () => {
  it("passes UTC times through", () => {
    expect(resolveStart("20261120T100000Z", undefined)).toEqual({ iso: "2026-11-20T10:00:00Z" });
  });
  it("accepts IANA ids and Windows names, including 'UTC'", () => {
    expect(resolveStart("20261120T100000", "Europe/Berlin")).toEqual({ iso: "2026-11-20T09:00:00Z" });
    expect(resolveStart("20261120T153000", "India Standard Time")).toEqual({ iso: "2026-11-20T10:00:00Z" });
    expect(resolveStart("20261120T090000", "W. Europe Standard Time")).toEqual({ iso: "2026-11-20T08:00:00Z" });
    expect(resolveStart("20260701T100000", "Eastern Standard Time")).toEqual({ iso: "2026-07-01T14:00:00Z" });
    expect(resolveStart("20261120T100000", "UTC")).toEqual({ iso: "2026-11-20T10:00:00Z" });
  });
  it("refuses, with a reason, when it cannot be sure", () => {
    expect(resolveStart("20261120T153000", undefined)).toEqual({ issue: "floating_time" });
    expect(resolveStart("20261120T153000", "Mars Standard Time")).toEqual({ issue: "unknown_timezone:Mars Standard Time" });
    expect(resolveStart("20261120", undefined)).toEqual({ issue: "date_only" });
    expect(resolveStart("garbage", "India Standard Time")).toEqual({ issue: "unrecognised_format" });
  });
  it("uses a fixed offset from the invite's own zone definition as a last resort", () => {
    expect(resolveStart("20261120T153000", "Custom Zone", 330)).toEqual({ iso: "2026-11-20T10:00:00Z" });
    expect(resolveStart("20261120T100000", "Custom Zone", -300)).toEqual({ iso: "2026-11-20T15:00:00Z" });
  });
  it("truncates absurdly long zone names in the issue text", () => {
    expect(resolveStart("20261120T153000", "X".repeat(500)).issue!.length).toBeLessThan(80);
  });
});

describe("parseUtcOffset", () => {
  it("reads +HHMM / -HHMM / +HHMMSS", () => {
    expect(parseUtcOffset("+0530")).toBe(330);
    expect(parseUtcOffset("-0800")).toBe(-480);
    expect(parseUtcOffset("+053000")).toBe(330);
    expect(parseUtcOffset("nope")).toBeUndefined();
  });
});

describe("Windows zone table", () => {
  it("every generated entry maps to an IANA id this runtime understands", () => {
    const entries = Object.entries(WINDOWS_TO_IANA);
    expect(entries.length).toBeGreaterThan(100);
    const bad = entries.filter(([, iana]) => !isIanaZone(iana)).map(([w]) => w);
    expect(bad).toEqual([]);
  });
});

describe("parseIcs with real-world invite shapes", () => {
  const outlook = (dtstart: string, vtimezone = "") =>
    ["BEGIN:VCALENDAR", "METHOD:REQUEST", vtimezone, "BEGIN:VEVENT", "UID:abc", dtstart, "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");

  it("quoted TZID", () => {
    expect(parseIcs(outlook('DTSTART;TZID="India Standard Time":20261120T153000')).startsAt).toBe("2026-11-20T10:00:00Z");
  });
  it("unquoted TZID with extra parameters before it", () => {
    expect(parseIcs(outlook("DTSTART;VALUE=DATE-TIME;TZID=Pacific Standard Time:20261120T080000")).startsAt).toBe("2026-11-20T16:00:00Z");
  });
  it("custom zone name resolved from the invite's own VTIMEZONE when it has no daylight rule", () => {
    const vtz = ["BEGIN:VTIMEZONE", "TZID:Custom Office Zone", "BEGIN:STANDARD", "DTSTART:16010101T000000", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
    expect(parseIcs(outlook("DTSTART;TZID=Custom Office Zone:20261120T153000", vtz)).startsAt).toBe("2026-11-20T10:00:00Z");
  });
  it("does NOT trust a custom zone whose VTIMEZONE has daylight saving (cannot evaluate its rules)", () => {
    const vtz = ["BEGIN:VTIMEZONE", "TZID:Custom DST Zone", "BEGIN:STANDARD", "TZOFFSETTO:-0500", "END:STANDARD", "BEGIN:DAYLIGHT", "TZOFFSETTO:-0400", "END:DAYLIGHT", "END:VTIMEZONE"].join("\r\n");
    const r = parseIcs(outlook("DTSTART;TZID=Custom DST Zone:20261120T100000", vtz));
    expect(r.startsAt).toBeUndefined();
    expect(r.startIssue).toBe("unknown_timezone:Custom DST Zone");
  });
  it("reports floating times and all-day events instead of guessing", () => {
    expect(parseIcs(outlook("DTSTART:20261120T153000")).startIssue).toBe("floating_time");
    expect(parseIcs(outlook("DTSTART;VALUE=DATE:20261120")).startIssue).toBe("date_only");
  });
  it("uses the first DTSTART only (a recurring series may repeat the line)", () => {
    const ics = ["BEGIN:VEVENT", "DTSTART;TZID=India Standard Time:20261120T153000", "DTSTART;TZID=India Standard Time:20261127T153000", "END:VEVENT"].join("\r\n");
    expect(parseIcs(ics).startsAt).toBe("2026-11-20T10:00:00Z");
  });
});

describe("parseInvite carries the start and the reason", () => {
  const email = (dtstart: string) => ({
    messageId: "m",
    from: "a@b.c",
    to: "iv-k7m2qx9wpb@invite.askproso.ai",
    subject: "Interview",
    body: "https://meet.google.com/abc-defg-hij",
    attachments: [{ name: "invite.ics", contentBytes: Buffer.from(`BEGIN:VEVENT\r\nUID:u\r\n${dtstart}\r\nEND:VEVENT`).toString("base64") }],
  });
  it("start resolved", () => {
    const p = parseInvite(email("DTSTART;TZID=India Standard Time:20261120T153000"), "invite.askproso.ai");
    expect(p.startsAt).toBe("2026-11-20T10:00:00Z");
    expect(p.startIssue).toBeUndefined();
  });
  it("start not resolved: no time, with the reason", () => {
    const p = parseInvite(email("DTSTART;TZID=Mars Standard Time:20261120T153000"), "invite.askproso.ai");
    expect(p.startsAt).toBeUndefined();
    expect(p.startIssue).toBe("unknown_timezone:Mars Standard Time");
  });
});
