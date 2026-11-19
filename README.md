# AI Interview Assist

A bot joins the interviewer's video call (Teams, Zoom or Google Meet), listens, and coaches the interviewer
privately. Meeting access and live transcription come from [Recall.ai](https://docs.recall.ai); this repo is the
backend that schedules the bot, receives the live transcript, and (next) turns it into coaching.

Docs: [plan](doc/plan.md) · [hosting & DNS](doc/hosting.md) · [inbound e-mail](doc/inbound-email.md) · [Recall integration](doc/recall-integration.md) · [data & backups](doc/data.md) · [end-to-end flow](doc/flow.md) ·
[why not our own Teams bot](doc/bot-join-research.md).

## How it works

```
interviewer adds iv-K7M2QX9WPB@invite.askproso.ai to the meeting invite
        │  (no mailbox: the subdomain's MX record points at SendGrid)
SendGrid Inbound Parse ──POST──►  backend /inbound/sendgrid/<secret>
                      │  parse link (Teams/Zoom/Meet) + calendar data, match alias → paid interview
                      ▼
                 Recall: create bot (scheduled for the start time, or immediate)
                      │
 meeting ◄──joins──  Recall bot ──live transcript + status──►  backend /webhooks/recall  (HMAC-verified)
                                                                   │
                                                                   ▼
                                                    status tracking, transcript segments → coaching (next)
```

## Layout

| Path | What | State |
|---|---|---|
| `backend/` | TypeScript (Fastify). Inbound invite e-mail, Recall client, bot scheduling, webhook receiver, SQLite persistence | **124 tests pass**; not yet run against live Recall or SendGrid |
| `deploy/` | Docker Compose: backend + Caddy (automatic HTTPS), nightly DB backup | Written, **first deploy pending DNS** |
| `infra/sendgrid/` | Script to create the SendGrid Inbound Parse host | Written, **not run** |
| `infra/azure/` | `provision.sh`: resource group + Key Vault | Used |
| `teams-app/` | Optional Teams chat app for private coaching messages (chat only) | Manifest packs, **not sideloaded** |
| `doc/` | Plan, flow, Recall integration guide, research history | |

Tag `teams-media-bot-spike` holds the earlier own-Teams-media-bot attempt (it could join meetings but Microsoft does
not allow link-joined bots to record or transcribe).

## Run it locally

```bash
cd backend && npm install
cp .env.example .env        # then fill it in; .env is git-ignored
npm start                   # loads .env automatically
```

Without `RECALL_API_KEY` the backend runs with a log-only bot controller (no meeting is joined), which is enough to
exercise the intake flow:

```bash
curl -X POST localhost:3000/api/dev/interviews -H "authorization: Bearer $INTAKE_TOKEN" -H 'content-type: application/json' \
  -d '{"alias":"7KQ2","ownerEmail":"you@example.com"}'
curl -X POST localhost:3000/api/intake/link -H "authorization: Bearer $INTAKE_TOKEN" -H 'content-type: application/json' \
  -d '{"alias":"7KQ2","link":"https://meet.google.com/abc-defg-hij"}'
```

Recall can only deliver webhooks to a public HTTPS URL, so a real end-to-end test needs the backend hosted or tunnelled
(see [doc/recall-integration.md](doc/recall-integration.md)).

Tests: `cd backend && npm test` (and `npm run typecheck`).

## Not built yet

Payment/portal, a cloud database (SQLite for now, see doc/data.md), coaching (turn detection → scoring → follow-up questions), the
Teams coaching chat, hosting/deployment, and Entra-based auth on `/api/*` (a shared bearer token is used for now).
