# Recall.ai integration

Source: [docs.recall.ai](https://docs.recall.ai). Code: `backend/src/recall.ts`, `botController.ts`, `recallWebhook.ts`.

## What we use

| Need | Recall feature | Where in code |
|---|---|---|
| Bot joins a meeting by link (Teams, Zoom, Meet) | `POST https://<region>.recall.ai/api/v1/bot/` with `meeting_url`, `bot_name` | `RecallClient.createBot` |
| Join at the meeting time, guaranteed | `join_at` more than 10 min ahead = *scheduled bot*; nearer = *ad hoc* | `RecallBotController.schedule` |
| Reschedule / cancel | delete a scheduled bot, `leave_call` for one already joining | `RecallBotController.cancel` |
| Live transcript, speaker-separated | `recording_config.transcript.provider.recallai_streaming` (low latency) + `diarization.use_separate_streams_when_available` | `buildCreateBody` |
| Receive the transcript | `realtime_endpoints` webhook, events `transcript.data` / `transcript.partial_data` | `/webhooks/recall` |
| Lobby / left / failed | bot status webhooks (`bot.in_waiting_room`, `bot.in_call_recording`, `bot.call_ended`, `bot.fatal`, ...) | `mapRecallPayload` |

## One-time setup in the Recall dashboard (human steps)

1. Pick the region your account lives in (the dashboard URL says: `us-west-2`, `us-east-1`, `eu-central-1`, `ap-northeast-1`).
   Credentials do not work across regions. Put it in `RECALL_REGION`.
2. **API keys page**: create an API key (`RECALL_API_KEY`) and a **workspace verification secret** (`whsec_...`,
   `RECALL_WEBHOOK_SECRET`). Without the secret Recall sends no signature and our endpoint rejects everything.
3. **Webhooks page**: add an endpoint `https://<PUBLIC_BASE_URL>/webhooks/recall` subscribed to the bot status events
   (`bot.*`). Transcript events do **not** go through the dashboard: we ask for them per bot in the Create Bot request,
   pointing at the same URL.
4. Set `PUBLIC_BASE_URL` to the same host (no trailing slash).

The backend accepts either `RECALL_API_KEY` or `RECALL_AI_API_KEY`, and either `RECALL_WEBHOOK_SECRET` or `RECALL_VERI_SECRET`.

## Behaviour to know

- **Webhook security:** every request is HMAC-verified over the raw body (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`) and rejected if the timestamp is more than 5 minutes off. Unverified requests get 401.
- **Retries:** real-time transcript webhooks are retried by Recall once per second, up to 60 times, then the endpoint is
  marked failed and **no more transcript is delivered for that bot**. The backend must be up and answer quickly; it
  always returns 2xx for events it does not use.
- **507 on create:** ad-hoc bots can get `507` when Recall's warm pool is empty; `createBot` retries every 30 s up to 10 times.
  Scheduling more than 10 minutes ahead avoids it.
- **Lobby:** Teams bots wait in the lobby by default; the host (or an attendee allowed to admit) must let the bot in.
  Tell the interviewer in advance. Unsupported on Teams: registration-required meetings, live events, town halls, direct
  calls, GCC High, breakout rooms. Teams bots cannot use meeting chat.
- **Interviewer vs candidate:** a speaker is tagged *interviewer* when Recall reports their e-mail equal to the interview's
  `ownerEmail`, or when they are the meeting host; otherwise *candidate* (host flag false) or *unknown*. Panels or a host
  who is not the interviewer need refinement.
- **Cost (verify on Recall's pricing page):** about $0.50 per recorded hour plus $0.15 per hour for built-in transcription.

## Hosting

Recall needs a stable public HTTPS URL for the backend. Recommended: Azure App Service on Linux (B1, about $12/month in
East US): managed TLS certificate for a custom domain, no OS to patch, supports web sockets. A Linux VM (B2s about $30/month,
with Caddy for TLS) works too if you prefer to own the machine. For a first test before hosting exists, use a tunnel
(ngrok or Cloudflare Tunnel) and set `PUBLIC_BASE_URL` to its URL.

## Not decided / not verified yet

- The exact `leave_call` and delete-scheduled-bot endpoints are written from Recall's docs index; confirm against the
  API reference on the first live run.
- Real payloads have not been captured yet; the mapping follows the documented schemas and is defensive about missing fields.
