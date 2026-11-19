# AI Interview Assist

A bot joins a Teams interview, listens, and coaches the interviewer privately. Design docs:
[plan](doc/plan.md) · [bot-join research](doc/bot-join-research.md) · [end-to-end flow](doc/flow.md).

## Layout

| Path | What | State |
|---|---|---|
| `backend/` | TypeScript (Fastify). Invite intake, alias matching, scheduler, bot-event receiver | **Working, 25 tests pass** |
| `infra/logic-app/` | Logic App that forwards invite emails from the bot mailbox to the backend | Written, **not deployed or validated** |
| `teams-app/` | Teams app manifest template (calling bot + personal chat + RSC permissions), `pack.sh` | Packs and the JSON is valid, **not sideloaded** |
| `media-bot/` | .NET 8 service with `IMeetingBot`. `StubMeetingBot` simulates a call. `GraphMeetingBot` is the real Teams bot (join by link, unmixed audio, per-speaker Azure Speech) | Stub works end to end. Graph bot **compiles but has never run** (Windows-only media platform) |
| `media-bot-tests/` | xUnit tests for the join-URL parser | 6 pass |
| `infra/azure/` | `provision.sh` (resource group, Speech, Key Vault) and `provision-vm.sh` (Windows VM, billable) | Syntax-checked, **not run** (Azure CLI session needs MFA refresh) |

## Run the whole pipeline locally (stub bot, no Teams needed)

```bash
# terminal 1: backend
cd backend && npm install
INTAKE_TOKEN=tok ALIAS_DOMAIN=bot.test MEDIA_BOT_URL=http://localhost:5080 MEDIA_BOT_API_KEY=botkey npm start

# terminal 2: bot (stub mode)
cd media-bot && DOTNET_ROLL_FORWARD=Major Bot__ApiKey=botkey Bot__Mode=stub Backend__Token=tok \
  ASPNETCORE_URLS=http://localhost:5080 dotnet run

# terminal 3: seed a "paid" interview, then send a fake invite
curl -X POST localhost:3000/api/dev/interviews -H 'authorization: Bearer tok' -H 'content-type: application/json' \
  -d '{"alias":"7KQ2","ownerEmail":"recruiter@acme.com"}'
curl -X POST localhost:3000/api/intake/meeting-invite -H 'authorization: Bearer tok' -H 'content-type: application/json' \
  -d '{"messageId":"m1","from":"recruiter@acme.com","to":"iv-7kq2@bot.test","subject":"Interview","body":"https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0?context=x"}'
```

The backend log then shows the stub's transcript segments. `DOTNET_ROLL_FORWARD=Major` is only needed if you do not have the .NET 8 runtime.

Backend tests: `cd backend && npm test` (also `npm run typecheck`).

## What is real vs. stubbed

- **Real and tested:** join-link extraction (including Safe Links unwrapping and host allow-list), alias parsing (`iv-TAG@` and `assistant+TAG@`), ICS parsing, reschedule and cancel handling, single-use alias binding, scheduling the join 60 s before start, the paste-link fallback, bot event to interview status.
- **Stubbed:** payment and portal (interview records are seeded through a dev route), the store (in-memory), the scheduler (in-process timers; use Service Bus in production), auth (shared bearer token; Entra JWT is a TODO in `backend/src/app.ts`).
- **Written, not run:** `GraphMeetingBot` and `SpeechTranscriber` (needs the Windows VM, see `doc/spike-runbook.md`).
- **Not started:** evaluator and coaching cards, the Teams chat bot's proactive messages.

## Next: the spike

Server details: [doc/server-setup.md](doc/server-setup.md). Spike plan: [doc/spike-runbook.md](doc/spike-runbook.md): provision Azure, create the Entra app and Azure Bot, run the bot on the VM, then answer spike questions Q0-Q7.
