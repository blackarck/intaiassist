import { createHash } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";
import type { InviteAttachment, InviteEmail } from "./invite.js";

/**
 * SendGrid Inbound Parse -> InviteEmail.
 *
 * SendGrid is configured to "POST the raw, full MIME message", so the multipart form carries these text fields:
 *   email     the complete raw message (headers, bodies, calendar part)
 *   envelope  JSON {"to":[...],"from":"..."}: the REAL recipients, which matters because the alias address is often
 *             in BCC, or a forwarded copy, and then does not appear in the To/Cc headers at all
 *   dkim      e.g. "{@acme.com : pass}"
 *   SPF       "pass" | "fail" | "softfail" | "neutral" | "none" ...
 *   to, from, subject, sender_ip, spam_score, charsets
 * Source: Twilio SendGrid docs, "Setting up the Inbound Parse Webhook".
 *
 * Message content is UNTRUSTED. Nothing here is logged, because invites contain names and meeting links.
 */

export interface ParsedInbound {
  invite: InviteEmail;
  /** The sender's domain passed SPF or DKIM, i.e. the From address was not trivially forged. */
  senderAuthenticated: boolean;
}

type Fields = Record<string, string | undefined>;

/** True when SendGrid reports SPF "pass" or at least one DKIM signature that passed. */
export function senderAuthenticated(spf: string | undefined, dkim: string | undefined): boolean {
  if ((spf ?? "").trim().toLowerCase() === "pass") return true;
  // dkim looks like "{@gmail.com : pass, @acme.com : fail}"; require ": pass" so a domain named pass.com cannot match
  return /:\s*pass\b/i.test(dkim ?? "");
}

function addressesOf(a: AddressObject | AddressObject[] | undefined): string[] {
  const list = a === undefined ? [] : Array.isArray(a) ? a : [a];
  return list.flatMap((x) => x.value.map((v) => v.address).filter((v): v is string => !!v));
}

function envelopeRecipients(envelope: string | undefined): string[] {
  if (!envelope) return [];
  try {
    const parsed = JSON.parse(envelope) as { to?: unknown };
    return Array.isArray(parsed.to) ? parsed.to.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const MAX_ICS_BYTES = 1024 * 1024;

/** Returns undefined when the raw message is missing, which means Inbound Parse is not set to raw MIME mode. */
export async function parseSendGridInbound(fields: Fields): Promise<ParsedInbound | undefined> {
  const raw = fields.email;
  if (!raw) return undefined;

  const mail = await simpleParser(raw);

  const recipients = [...addressesOf(mail.to), ...envelopeRecipients(fields.envelope)];
  const unique = [...new Set(recipients.map((r) => r.toLowerCase()))];

  // Only calendar parts are carried forward (their bytes are what we parse); other attachments are dropped.
  const attachments: InviteAttachment[] = mail.attachments
    .filter((a) => /calendar|ics/i.test(a.contentType) || /\.ics$/i.test(a.filename ?? ""))
    .filter((a) => a.content.length <= MAX_ICS_BYTES)
    .map((a) => ({
      name: a.filename ?? "invite.ics",
      contentType: a.contentType,
      contentBytes: a.content.toString("base64"),
    }));

  const html = typeof mail.html === "string" ? mail.html : "";

  return {
    senderAuthenticated: senderAuthenticated(fields.SPF, fields.dkim),
    invite: {
      messageId: mail.messageId ?? `sg-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`,
      from: mail.from?.text ?? fields.from ?? "",
      to: unique.join("; "),
      cc: addressesOf(mail.cc).join("; "),
      subject: mail.subject ?? fields.subject ?? "",
      // both bodies: some clients put the link only in the HTML part, some only in the text part
      body: `${html}\n${mail.text ?? ""}`,
      attachments,
    },
  };
}
