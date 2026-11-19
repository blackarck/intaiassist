# Interview Assist: web app

React + Vite + TypeScript + Tailwind. A static single-page app: sign in with Microsoft, create an interview, prepare it (role, JD,
resume, your own questions), then watch the live room: transcript, questions to ask next, a score per answer, "Assist me", and a
scorecard at the end. Admins also get **AI settings** (which model serves each step).

```bash
cd web
npm install
cp .env.example .env.local     # fill in the values, see below
npm run dev                    # http://localhost:5173
npm test && npm run typecheck
npm run build                  # static files in dist/
```

## How it talks to the backend

- Everything goes to `VITE_API_URL` with the signed-in person's **ID token** as the bearer token (MSAL fetches and renews it).
  The backend verifies it (`backend/src/auth.ts`) and decides access by the account's tenant + id, never by e-mail.
- The live room is a Server-Sent Events stream read with `fetch` (so it can send the token header). It resumes from the last event
  id after a drop, so a closed laptop or a bad connection loses nothing. `src/sse.ts` parses the stream, `src/room.ts` turns events
  into screen state (both unit-tested).

## Sign-in setup (Microsoft Entra)

Register an application in Entra ID:

- Platform **Single-page application**; redirect URIs `http://localhost:5173` and `https://intassist.askproso.ai`.
- Supported account types: **work/school accounts in any tenant and personal Microsoft accounts** (interviewers come from many
  companies). Authority `https://login.microsoftonline.com/common`.
- No API permissions beyond the default `User.Read`; the app only needs the ID token (`openid profile email`).
- Put the **Application (client) ID** in the web build as `VITE_MS_CLIENT_ID` and on the backend as `MS_CLIENT_ID`.
- The first admin: sign in, call `GET /api/me`, copy `subject`, and set it in the backend's `ADMIN_SUBJECTS`.

## Local development without signing in

Backend: `DEV_AUTH=1 RECALL_API_KEY= ALLOWED_ORIGINS=http://localhost:5173 npm run dev` (the empty `RECALL_API_KEY` makes sure no real
bot can be created). Web: `VITE_DEV_USER=you@example.test`. The backend refuses `DEV_AUTH=1` when `NODE_ENV=production`.
Play a meeting without Recall through `POST /api/dev/interviews/:id/segments` and `/events` (operator token).

## Not done yet

Google sign-in (the backend verifier exists; the button does not), resume file upload (paste for now), payment, a read-only guest
view, and billing.

## Deploying

`infra/azure/deploy-backend.sh` builds the committed `web/` with the public settings (`VITE_API_URL`, `VITE_MS_CLIENT_ID`; no dev
user), ships it to the VM and Caddy serves it on `intassist.askproso.ai` (security headers + CSP in `deploy/Caddyfile`; unknown
paths fall back to `index.html`; hashed assets cached for a year). The sign-in popup returns to `/redirect.html`, which must be a
registered SPA redirect URI in the Entra app.
