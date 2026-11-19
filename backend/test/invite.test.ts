import { describe, expect, it } from "vitest";
import { extractAliasTags, extractMeetingLink, parseIcs, parseInvite, splitAddresses } from "../src/invite.js";

const TEAMS =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d";
const ZOOM = "https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123";
const MEET = "https://meet.google.com/abc-defg-hij";

describe("extractMeetingLink", () => {
  it("finds a plain Teams join link in HTML", () => {
    const html = `<p>Join: <a href="${TEAMS.replace(/&/g, "&amp;")}">Join the meeting now</a></p>`;
    expect(extractMeetingLink(html)).toEqual({ url: TEAMS, platform: "teams" });
  });

  it("finds the short /meet/<id>?p= Teams format", () => {
    const url = "https://teams.microsoft.com/meet/123456789012?p=AbCdEf123";
    expect(extractMeetingLink(`Meeting link: ${url}`)).toEqual({ url, platform: "teams" });
  });

  it("finds Zoom and Google Meet links", () => {
    expect(extractMeetingLink(`Join Zoom Meeting ${ZOOM} Meeting ID: 812 3456 7890`)).toEqual({ url: ZOOM, platform: "zoom" });
    expect(extractMeetingLink(`<a href="${MEET}">Join with Google Meet</a>`)).toEqual({ url: MEET, platform: "meet" });
  });

  it("takes the first valid meeting link when an invite has several URLs", () => {
    const body = `Agenda https://example.com/doc and calendar https://calendar.google.com/x then ${MEET} and ${ZOOM}`;
    expect(extractMeetingLink(body)?.platform).toBe("meet");
  });

  it("unwraps Defender Safe Links", () => {
    const safe =
      "https://nam12.safelinks.protection.outlook.com/?url=" +
      encodeURIComponent(TEAMS) +
      "&amp;data=05%7C02&amp;reserved=0";
    expect(extractMeetingLink(`<a href="${safe}">Join</a>`)).toEqual({ url: TEAMS, platform: "teams" });
  });

  it("rejects look-alike hosts and wrong paths", () => {
    expect(extractMeetingLink("https://evil.example.com/l/meetup-join/xyz")).toBeUndefined();
    expect(extractMeetingLink("https://teams.microsoft.com.evil.io/meet/123?p=a")).toBeUndefined();
    expect(extractMeetingLink("https://zoom.us.evil.io/j/81234567890")).toBeUndefined();
    expect(extractMeetingLink("https://notzoom.us/j/81234567890")).toBeUndefined();
    expect(extractMeetingLink("https://meet.google.com/landing")).toBeUndefined();
    expect(extractMeetingLink("https://zoom.us/signin")).toBeUndefined();
    expect(extractMeetingLink("http://zoom.us/j/81234567890")).toBeUndefined(); // not https
    expect(extractMeetingLink("https://zoom.us:8443/j/81234567890")).toBeUndefined(); // odd port
  });

  it("returns undefined when there is no link", () => {
    expect(extractMeetingLink("hello")).toBeUndefined();
  });
});

describe("addresses and aliases", () => {
  it("splits connector-style recipient strings", () => {
    expect(splitAddresses("Bob <Bob@x.com>; iv-7kq2@bot.test;")).toEqual(["bob@x.com", "iv-7kq2@bot.test"]);
  });

  it("extracts proxy-alias and plus-address tags only for our domain", () => {
    const tags = extractAliasTags(
      ["iv-7kq2@bot.test", "assistant+ab12cd@bot.test", "iv-zzzz@other.com", "bob@bot.test"],
      "bot.test",
    );
    expect(tags.sort()).toEqual(["7KQ2", "AB12CD"]);
  });
});

describe("parseIcs", () => {
  it("reads method, uid and UTC start", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:040000008200E00074C5B7101A82E008",
      "DTSTART:20261120T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(ics)).toEqual({
      method: "REQUEST",
      uid: "040000008200E00074C5B7101A82E008",
      startsAt: "2026-11-20T10:00:00Z",
    });
  });

  it("does not guess a start time for TZID-based DTSTART", () => {
    const ics = "BEGIN:VEVENT\nUID:u1\nDTSTART;TZID=India Standard Time:20261120T153000\nEND:VEVENT";
    expect(parseIcs(ics).startsAt).toBeUndefined();
    expect(parseIcs(ics).uid).toBe("u1");
  });
});

describe("parseInvite", () => {
  const base = {
    messageId: "m1",
    from: "recruiter@acme.com",
    to: "candidate@gmail.com; iv-7kq2@bot.test",
    subject: "Interview: Backend Engineer",
    body: `<a href="${TEAMS}">Join</a>`,
  };

  it("parses a request", () => {
    const p = parseInvite(base, "bot.test");
    expect(p.method).toBe("request");
    expect(p.aliasTags).toEqual(["7KQ2"]);
    expect(p.meeting).toEqual({ url: TEAMS, platform: "teams" });
  });

  it("detects the platform for a Zoom invite", () => {
    expect(parseInvite({ ...base, body: `Join Zoom Meeting ${ZOOM}` }, "bot.test").meeting?.platform).toBe("zoom");
  });

  it("detects cancellation from ICS METHOD", () => {
    const ics = Buffer.from("BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:u9\nEND:VEVENT").toString("base64");
    const p = parseInvite({ ...base, attachments: [{ name: "invite.ics", contentBytes: ics }] }, "bot.test");
    expect(p.method).toBe("cancel");
    expect(p.icalUid).toBe("u9");
  });

  it("detects cancellation from subject", () => {
    expect(parseInvite({ ...base, subject: "Canceled: Interview" }, "bot.test").method).toBe("cancel");
  });
});
