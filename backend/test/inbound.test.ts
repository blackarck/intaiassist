import { describe, expect, it } from "vitest";
import { aliasAddress, generateAlias } from "../src/alias.js";
import { parseSendGridInbound, senderAuthenticated } from "../src/inbound.js";
import { parseInvite } from "../src/invite.js";
import { fixtureEmail, sendgridFields } from "./helpers.js";

const ALIAS_DOMAIN = "invite.askproso.ai";

describe("senderAuthenticated", () => {
  it("accepts SPF pass or any passing DKIM signature", () => {
    expect(senderAuthenticated("pass", undefined)).toBe(true);
    expect(senderAuthenticated("PASS ", "")).toBe(true);
    expect(senderAuthenticated("fail", "{@acme.com : pass}")).toBe(true);
    expect(senderAuthenticated("none", "{@gmail.com : pass, @acme.com : fail}")).toBe(true);
  });
  it("rejects failures, missing data, and look-alikes", () => {
    expect(senderAuthenticated("fail", "{@acme.com : fail}")).toBe(false);
    expect(senderAuthenticated("softfail", undefined)).toBe(false);
    expect(senderAuthenticated(undefined, undefined)).toBe(false);
    expect(senderAuthenticated("none", "{@pass.com : fail}")).toBe(false); // a domain called pass.com must not match
    expect(senderAuthenticated("neutral", "")).toBe(false);
  });
});

describe("parseSendGridInbound", () => {
  it("parses an Outlook invite: alias in To, calendar as an inline part, Safe Links unwrapped", async () => {
    const parsed = await parseSendGridInbound(sendgridFields(fixtureEmail("outlook-invite"), []));
    expect(parsed?.senderAuthenticated).toBe(true);
    expect(parsed?.invite).toMatchObject({ messageId: "<outlook-1@acme.com>", subject: "Interview: Backend Engineer" });
    expect(parsed?.invite.from).toContain("recruiter@acme.com");
    expect(parsed?.invite.attachments?.map((a) => a.contentType)).toEqual(["text/calendar"]);

    const p = parseInvite(parsed!.invite, ALIAS_DOMAIN);
    expect(p.aliasTags).toEqual(["K7M2QX9WPB"]);
    expect(p.method).toBe("request");
    expect(p.meeting).toEqual({
      url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d",
      platform: "teams",
    });
    expect(p.icalUid).toBe("040000008200E00074C5B7101A82E00800000000OUTLOOK1");
    expect(p.startsAt).toBe("2026-11-20T10:00:00Z");
  });

  it("reads the start time of an Outlook invite that has a time-zone block BEFORE the event (regression: placeholder DTSTART lines)", async () => {
    const parsed = await parseSendGridInbound(sendgridFields(fixtureEmail("outlook-invite-ist"), []));
    const p = parseInvite(parsed!.invite, ALIAS_DOMAIN);
    expect(p.startsAt).toBe("2026-11-20T10:00:00Z"); // 15:30 India Standard Time
    expect(p.startIssue).toBeUndefined();
    expect(p.icalUid).toBe("040000008200E00074C5B7101A82E00800000000IST1");
    expect(p.method).toBe("request");
    expect(p.meeting).toEqual({ url: "https://teams.microsoft.com/meet/442518337057043?p=LRX8m2NJcnaYmS13bV", platform: "teams" });
  });

  it("finds the alias in the ENVELOPE when it is not in To/Cc (BCC, forwarded copy)", async () => {
    const parsed = await parseSendGridInbound(sendgridFields(fixtureEmail("google-invite"), ["iv-k7m2qx9wpb@invite.askproso.ai"]));
    const p = parseInvite(parsed!.invite, ALIAS_DOMAIN);
    expect(p.aliasTags).toEqual(["K7M2QX9WPB"]);
    expect(p.meeting).toEqual({ url: "https://meet.google.com/abc-defg-hij", platform: "meet" });
    expect(p.icalUid).toBe("google-uid-1@google.com");
    expect(p.startsAt).toBe("2026-11-20T10:00:00Z");
  });

  it("parses a cancellation as a cancel", async () => {
    const parsed = await parseSendGridInbound(sendgridFields(fixtureEmail("outlook-cancel"), ["iv-k7m2qx9wpb@invite.askproso.ai"]));
    const p = parseInvite(parsed!.invite, ALIAS_DOMAIN);
    expect(p.method).toBe("cancel");
    expect(p.aliasTags).toEqual(["K7M2QX9WPB"]);
    expect(p.icalUid).toBe("040000008200E00074C5B7101A82E00800000000OUTLOOK1");
  });

  it("returns undefined when the raw message is absent (Inbound Parse not in raw mode)", async () => {
    expect(await parseSendGridInbound({ from: "a@b.c", subject: "x", text: "hi" })).toBeUndefined();
    expect(await parseSendGridInbound({ email: "" })).toBeUndefined();
  });

  it("tolerates a malformed envelope and uses only the headers", async () => {
    const parsed = await parseSendGridInbound(sendgridFields(fixtureEmail("outlook-invite"), [], { envelope: "{not json" }));
    expect(parseInvite(parsed!.invite, ALIAS_DOMAIN).aliasTags).toEqual(["K7M2QX9WPB"]);
  });

  it("falls back to a content hash when the message has no Message-ID, and reports unauthenticated senders", async () => {
    const noId = fixtureEmail("outlook-invite").replace(/^Message-ID:.*\r\n/m, "");
    const a = await parseSendGridInbound(sendgridFields(noId, [], { SPF: "fail", dkim: "{@acme.com : fail}" }));
    const b = await parseSendGridInbound(sendgridFields(noId, []));
    expect(a?.invite.messageId).toMatch(/^sg-[0-9a-f]{24}$/);
    expect(a?.invite.messageId).toBe(b?.invite.messageId); // stable, so retries de-duplicate
    expect(a?.senderAuthenticated).toBe(false);
  });

  it("drops non-calendar attachments", async () => {
    const withPdf = fixtureEmail("google-invite").replace(
      "--mixed-g--",
      'Content-Type: application/pdf; name="cv.pdf"\r\nContent-Disposition: attachment; filename="cv.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--mixed-g--',
    );
    const parsed = await parseSendGridInbound(sendgridFields(withPdf, []));
    expect(parsed?.invite.attachments?.map((a) => a.name)).not.toContain("cv.pdf");
    expect(parsed?.invite.attachments?.some((a) => a.name === "invite.ics")).toBe(true);
  });
});

describe("aliases", () => {
  it("are 10 unambiguous characters", () => {
    for (let i = 0; i < 200; i++) expect(generateAlias()).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });
  it("do not repeat (50 bits of randomness)", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateAlias()));
    expect(seen.size).toBe(5000);
  });
  it("are used in lowercase in the address and round-trip through invite parsing", () => {
    const alias = generateAlias();
    const addr = aliasAddress(alias, ALIAS_DOMAIN);
    expect(addr).toBe(`iv-${alias.toLowerCase()}@${ALIAS_DOMAIN}`);
    const p = parseInvite({ messageId: "m", from: "a@b.c", to: `Someone <${addr}>`, subject: "s", body: "" }, ALIAS_DOMAIN);
    expect(p.aliasTags).toEqual([alias]);
  });
});
