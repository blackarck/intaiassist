# AI Interview Assist

An AI assistant for interviewers. A bot joins the interview video call (Microsoft Teams, Zoom or Google Meet), listens,
and privately coaches the interviewer in a web app: a **live transcript**, a **score for every answer** (correctness, depth,
clarity, relevance, with the weak phrases quoted and a better answer suggested), and **follow-up questions to ask next**.
The assistant never speaks in the meeting, and only the interviewer sees the coaching.

Meeting access and live transcription come from [Recall.ai](https://docs.recall.ai). AI analysis uses Anthropic Claude and
Azure OpenAI models. This repo contains the backend that schedules the bot, receives the transcript and runs the AI, plus the
web app interviewers use.

> **Consent matters.** A visible bot joins and the meeting is recorded and transcribed. Whoever runs this must tell every
> participant and get their permission first, and comply with the recording and privacy laws that apply to them. Data is
> processed by Recall.ai and your AI providers, and stored in your own database. You run it at your own risk; see the in-app
> Terms and Privacy pages (`web/src/pages/Legal.tsx`) and adapt them to your situation.

Docs: [plan](doc/plan.md) · [hosting & DNS](doc/hosting.md) · [inbound e-mail](doc/inbound-email.md) · [Recall integration](doc/recall-integration.md) · [data & backups](doc/data.md) · [end-to-end flow](doc/flow.md) ·
[why not our own Teams bot](doc/bot-join-research.md).

## What you need

| Need | Why | Required? |
|---|---|---|
| Node.js 24 and npm (what the Docker image uses) | Run the backend and web app | Yes |
| [Recall.ai](https://www.recall.ai) account and API key | Bot that joins meetings and streams the transcript | For real meetings (not for local dev) |
| Anthropic API key and/or Azure OpenAI resource | The AI that scores answers and suggests questions | For coaching |
| Microsoft Entra app registration | "Sign in with Microsoft" | For real sign-in (not for local dev) |
| A public HTTPS URL for the backend | Recall and SendGrid deliver webhooks to it (a tunnel such as ngrok works for testing) | For real meetings |
| SendGrid account + a subdomain | Optional: lets people invite the bot by e-mail (`iv-<alias>@your-subdomain`) | Optional |
| Stripe account | Optional "support us" payment | Optional |
| A Linux VM with Docker | Production hosting (Caddy gives automatic HTTPS) | For production |

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
| `backend/` | TypeScript (Fastify). Inbound invite e-mail, Recall client, bot scheduling, webhook receiver, live AI coaching and scoring, SQLite persistence | Tested; verified live end to end |
| `web/` | React + Vite single-page app: Microsoft sign-in, interview setup, live transcript, scores and suggested questions | Built |
| `deploy/` | Docker Compose: backend + Caddy (automatic HTTPS), nightly DB backup | Used in production |
| `infra/sendgrid/` | Script to create the SendGrid Inbound Parse host | Written |
| `infra/azure/` | `provision.sh`: resource group + Key Vault | Used |
| `teams-app/` | Optional Teams chat app for private coaching messages (chat only) | Manifest packs, **not sideloaded** |
| `doc/` | Plan, flow, Recall integration guide, research history | |

Tag `teams-media-bot-spike` holds the earlier own-Teams-media-bot attempt (it could join meetings but Microsoft does
not allow link-joined bots to record or transcribe).

## Quick start (local, no accounts needed)

Local dev mode skips Microsoft sign-in and never creates a real bot, so you can run the whole app on your machine.

```bash
git clone https://github.com/blackarck/intaiassist.git && cd intaiassist

# 1. backend (http://localhost:3000)
cd backend
npm install
cp .env.example .env            # git-ignored; set INTAKE_TOKEN to any long random string
DEV_AUTH=1 RECALL_API_KEY= ALLOWED_ORIGINS=http://localhost:5173 npm run dev

# 2. web app (http://localhost:5173), in a second terminal
cd web
npm install
cp .env.example .env.local
# in .env.local set: VITE_API_URL=http://localhost:3000   VITE_DEV_USER=you@example.test
npm run dev
```

Open http://localhost:5173. To play a fake meeting without Recall, see "Local development" in [web/README.md](web/README.md).
Add `ANTHROPIC_API_KEY` (and/or the `AZURE_OPENAI_*` pair) to `backend/.env` to get real AI scoring. `DEV_AUTH=1` is refused when
`NODE_ENV=production`, and `VITE_DEV_USER` must never be set in a deployed build.

## Configuration

Backend settings live in `backend/.env` (see [backend/.env.example](backend/.env.example) for the full, commented list). The main ones:

| Variable | Purpose |
|---|---|
| `INTAKE_TOKEN` | Operator bearer token for admin/dev API calls. Long random string. |
| `MS_CLIENT_ID` | Entra app (client) id for sign-in. Same value as the web build's `VITE_MS_CLIENT_ID`. |
| `ALLOWED_ORIGINS` | Web app origin(s) allowed to call the API (CORS), e.g. `https://app.example.com`. |
| `RECALL_API_KEY`, `RECALL_REGION`, `RECALL_WEBHOOK_SECRET` | Recall.ai credentials, region and webhook verification secret. |
| `PUBLIC_BASE_URL` | Public https URL of the backend; Recall posts transcripts to `<PUBLIC_BASE_URL>/webhooks/recall`. |
| `ANTHROPIC_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` | AI providers. Model choice per task is in `backend/src/ai/`. |
| `ALIAS_DOMAIN`, `INBOUND_TOKEN` | Optional: SendGrid Inbound Parse for e-mail invites. |
| `ADMIN_SUBJECTS` | Comma-separated user ids who may change AI settings (get yours from `GET /api/me` after signing in). |
| `DATABASE_PATH` | SQLite file. Unset means in-memory (lost on restart). |
| `STRIPE_SECRET_KEY`, `WEB_BASE_URL` | Optional support payment. Leave blank to turn it off. |

Web settings are build-time variables in `web/.env.local` (see [web/.env.example](web/.env.example)): `VITE_API_URL`,
`VITE_MS_CLIENT_ID`, `VITE_MS_AUTHORITY`.

### Microsoft sign-in (Entra)

1. In Entra ID create an app registration with account type **any organizational directory and personal Microsoft accounts**
   (multi-tenant), so interviewers from any company can sign in.
2. Add platform **Single-page application** with redirect URIs `http://localhost:5173/redirect.html` and
   `https://<your-web-domain>/redirect.html`.
3. Set the client id as `MS_CLIENT_ID` (backend) and `VITE_MS_CLIENT_ID` (web), with
   `VITE_MS_AUTHORITY=https://login.microsoftonline.com/common`.

More detail in [web/README.md](web/README.md).

## Deploying to your own environment

Production is one Linux VM running Docker Compose: **Caddy** (HTTPS, serves the built web app) and the **backend**
(SQLite on a Docker volume). Outline:

1. Create a VM with Docker and point DNS for your API domain and web domain at it.
2. Put the backend settings above into `/opt/intassist/.env`, plus `DOMAIN` (API host) and `WEB_DOMAIN` (web host).
3. Build the web app (`cd web && VITE_API_URL=https://<api-domain> VITE_MS_CLIENT_ID=<id> VITE_MS_AUTHORITY=https://login.microsoftonline.com/common npm run build`)
   and copy `web/dist` to `/opt/intassist/web`.
4. From `deploy/`: `docker compose --env-file /opt/intassist/.env up -d --build`.
5. In Recall, point the webhook at `https://<api-domain>/webhooks/recall`. Optionally run `infra/sendgrid/` for e-mail invites.

The scripts in `infra/azure/` automate this on Azure (VM, Key Vault for secrets, deploy); they contain our own resource names,
so treat them as a worked example and change the names. Full walk-through in [doc/hosting.md](doc/hosting.md). Do not deploy
or restart during live interviews: a restart drops in-flight webhooks for a few seconds.

## Backend only: try the intake flow

Without `RECALL_API_KEY` the backend uses a log-only bot controller. With `DEV_AUTH=1` you can exercise intake with curl:

```bash
curl -X POST localhost:3000/api/dev/interviews -H "authorization: Bearer $INTAKE_TOKEN" -H 'content-type: application/json' \
  -d '{"alias":"7KQ2","ownerEmail":"you@example.com"}'
curl -X POST localhost:3000/api/intake/link -H "authorization: Bearer $INTAKE_TOKEN" -H 'content-type: application/json' \
  -d '{"alias":"7KQ2","link":"https://meet.google.com/abc-defg-hij"}'
```

Recall can only deliver webhooks to a public HTTPS URL, so a real end-to-end test needs the backend hosted or tunnelled
(see [doc/recall-integration.md](doc/recall-integration.md)).

### Optional support payment (Stripe)

People can optionally pay $5, $7 or $10; nothing is gated on it. To turn it on, put your keys in `backend/.env` (git-ignored):

```
STRIPE_SECRET_KEY=sk_test_...        # https://dashboard.stripe.com/apikeys
WEB_BASE_URL=http://localhost:5173   # where Stripe sends people back
```

Leave `STRIPE_SECRET_KEY` empty and the web app shows no payment option. The backend creates a Stripe Checkout session
(`POST /api/me/support/checkout`); amounts are fixed in `backend/src/support.ts`. For the Azure deploy, store the key as the
Key Vault secret `stripe-secret-key`. Payments are not tracked in the database: the Stripe dashboard is the record.

## Tests

```bash
cd backend && npm test && npm run typecheck
cd web && npm test && npm run typecheck
```

## License

[Apache License 2.0](LICENSE): free to use, modify and distribute, including commercially.
