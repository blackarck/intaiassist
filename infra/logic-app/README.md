# Logic App: invite intake

Forwards meeting-invite emails arriving at the bot mailbox to the backend. All parsing and matching happens in the backend (`backend/src/invite.ts`). The Logic App stays dumb on purpose.

`workflow.json` is a **Consumption** workflow definition. **Not deployed or validated yet.** Import it with *Logic app code view*, or wrap it in an ARM template. Check the connector's trigger output field names in the designer on the first run; the mapping assumes `id`, `from`, `to`, `cc`, `subject`, `body`, `dateTimeReceived`, `attachments[].name/contentType/contentBytes`.

## Setup

1. Create (or use) the **bot mailbox** `assistant@<yourdomain>` in your tenant: a normal licensed user mailbox, not a shared mailbox. The Outlook connector's calendar support for shared mailboxes is limited, and we want invites delivered as mail with an `.ics` attachment.
2. Add one proxy address per paid interview, `iv-<TAG>@<yourdomain>`. In the spike, add a few by hand in Exchange admin.
   - Alternative to test: plus addressing (`assistant+<TAG>@<yourdomain>`). Check that the `+tag` survives in the To header of an invite sent from another tenant.
3. Create the Logic App and an **Office 365 Outlook** connection signed in as `assistant@`.
4. Set parameters:
   | Parameter | Value |
   |---|---|
   | `backendUrl` | public URL of `POST /api/intake/meeting-invite` (use a dev tunnel while testing locally) |
   | `intakeToken` | the backend's `INTAKE_TOKEN` (secure parameter; Key Vault reference in real deployments) |
   | `aliasDomain` | same value as backend `ALIAS_DOMAIN` |
5. Send a Teams invite to `iv-<TAG>@<yourdomain>` and watch the run history.

## Production hardening (TODO)
- Replace the shared bearer token with **managed identity** auth on the HTTP action (`"authentication": { "type": "ManagedServiceIdentity", "audience": "api://<backend-app-id>" }`) and validate the Entra JWT in the backend (see the TODO in `backend/src/app.ts`).
- The trigger polls every minute. For lower latency, use a Graph change-notification subscription on the mailbox, or a shorter poll interval.
- The condition only forwards mail addressed to our alias domain, so unrelated mail in the mailbox is never sent to the backend.
