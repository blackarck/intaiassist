# Inbound invite e-mail (SendGrid Inbound Parse)

## How it works

1. The portal (for now: `POST /api/interviews`) creates an interview and returns its address, for example
   `iv-k7m2qx9wpb@invite.askproso.ai`. The part between `iv-` and `@` is the **alias**: 10 random characters (50 bits).
2. The interviewer adds that address as an attendee of their Teams / Zoom / Google Meet invite.
3. The mail-routing (MX) record for `invite.askproso.ai` points at SendGrid. SendGrid receives the invite and POSTs it,
   as raw MIME, to `https://intassistback.askproso.ai/inbound/sendgrid/<secret>`.
4. The backend reads the meeting link from the body, the start time and meeting id from the calendar part, and the alias
   from the real recipients (SendGrid's `envelope`, so BCC works). It then creates or reschedules the Recall bot.
   A cancellation e-mail cancels it.

**No mailbox is created anywhere.** SendGrid accepts mail for every address on the subdomain, so there is nothing to
provision per interview and no alias limit. Microsoft 365 is not involved.

## What you need to do by hand, in order

Your domain `askproso.ai` is **already authenticated in SendGrid** (confirmed in DNS: `s1._domainkey` and `s2._domainkey`
point to SendGrid account `u29064459`, and a DMARC record exists). SendGrid requires the Inbound Parse domain to be one of your
authenticated domains, so that prerequisite is met.

### 1. SendGrid: create an API key (optional for now; needed to send e-mail later)

**You do not need an API key to receive invite e-mail.** The Inbound Parse host (step 3, option A) is created by hand in the dashboard.
The key's Inbound Parse permission only lets my optional script do that step for you, and it is not needed at runtime. If you cannot find
that permission, skip it: a key with only **Mail Send** is all the backend will ever use.

1. Sign in at <https://app.sendgrid.com>. In the left menu open **Settings > API Keys**.
2. Click **Create API Key**.
3. **API Key Name:** `intassist-backend`.
4. **API Key Permissions:** choose **Custom Access** (older screens call it "Restricted Access"). Do **not** choose Full Access.
5. In the permission list tick:
   - **Inbound Parse** (optional, only for the script): SendGrid's reference files these under the **Webhook** heading
     (`user.webhooks.parse.settings.create/read/update/delete`), so look under "Webhook" if there is nothing called Inbound Parse. If it is not there, skip it.
   - **Mail Send**: tick **Mail Send** (leave "Scheduled Sends" off). This is for the e-mails we send later.
6. Click **Create & View**. The key is shown **once**. Keep that browser tab open until the next step is done.
7. In a terminal, run `infra/sendgrid/store-api-key.sh`. It asks you to paste the key at a hidden prompt (nothing appears on
   screen or in shell history), asks SendGrid what the key can do and prints YES/NO for each permission we need, and then stores it
   in Key Vault as `sendgrid-api-key`. If you close the tab before storing it, delete that key and create a new one.

### 2. DNS at your registrar: the MX record

Add one MX record for the `invite` subdomain:

| Host | Type | Value | Priority |
|---|---|---|---|
| `invite` | MX | `mx.sendgrid.net` | `10` |

**Careful at Namecheap.** Your DNS is at Namecheap's name servers (`registrar-servers.com`), and the root domain currently has
Namecheap **Email Forwarding**. On *Domain List > Manage > Advanced DNS*, MX records are normally managed in the **Mail Settings**
section, whose options include *Email Forwarding* and *Custom MX*. I could not confirm from Namecheap's own pages whether a
subdomain MX can be added without changing the root domain's mail setup, and picking *Custom MX* may replace the forwarding setup.
So:
- First look at **Add New Record** in *Host Records*: if **MX Record** is offered there, use it (Host `invite`, Value `mx.sendgrid.net`, Priority `10`). Enter only `invite`, not the full name.
- If MX records can only be added through **Mail Settings**, **stop and tell me what you see** before changing it.
- Safety net, in case root mail forwarding is ever disturbed. The root domain's current MX records are
  `10 eforward1.registrar-servers.com`, `10 eforward2.registrar-servers.com`, `10 eforward3.registrar-servers.com`,
  `15 eforward4.registrar-servers.com`, `20 eforward5.registrar-servers.com`, with SPF
  `v=spf1 include:spf.efwd.registrar-servers.com ~all`.

After saving, tell me and I will check both `invite.askproso.ai` and the root domain's MX records.

**What actually happened when this was done (2026-11-19).** At Namecheap the `invite` MX record can only be added by switching *Mail Settings* from
*Email Forwarding* to **Custom MX**. Doing so **removed the root domain's forwarding records**: the five `eforward*` MX records and the SPF TXT record
`v=spf1 include:spf.efwd.registrar-servers.com ~all` (verified with `dig` against Namecheap's name servers). Left intact: both Google site-verification TXT
records, DMARC, the SendGrid DKIM CNAMEs, and our A records. If root-domain forwarding (for example `hello@askproso.ai`) is needed, add these back **in the same
Custom MX list**, next to `invite`:

| Host | Type | Value | Priority |
|---|---|---|---|
| `@` | MX | `eforward1.registrar-servers.com` | 10 |
| `@` | MX | `eforward2.registrar-servers.com` | 10 |
| `@` | MX | `eforward3.registrar-servers.com` | 10 |
| `@` | MX | `eforward4.registrar-servers.com` | 15 |
| `@` | MX | `eforward5.registrar-servers.com` | 20 |

and, in *Host Records*, a TXT record: Host `@`, Value `v=spf1 include:spf.efwd.registrar-servers.com ~all`. Whether Namecheap kept the forwarding *aliases* themselves
after the switch is not verified; test by mailing an existing forwarding address. Sending through SendGrid is unaffected (its DKIM CNAMEs and DMARC are intact).

(New records usually take about 30 minutes.)

### 3. SendGrid: create the Inbound Parse host

**Option A: the dashboard.** Open **Settings > Inbound Parse** (direct link: <https://app.sendgrid.com/settings/parse>), then **Add Host & URL**:
- **Receiving domain / Host name:** subdomain `invite`, and in the domain list choose `askproso.ai` (together: `invite.askproso.ai`).
  Only your authenticated domains appear in that list.
- **Destination URL:** `https://intassistback.askproso.ai/inbound/sendgrid/<inbound-token>`. Get the token with:
  `az keyvault secret show --vault-name <your-key-vault> --name inbound-token --query value -o tsv`
- **Check incoming emails for spam:** leave **off**.
- **POST the raw, full MIME message:** tick **on**. Without it the backend cannot read the calendar part and answers `raw_mime_required`.
- Save. The pair appears in a table; the gear icon on its right edits or removes it.

**Option B: the script** `infra/sendgrid/configure-inbound-parse.sh` does the same through the API using the two Key Vault secrets
(written from SendGrid's API reference; not yet run against a live account).

SendGrid's docs add one warning that does **not** apply to us: if the receiving host were the same name as the domain you authenticated
for sending, messages could loop between its CNAME and MX records. Ours is a different name (`invite.askproso.ai` vs `askproso.ai`).

### 4. Test
1. Create an interview: `curl -X POST https://intassistback.askproso.ai/api/interviews -H "authorization: Bearer $INTAKE_TOKEN" -H 'content-type: application/json' -d '{"ownerEmail":"you@yourcompany.com"}'` returns `address`.
2. From your own Outlook or Google Calendar, create a meeting with a Teams/Meet/Zoom link and add `address` plus a second person.
3. The backend answers `scheduled`, and a bot appears in Recall for that meeting (the Recall MCP tools or dashboard show it).

## Start times and time zones

The bot joins one minute before the meeting start, read from the invite's calendar part. Supported: UTC (`...Z`), local time with an IANA zone
(`TZID=Europe/London`), and local time with a **Windows zone name** (`TZID=India Standard Time`, what Outlook and Exchange send; mapped with
the Unicode CLDR table in `src/windowsZones.ts`), with daylight saving handled. A zone defined only inside the invite is used when it has no daylight-saving rule.
If the start cannot be resolved with confidence (unknown zone name, floating time, all-day event) **no time is guessed**: the bot is created for an immediate join and the log says
`[inbound] scheduled (mode=ad_hoc, start not understood: <reason>)`. An early bot waits in the lobby, which costs bot time, so those reasons are worth fixing when they appear.
The calendar parser reads the start only from inside the event: Outlook puts a time-zone block with placeholder `DTSTART:16010101T000000` lines before it.

## Security

- **The secret in the URL is the only authentication** on that endpoint, because SendGrid does not sign Inbound Parse requests
  (the docs I read say nothing about signing). Keep the URL private. Rotate: change Key Vault `inbound-token`, redeploy, update the SendGrid host URL.
- **Spoofing:** inbound mail is ignored unless SendGrid reports **SPF pass or a passing DKIM signature** (`sender_not_authenticated`).
  Whoever knows an alias could still redirect or cancel that interview from any domain that authenticates, which is why aliases are long and random.
- **Repeated deliveries** are ignored (`duplicate_message`, by Message-ID). If the bot provider is down the request fails with HTTP 500 and the
  message is not marked as seen, so a retry is processed.
- Skipped mail always answers HTTP 200, so SendGrid does not redeliver it forever. Mail content is never logged. Size limit 12 MB.

## Responses and what they mean

| Response | Meaning |
|---|---|
| `scheduled` / `cancelled` | Done |
| `ignored: sender_not_authenticated` | SPF and DKIM both failed or were missing |
| `ignored: raw_mime_required` | Inbound Parse host is not set to raw MIME |
| `ignored: duplicate_message` | Already processed |
| `ignored: no_alias` / `rejected: unknown_alias` | No address on our subdomain among the recipients / alias not in the database |
| `ignored: no_meeting_link` | No Teams, Zoom or Meet link found |
| `rejected: alias_bound_to_other_meeting` | This alias already belongs to a different calendar event |
| `ignored: interview_in_progress` | Bot already joining or in the meeting; changes are ignored |
| HTTP 401 / 503 | Wrong token / `INBOUND_TOKEN` not configured |

## Not verified yet

- Whether the plan includes Inbound Parse, and whether the host really requires an authenticated domain.
- One SendGrid page describes raw mode as a multipart form with an `email` field, another as JSON. The endpoint accepts both.
- SendGrid's retry behaviour for non-2xx answers is not described in the pages I read.
- The configuration script has not been run against a live account.

## If you cannot find Inbound Parse in the dashboard

SendGrid's current docs still place it at **Settings > Inbound Parse** (direct link: <https://app.sendgrid.com/settings/parse>), and nothing I found says it moved.
Try, in this order:
1. **Open the direct link while signed in.** Page with an *Add Host & URL* button: you are fine, the menu entry is just hidden or renamed. Error, redirect, or an upgrade message: continue below.
2. **Your role.** Settings pages are limited for non-admin teammates. Check **Settings > Teammates** that you are the account **Admin**.
3. **Your plan.** SendGrid ended its permanent free plan (it now offers a 60-day trial, then paid tiers), and the sources I found disagree on whether Inbound Parse is on every tier;
   I could not read SendGrid's own feature table. Check **Settings > Account Details** for your plan, and SendGrid's pricing page for the *Inbound Parse Webhook* row.
4. **Contact SendGrid support** with the direct link and what you see.

Things that make a configured host silently not deliver (from SendGrid's troubleshooting article): extra MX records on the host (`mx.sendgrid.net` must be the **only** MX for it);
mail sent to the parent domain instead of the host; local parts like `unsubscribe`, `postmaster`, `abuse`, `admin` (our `iv-...` addresses are fine).

**If Inbound Parse turns out not to be available on your plan,** the alternatives are (a) another inbound-mail service that posts to a URL (Mailgun Routes, Postmark Inbound),
(b) AWS SES inbound, or (c) our own small SMTP receiver on the VM: no third party and no plan question, and it can refuse any recipient that is not a known alias at the SMTP stage,
but it means running a public mail port and verifying SPF/DKIM ourselves. The backend's parsing and security checks would be reused as they are.
