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

### 1. DNS (registrar, `askproso.ai`)
Enter only the host part (see [hosting.md](hosting.md)).

| Host | Type | Value | Notes |
|---|---|---|---|
| `invite` | MX, priority **10** | `mx.sendgrid.net` | The only mail record for this subdomain. SendGrid's advice: use a hostname that serves no other purpose, and do not change this record once created. Do **not** touch the root domain's MX/SPF |
| the 3 records SendGrid shows | CNAME | as shown | From step 2 |

### 2. SendGrid dashboard
1. **Confirm your plan includes Inbound Parse** (I have not verified this).
2. **Settings > Sender Authentication > Authenticate Your Domain**: choose your DNS host, domain `askproso.ai`, and add the three
   CNAME records it shows at your registrar, then click Verify. This is needed for sending e-mail, and SendGrid's API docs say
   the Inbound Parse hostname "must be a domain already authenticated on your account". These CNAMEs do not replace or change
   your existing root SPF record.
3. **Settings > API Keys > Create**: a restricted key with the **Inbound Parse** permission (and **Mail Send**, for later).
   Store it in Key Vault yourself; do not paste it anywhere:
   ```bash
   az keyvault secret set --vault-name vaiintassist-kv-f9ea --name sendgrid-api-key --value '<paste the key here>'
   ```
4. **Create the Inbound Parse host.** Either run `infra/sendgrid/configure-inbound-parse.sh` (it reads both secrets from
   Key Vault; written from SendGrid's API reference, not yet run against a live account), or by hand:
   **Settings > Inbound Parse > Add Host & URL**
   - Receiving domain: `invite.askproso.ai`
   - Destination URL: `https://intassistback.askproso.ai/inbound/sendgrid/<inbound-token>`
     (the token is Key Vault secret `inbound-token`: `az keyvault secret show --vault-name vaiintassist-kv-f9ea --name inbound-token --query value -o tsv`)
   - **Tick "POST the raw, full MIME message".** Without it the backend cannot read the calendar part and answers
     `raw_mime_required` (and logs a warning).
   - Spam check: off.

### 3. Test
1. Create an interview: `curl -X POST https://intassistback.askproso.ai/api/interviews -H "authorization: Bearer $INTAKE_TOKEN" -H 'content-type: application/json' -d '{"ownerEmail":"you@yourcompany.com"}'` returns `address`.
2. From your own Outlook or Google Calendar, create a meeting with a Teams/Meet/Zoom link and add `address` plus a second person.
3. The backend answers `scheduled`, and a bot appears in Recall for that meeting (the Recall MCP tools or dashboard show it).

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
