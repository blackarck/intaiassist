> **Status (2026-11-19): superseded.** We built and ran the own-Teams-media-bot route (Option A). It joins meetings by link, but Graph refuses `updateRecordingStatus` for link-joined bots, so it cannot compliantly transcribe. The product now uses Recall.ai (Option B); see [recall-integration.md](recall-integration.md). The code is preserved at git tag `teams-media-bot-spike`. Everything below is kept as the record of that investigation.

# Deliverable 1: Getting the Bot Into a Teams Interview (Research)

_Researched 2026-11-18 against current Microsoft Learn docs. Re-check the items marked **Verify in spike** before committing._

## TL;DR

There are four realistic ways to get live interview content. In order of fit for us:

| # | Option | Live? | Who must approve in the customer's tenant | Effort | Verdict |
|---|---|---|---|---|---|
| A | **Our own Graph calling bot (app-hosted media)** joins via meeting link, we run Azure STT | Yes, ~1-2s | Nothing tenant-wide if we use **RSC** (organizer adds our Teams app to the meeting). But bot-detection lobby may hold it | High (Windows/.NET media bot) | **Best long-term control**; Microsoft discourages it for "AI agent" use |
| B | **Meeting-bot vendor (Recall.ai etc.)** joins via link, streams transcript to us | Yes | Nothing; organizer admits bot from lobby | Low | **Fastest MVP**, ~$0.65/hr incl. transcription |
| C | **Work IQ real-time transcripts** (new, Microsoft's official path) | Yes | Organizer's tenant admin must turn on Work IQ access (off by default) + allow AI in meetings + transcription must be running + Copilot Credits billing | Medium | **Watch / enterprise tier later**; just went GA, too many tenant prerequisites for SMB customers |
| D | **Graph transcript API** (Teams' own transcription) | **No, only after the meeting ends** | Admin must enable "Microsoft Graph access" for transcripts (off by default) + app permissions | Low | Use only for the **post-interview scorecard**, not live coaching |

**Decision (2026-11-18):** Build **Option A (own bot) first**, behind our own `MeetingSource` interface. Use the paid vendor (Option B) **only if A is blocked** (e.g. `updateRecordingStatus` fails for link-joined bots). Treat C as a future "enterprise" connector. Use D only as an optional post-meeting enrichment. Meeting-link intake uses a **Logic App** on the bot mailbox (section 4.1).

---

## 1. What Microsoft already offers (and why it doesn't solve live coaching alone)

### 1.1 Graph meeting transcripts: post-meeting only
- Endpoints: `GET /users/{id}/onlineMeetings/{meetingId}/transcripts` and `/transcripts/{id}/content` (.vtt).
- **Not available while the meeting is in progress.** A Microsoft moderator (Apr 2026) confirmed that fetching transcripts for an ongoing meeting isn't supported; they're available only after the meeting ends.
- You can subscribe to change notifications (`communications/onlineMeetings/getAllTranscripts`, or per meeting) to know when one is ready.
- **Tenant admin gate:** as of Oct 2026, Teams admin center → Meetings → Meeting settings → *Transcript API access* → **Microsoft Graph access is OFF by default**. Apps can't read transcripts regardless of permissions until an admin turns it on (`Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true`). Speaker attribution is a separate toggle (`-EnableAttributedTranscripts`).
- Teams transcription must also have been started by someone in the meeting.

**Use for us:** optional post-interview enrichment only.

### 1.2 Work IQ real-time transcripts: new official live path
- Microsoft's documented way for "agents and apps, including ones your organization builds" to receive a Teams meeting transcript **while it's in progress**. Includes speaker names.
- Roadmap RM570651: preview Sept 2026, **GA Nov 2026**. The admin setting takes effect **Nov 14, 2026**.
- Prerequisites, all of which must be true in the **meeting organizer's** tenant:
  1. Teams admin turns on **WorkIQ access** (`Set-CsTeamsMeetingConfiguration -EnableWorkIQTranscriptAccess $true`). It's **off by default**.
  2. "Allow AI in all meetings" is on.
  3. **Transcription is running.** Work IQ does not start it; someone in the meeting must.
  4. The app acts **on behalf of a signed-in user** (delegated), with Entra permissions.
  5. Work IQ is enabled for the tenant: a Global Admin creates the Work IQ service principal, plus a **Copilot Studio usage-based billing plan (Copilot Credits) on an Azure subscription**.
- Developer surface: Work IQ is exposed over REST, MCP and A2A, and is GA in Foundry and Copilot Studio. **I couldn't find a published developer reference for the real-time transcript stream itself** (latency, payload, subscription model). **Verify in spike.**
- Fit: great for large enterprise customers who already run Copilot. Too much admin setup for an SMB interviewer who just pays per interview. Also, the bot doesn't "join". The interviewer would sign into our app and we'd read their transcript on their behalf.

### 1.3 Microsoft's own guidance on media bots
The real-time media concepts page (updated May 2026) now says real-time media bots are **"not recommended for AI agent scenarios"**. It frames them as intended for Cloud Video Interop, compliance recording and contact center, "provided via managed partners". It recommends Copilot Studio agents or transcripts instead.
It's guidance, not a ban, and many notetaker vendors still use this API. But it signals Microsoft will favour Work IQ over raw media for AI agents. **Design so the audio/transcript source is swappable.**

---

## 2. Option A in detail: our own Graph calling bot

### How joining works
- `POST /communications/calls` with `meetingInfo` (organizer info or join-meeting-ID + passcode) or parsed from the **meeting join URL** the interviewer pastes. `tenantId` is the organizer's tenant.
- `mediaConfig: appHostedMediaConfig` gives us raw audio: **16 kHz, 16-bit PCM, 20 ms frames (50/s)**, with **active/dominant speaker IDs** per frame so we know who spoke.
- Bot appears in the roster under the bot's display name, e.g. "Interview Assistant".

### Permissions (pick one model)
| Model | Permissions | Who consents | Notes |
|---|---|---|---|
| **RSC (preferred)** | `Calls.JoinGroupCalls.Chat`, `Calls.AccessMedia.Chat` | Meeting organizer adds our Teams app to the meeting/chat | Scoped to that one meeting. No tenant-wide grant. Customer tenant must still **allow our Teams app** (app permission policy / store availability) |
| Tenant-wide | `Calls.JoinGroupCall.All` (or `Calls.JoinGroupCallAsGuest.All`) + `Calls.AccessMedia.All` | Customer **Global Admin** consent | Heavy ask for small customers |

### Hard requirements
- **Windows Server + .NET** (`Microsoft.Graph.Communications.Calls.Media`). No Python/Node media SDK. Host on Azure Windows VMs / VMSS or AKS Windows node pool with **public IP per instance** and the media port range open.
- **Azure Bot** resource, Teams channel with **Calling enabled** and a calling webhook. Teams app manifest with `supportsCalling: true`.
- **Recording-status rule:** you can't record or persist media, or **data derived from it** (a transcript counts), without first calling `updateRecordingStatus` and getting success. That shows the recording/transcribing indicator to participants, which is also good for candidate consent. Community reports say this call can return 403 / error 8506 outside policy-based compliance-recording calls. **Verify in spike: this is the #1 technical risk for Option A.**

### Findings from implementing it (2026-11-18)
- **Short links don't carry the tenant.** `teams.microsoft.com/meet/<id>?p=...` has no organizer/tenant. Only the long
  `meetup-join/...?context={Tid,Oid}` form does. The backend must pass the interviewer's `tenantId` to the bot.
- **New multi-tenant Azure Bot resources can't be created** (deprecated after 31 Jul 2025; existing ones keep working).
  New bots are SingleTenant or user-assigned managed identity. Community reports say a single-tenant bot resource with
  a multi-tenant Entra app registration works across tenants, but I found no Microsoft statement. **Spike Q3.**
- **The media SDK expires.** Microsoft requires the newest `Calls.Media` package or one not older than ~3 months.
- **Hosting:** VM / VMSS / AKS / Cloud Service only (not App Service), instance-level public IP, at least 2 cores,
  calls pinned to the VM that accepted them.
- **Audio:** `AudioSocketSettings.ReceiveUnmixedMeetingAudio = true` delivers per-speaker buffers tagged with the
  speaker's source id (MSI). Not usable with 24 kHz audio. We use 16 kHz PCM.
- **Joining as a named guest** (`GuestIdentity`) always lands in the lobby; joining as the app uses the bot
  registration name.
- Reference sample (MIT) the code follows: `microsoftgraph/microsoft-graph-comms-samples` (`LocalMediaSamples`,
  `PolicyRecordingBot`). Its auth helper is explicitly "not tested rigorously for production".

### Bot-detection lobby (new in 2026)
- Teams meeting policy `ExternalBotAccessMode` defaults to **`RequireApprovalWhenDetected`**. Detected **external** bots are forced into the lobby even if the meeting lets everyone bypass it, and the organizer sees a risk warning before admitting.
- Same-tenant bots are treated as trusted. Ours will be **external** to every customer.
- The **Teams Bot Identification Program** (public preview) lets registered ISVs mark their bots as identified. Recall.ai, Otter, Read AI and others are in it. **The preview is full; GA onboarding "coming soon".** Apply as soon as it opens.
- Product implication: the flow must tell the interviewer **"Admit 'Interview Assistant' from the lobby"**. Our chat bot can ping them when we're waiting.

---

## 3. Option B in detail: meeting-bot vendor (Recall.ai as reference)

- One API call with the meeting URL. The bot joins Teams (also Zoom/Meet/Webex) and streams real-time transcript or audio to our webhook or websocket.
- Pricing (2026, pay-as-you-go): **$0.50/recording hour + $0.15/hr transcription**. Or take raw audio and run **our own Azure Speech**, keeping STT in our Azure stack. Storage is free for 7 days.
- Registered in the Teams Bot Identification Program, so it shows as an identified bot in the lobby rather than an unknown one.
- No customer-tenant consent, no Windows media infra, multi-platform for free.
- Trade-offs: data passes through a third party (needs a DPA, and an EU region if needed), per-hour cost, vendor dependency. Alternatives to evaluate: MeetStream, MeetingBaaS, Vexa (open source, self-host).

---

## 4. Your "bot email ID" idea: where it actually helps

Joining is by **meeting link**, not email. But a bot mailbox is still very useful for **how the interviewer gives us the link**.

**Recommended pattern: "invite the assistant"**
1. Create one licensed mailbox in **our** tenant, e.g. `assistant@<ourdomain>` (Exchange Online license is enough. It doesn't join calls itself.)
2. Give each paid interview a **unique alias**, e.g. `iv-7KQ2@<ourdomain>`. Exchange allows up to ~400 proxy addresses per mailbox. For more, use a few mailboxes or a catch-all domain route. These are the "different IDs" you mentioned. No need for separate accounts.
3. The interviewer adds that address to the Teams invite (same way people add Otter/Fireflies).
4. Our backend watches the mailbox with Graph (`Calendars.Read` / change notifications **in our own tenant**, so no customer consent is needed). It matches the alias to the paid interview, extracts the **join URL and start time**, and auto-dispatches the bot (Option A or B) a minute before start.
5. Fallback: the interviewer pastes the meeting link in the portal.

Benefits: zero copy-paste, the interview is tied to payment by alias, and calendar updates and reschedules flow automatically.
What it does **not** do: being on the invite does not let a bot hear audio. The join still happens via Option A or B. A browser-automation bot "signing in" as that mailbox user is possible but brittle, and likely to be flagged by bot detection. Not recommended.

### 4.1 Intake via Azure Logic App (chosen)

The Logic App only **catches the invite and forwards it**. The backend does the parsing and matching, so the Logic App stays trivial and testable.

```
Interviewer's Teams invite ──► iv-7KQ2@ourdomain (alias of assistant@ mailbox, our tenant)
                                   │
                    Logic App (Consumption or Standard)
                    Trigger: Office 365 Outlook "When a new email arrives (V3)"
                             on assistant@ (licensed user mailbox, NOT shared)
                    Condition: message is a meeting request/update/cancel
                    Action:  HTTP POST → backend /api/intake/meeting-invite
                             body: { messageId, to[], cc[], from, subject,
                                     bodyHtml, receivedAt, (ics attachment) }
                             auth: Logic App managed identity → Entra-protected API
                                   │
Backend: find join URL (regex for teams.microsoft.com/l/meetup-join/… or /meet/<id>?p=…)
         → match recipient alias → paid interview
         → upsert schedule (start time, iCalUId) → dispatch bot at T-1 min
         → if no paid interview matches: reply "please complete payment" link
```

**Why the email trigger, not the calendar-event trigger:**
- The meeting-request email carries the **To address the interviewer typed** (the alias), which is how we map it to the paid interview. The calendar event may only show the primary address.
- Known issue: "When a new event is created (V3)" **fires twice** when an invite is accepted. Outlook rewrites the event Id. If we add a calendar trigger later for reschedules, dedupe on `iCalUId`.
- The Outlook connector **does not support shared calendars**, so use a licensed user mailbox for `assistant@`.

**Handling the lifecycle:**
- **New / updated invite:** upsert by `iCalUId` (stable across updates). Reschedules change the start time, so we re-schedule the bot job.
- **Cancellation:** subject starts with "Canceled:" / message class is a cancel. Cancel the job and optionally refund credits.
- **No auto-accept needed.** The bot joins by link regardless. Optionally have the Logic App "Respond to event: Accept" so the organizer sees the assistant confirmed.

**Aliases vs plus addressing:**
- Proxy aliases (`iv-7KQ2@`) are known to work. The limit is roughly 400 per mailbox, so recycle aliases after the interview or rotate across a few mailboxes.
- Plus addressing (`assistant+7KQ2@`) would remove the limit and the alias admin. **Verify in spike** that the `+tag` survives in the To header of a Teams/Outlook meeting request from an external tenant.

**Security:**
- Backend endpoint accepts only the Logic App's managed identity token.
- Treat the email body as untrusted input. Only extract the URL with a strict pattern, and accept only `teams.microsoft.com` / `teams.live.com` hosts.
- Ignore invites from senders not linked to a paying account (or hold for verification).

**Fallback:** portal "paste meeting link" posts to the same backend intake service.

---

## 5. Second window: the private chat with the interviewer

Independent of how we get audio:
- **Teams personal-scope bot** (Azure Bot Service + Teams app) sends proactive messages to the interviewer. Requires the interviewer to install our app once, and their tenant to allow third-party/custom apps. Many tenants block that by default.
- **Fallback that always works:** a **live web panel** in our portal (SignalR/WebSocket) the interviewer keeps open next to Teams. Recommended for MVP. Add the Teams chat bot as an option for tenants that allow our app.

---

## 6. Proposed Deliverable 1 scope

**Goal:** an interviewer pastes a Teams link, or invites `iv-xxxx@`. A bot named "Interview Assistant" joins, waits for admission from the lobby, and we receive a **speaker-labelled live transcript** in our backend within ~2s, shown in a portal panel.

**Build:**
1. `MeetingSource` interface: `join(url) → stream<TranscriptSegment{speaker, text, ts}>`, `leave()`.
2. Implementation 1: **Recall.ai** (or chosen vendor), sending real-time transcript or audio to Azure Speech.
3. Invite-by-email: bot mailbox + alias-per-interview + Graph calendar watcher.
4. Portal: paste-link, status (scheduled → waiting in lobby → in meeting → ended), live transcript panel.

**Spike in parallel (2 weeks): Option A**
- Stand up the Microsoft `PolicyRecordingBot` / join-meeting sample on an Azure Windows VM.
- Prove: join a **meeting in another tenant** via join URL with **RSC** permissions, receive unmixed audio with speaker IDs, and whether `updateRecordingStatus` succeeds for a non-policy (ad-hoc join) bot.
- Measure: lobby/bot-detection behaviour, join time, cost per concurrent call per VM.
- Decision gate: if all three pass, plan the migration from the vendor to our own bot for cost and control. If `updateRecordingStatus` fails, stay on the vendor.

**Watch:** Work IQ real-time transcript developer docs, and Teams Bot Identification Program GA (apply immediately).

## 7. Things we need to set up now
- [ ] Our M365 tenant (domain), 1 Exchange-licensed mailbox for `assistant@`, alias plan
- [ ] A **second test tenant** (M365 dev/trial) to act as "customer" for cross-tenant tests
- [ ] Entra multi-tenant app registration + Azure Bot resource (Teams channel, calling enabled)
- [ ] Recall.ai (or chosen vendor) dev account, DPA review
- [ ] Azure Speech resource (already in Foundry), plus Windows VM for the Option A spike
- [ ] Candidate consent text for the invite and the bot's join message

## Sources
- [Manage transcript API access for Teams meetings (Graph + Work IQ toggles)](https://learn.microsoft.com/en-us/microsoftteams/meeting-transcript-api-access)
- [Enable your tenant for Work IQ](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)
- [Roadmap RM570651 – Work IQ: Real Time Transcripts](https://mc.merill.net/message/RM570651)
- [What's new in Work IQ at Ignite 2026](https://techcommunity.microsoft.com/blog/microsoft_365blog/whats-new-in-work-iq-at-ignite-2026-agents-that-get-work-done/4572219)
- [Q&A: mid-meeting transcript not supported (Apr 2026)](https://learn.microsoft.com/en-us/answers/questions/5870080/microsoft-teams-graph-api-mid-meeting-transcript-p)
- [Meeting transcripts overview](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts)
- [Create call / join meeting (Graph)](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0)
- [Register calls & meetings bot (RSC + app permissions, recording rule)](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/registering-calling-bot)
- [Real-time media concepts (not recommended for AI agents; audio format)](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)
- [updateRecordingStatus](https://learn.microsoft.com/graph/api/call-updaterecordingstatus?view=graph-rest-1.0) and [cloud communications media](https://learn.microsoft.com/en-us/graph/cloud-communications-media)
- [Manage external bots and their access to meetings](https://learn.microsoft.com/en-us/microsoftteams/manage-external-bots)
- [Teams Bot Identification Program](https://learn.microsoft.com/en-us/microsoftteams/teams-bot-identification)
- [New Teams policy controls notetaking bots (Office 365 IT Pros, Aug 2026)](https://office365itpros.com/2026/08/24/teams-meeting-notetaking-bots/)
- [Recall.ai pricing](https://www.recall.ai/pricing) and [2026 pricing update](https://www.recall.ai/blog/new-recall-ai-pricing-for-2026)
- [Office 365 Outlook connector (Logic Apps): triggers and known issues](https://learn.microsoft.com/connectors/office365)
- [Policy Recording Bot sample](https://github.com/microsoftgraph/microsoft-graph-comms-samples/tree/master/Samples/V1.0Samples/LocalMediaSamples/PolicyRecordingBot)

---

## After Q1 (2026-11-18): the own media bot cannot compliantly transcribe

The spike proved the bot joins a Teams meeting by link (same tenant, no lobby, seconds). But Microsoft only allows
`updateRecordingStatus`, and therefore any transcript or other derived data, for bots brought in by a
**Teams policy-based (compliance) recording policy**. Link-joined bots get refused. No code or permission change fixes it.

| Route | How it gets live text | Customer-side setup | Fit | Verdict |
|---|---|---|---|---|
| **Work IQ real-time transcripts** (Microsoft's official path for AI agents, GA Nov 2026) | Delegated: the interviewer signs in to our app; we receive the meeting's live transcript with speaker names | Tenant admin turns on Work IQ access + "Allow AI in meetings"; Work IQ enabled with Copilot Credits billing; **Teams transcription must be running** in the meeting | Microsoft-aligned, no media bot or VM needed; heavier for small customers | **Recommended to prototype next.** Our own tenant already has Microsoft 365 Copilot and Teams Premium |
| **Compliance recording policy** + our existing bot | Bot is auto-invited to the user's calls; `updateRecordingStatus` allowed | Admin creates an application instance + compliance recording policy per interviewer; license E3/E5/Business Standard/Premium | Microsoft: designed for compliance recording only, "any other use isn't supported"; support only for certified partners; bot joins **all** of the user's calls | Not recommended as the product. Could prove the audio/STT pipeline in our own tenant only |
| **Meeting-bot vendor** (Recall.ai etc.) | Vendor bot joins as a participant, streams transcript or audio | None beyond admitting the bot | Fastest, multi-platform; third-party data path, per-hour cost | Fallback, per your preference |
| Graph transcript after the meeting | Post-meeting only | Graph transcript access on | Scorecard only, no live coaching | Keep for the scorecard |

What stays useful from the built code: backend intake, scheduler, events, `MeetingSource` abstraction, speech pipeline,
and the Teams app (needed for the interviewer chat in any route).
