# AI Interview Copilot: Plan

## 1. Summary

A paid SaaS portal where an interviewer uploads a JD and a candidate resume, picks preset questions, and gets a bot to join their Teams interview. The bot listens to the call audio only. It talks to the interviewer in a separate private Teams chat, where it:

- suggests the next question
- tracks which questions are covered
- scores each answer against the JD
- proposes counter-questions
- produces a scorecard when the interview ends

### User story

1. Interviewer logs in to the portal and pays a fee per interview.
2. Interviewer uploads the JD and the candidate resume.
3. Interviewer chooses from preset questions (and can add custom ones).
4. Portal gives the interviewer a way to add the bot to the meeting (meeting link, see section 3).
5. Bot joins the interview and listens (audio in only, never speaks in the meeting).
6. Bot pings the interviewer in a separate Teams chat and coaches in text during the interview.
7. After the interview, the bot produces a scorecard and summary in the portal and by email.

## 2. Feasibility and complexity

Achievable. Every piece exists on Azure. The one risky part is **getting audio out of a Teams meeting**.

**Complexity: medium-high.** A rough MVP is 8-12 weeks with 2-3 engineers. Most of that is the Teams media bot and tenant onboarding, not the AI.

| Component | Difficulty |
|---|---|
| Portal, login, payments, uploads | Low |
| RAG over JD and resume, question generation | Low-medium (models already available in Foundry) |
| Live STT -> LLM scoring -> text coaching | Medium (latency tuning, prompt design) |
| **Teams bot that joins a meeting and receives audio** | **High** |
| Enterprise tenant consent and compliance | Medium-high (mostly non-code work) |

## 3. Recommended changes to the original idea

1. **The bot joins by meeting link, not by email invite.** The Microsoft Graph Calling API joins via `joinWebUrl`. The portal asks the interviewer to paste the Teams meeting link, and the bot joins within seconds. A "bot email" is possible but needs a licensed or guest account and is fragile.
2. **Use a real-time media bot.** It must be an application-hosted media bot on **Windows** (.NET, Azure VM or AKS Windows nodes). It receives **unmixed per-participant audio**, so speaker attribution comes for free without relying on diarization.
3. **The separate chat window is a standard Teams bot** (Bot Framework or Teams SDK, personal scope) sending proactive messages to the interviewer. The interviewer installs the app once.
4. **Customer IT admin consent is the biggest friction.** Permissions `Calls.JoinGroupCall.All` and `Calls.AccessMedia.All` need admin consent, plus application access policies. Every customer company's IT team has to approve this, which is slow for small buyers.
5. **Faster MVP path (optional).** A meeting-bot API such as Recall.ai handles joining Teams, Zoom and Meet. Suggestions show in a live web panel next to the call instead of Teams chat. Ship in weeks, then replace with an own Teams bot later to cut cost and own the pipeline. Recommended unless Teams-native is required from day one.
6. **Compliance is a launch blocker.** Scoring candidates with AI is high-risk employment AI under the EU AI Act. NYC Local Law 144 requires bias audits, and many US states have similar rules. Build in:
   - bot visibly joins by name (e.g. "X Interview Assistant")
   - consent notice to the candidate
   - decision support only, no auto-reject
   - no use of protected attributes
   - configurable transcript retention and deletion

## 4. Architecture (Azure)

```
Portal (Next.js, App Service / Static Web Apps)
  |- Auth: Entra External ID
  |- Payments: Stripe (or Razorpay), pay-per-interview credits
  |- DB: Postgres/Cosmos  |  Files: Blob Storage
  '- Ingest: resume + JD -> Azure AI Search (RAG index per interview)

Interview session orchestrator (Container Apps + Service Bus)
  |- Media bot (Windows VM/AKS) -- joins Teams, streams audio
  |- Azure AI Speech (real-time STT, per-speaker)
  |- Foundry GPT: evaluator (score vs rubric + JD + resume),
  |               follow-up generator, coverage tracker
  '- Teams chat bot (Azure Bot Service) -> proactive messages to interviewer

Post-interview: scorecard + summary -> portal + email
Key Vault | App Insights | Private endpoints
```

**Latency:** STT adds about 1 second and the LLM 2-4 seconds, which is fine for text coaching. Run the evaluator once per completed answer (detected when the speaker turn ends), not per word.

## 5. Configuration checklist

- **Entra ID:** multi-tenant app registration for the bot, Graph application permissions, admin-consent flow and customer docs
- **Azure Bot Service** resource with the Teams channel enabled, and a Teams app manifest
- **Public HTTPS endpoint and TURN/media ports** for the media bot, with certificate and static IP, on a Windows VM or AKS
- **Azure AI Speech** (streaming STT, language settings)
- **Foundry deployments:** a strong model for evaluation, a cheaper one for routing, and an embeddings model
- **Azure AI Search** for resume/JD RAG
- **Storage and data:** Blob, DB, Service Bus, Key Vault
- **Payments:** Stripe or Razorpay with webhooks that mark an interview as paid before the bot may join
- **Region and data residency** decisions (interview audio is sensitive)
- **Dev tenant** with Teams licenses for testing, since this cannot be tested without real Teams meetings

## 6. Recommended additions

- **Rubric-based scoring:** per-competency scores with evidence quotes from the transcript, not a single vague number.
- **Coverage tracker:** shows which preset questions are done and which JD skills are untested.
- **Resume-gap probes:** flags resume claims that have not been verified in the conversation.
- **Interviewer-only visibility:** the candidate never sees the coaching and the bot never speaks in the meeting.
- **Fallback mode:** upload a recording or transcript afterward and get the same scorecard. Cheap to build and earns revenue even if live join fails.
- **Zoom and Google Meet later:** customers will ask for them (another reason to consider a meeting-bot API at the start).
- **Cost guardrails:** estimate per-interview cost (STT per hour + LLM tokens + VM) and price the fee well above it.

## 7. Phases

1. **Weeks 1-3:** Portal, upload, RAG, question presets, and transcript-based scoring (the fallback mode).
2. **Weeks 3-7:** Live pipeline (bot join, STT, evaluator, chat coaching) in our own tenant.
3. **Weeks 7-12:** Payments, multi-tenant consent flow, compliance features, hardening, pilot with 3-5 interviewers.

## 8. Open decisions

- Build own Teams media bot first, or start with a meeting-bot API (Recall.ai) for speed?
- Payment provider: Stripe or Razorpay (depends on target market).
- Target markets (drives compliance scope and data residency region).
- Teams only for v1, or Zoom and Meet as well?
