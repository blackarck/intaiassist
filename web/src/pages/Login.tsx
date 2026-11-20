import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { SiteFooter } from "../components/SiteFooter";
import { ErrorNote } from "../components/ui";

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden><rect width="10" height="10" fill="#f25022" /><rect x="11" width="10" height="10" fill="#7fba00" /><rect y="11" width="10" height="10" fill="#00a4ef" /><rect x="11" y="11" width="10" height="10" fill="#ffb900" /></svg>
  );
}

function SignInButton({ className = "btn-primary" }: { className?: string }) {
  const { signIn, canSignIn } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!canSignIn) return <ErrorNote>Sign-in is not set up in this build (no Microsoft client id).</ErrorNote>;
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await signIn(); } finally { setBusy(false); }
      }}
    >
      <MicrosoftIcon />
      {busy ? "Waiting for Microsoft…" : "Sign in with Microsoft"}
    </button>
  );
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm muted">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-indigo-600 text-sm font-semibold text-white">{n}</span>
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-sm muted">{children}</p>
      </div>
    </li>
  );
}

export function LoginPage() {
  const { error } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-5xl px-4 py-4">
        <span className="font-semibold tracking-tight">Interview Assist</span>
      </header>

      <main className="mx-auto max-w-5xl space-y-20 px-4 pb-20 pt-6">
        <section className="grid items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-5">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">A second pair of ears for every interview.</h1>
            <p className="text-lg muted">
              Interview Assist helps interviewers with conversation. It follows your Teams (to come - Zoom or Google Meet) interview live assesses each answer as it is given, and suggests the follow-up questions that will assist you with decision.
            </p>
          </div>
          <div className="card space-y-4 p-6 shadow-md">
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">Interviewer sign-in</p>
            <h2 className="text-xl font-semibold tracking-tight">Start your next interview</h2>
            <p className="text-sm muted">Sign in with Microsoft to set up an interview and invite the assistant.</p>
            {error && <ErrorNote>{error}</ErrorNote>}
            <SignInButton className="btn-primary w-full" />
            <p className="text-xs muted">By continuing you agree to the <Link className="underline" to="/terms">Terms of Service</Link> and <Link className="underline" to="/privacy">Privacy Policy</Link>, get everyone's consent before recording an interview.</p>
          </div>
        </section>

        <section className="space-y-4">
          <img
            src="/interview-screenshot.png"
            alt="Interview Assist during a real interview: the live transcript of a question on the left and, on the right, a scored assessment of the candidate's answer with correctness, depth, clarity and relevance bars and suggested corrections."
            className="w-full rounded-xl border border-zinc-200 shadow-lg dark:border-zinc-800"
          />
          <p className="text-sm muted">From a real interview: each answer is scored on correctness, depth, clarity and relevance, with the weak points quoted and the stronger answer spelled out for you.</p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-semibold tracking-tight">What it does for you</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Feature title="Live transcript">See what is being said as it is said, so you can stay in the conversation instead of taking notes.</Feature>
            <Feature title="Real-time answer assessment">Every answer gets a short verdict and scores for correctness, depth, clarity and relevance, with the exact phrases that were weak and what a good answer looks like.</Feature>
            <Feature title="Questions to ask next">Two or three probing follow-ups, with the reasoning behind them, refreshed while the candidate is still talking.</Feature>
          </div>
          <p className="muted text-sm">The result is more consistent assessments across your team, better follow-up questions, and a written record to support the hiring decision. You stay in charge: the assistant advises, you decide.</p>
        </section>

        <section id="how-it-works" className="space-y-6 scroll-mt-6">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <ol className="space-y-5">
            <Step n={1} title="Sign in and add your interview">Sign in with Microsoft, invite the offered bot emailid to interview, optionally add the role and what you want to assess.</Step>
            <Step n={2} title="A bot joins your meeting">At the start time, a meeting bot  “Interview Assist” joins your call as a participant. Please admit it from the lobby</Step>
            <Step n={3} title="Coaching appears on your screen">Only you see the transcript, scores and suggested questions on the portal. The assistant never speaks or types in the Team's meeting.</Step>
          </ol>

          <figure className="space-y-3">
            <img
              src="/invite-screenshot.png"
              alt="An interview in Interview Assist showing the bot's email address to add to your meeting invite, with a Copy address button, and a note that the assistant joins a minute before the start and listens only."
              className="w-full rounded-xl border border-zinc-200 shadow-lg dark:border-zinc-800"
            />
            <figcaption className="text-sm muted">Each interview gets its own bot address. Invite it like any attendee from Teams, Zoom or Google Calendar. The assistant joins a minute before the start; in Teams, admit it from the lobby. It listens only and never speaks in the meeting.</figcaption>
          </figure>

          <div className="card space-y-1 p-5">
            <h3 className="font-semibold">Your Teams calendar, shown only to you</h3>
            <p className="text-sm muted">If you allow it, your Microsoft (Teams) calendar for today appears in the app, so you can send the bot into a meeting with one click instead of copying addresses. It is read directly from Microsoft in your browser, only you see it, and we only use the meeting link of the meeting you choose. Entirely optional: you are asked for permission first, and the invite address above works without it.</p>
          </div>
        </section>

        <section id="consent" className="card scroll-mt-6 space-y-3 border-indigo-200 bg-indigo-50/60 p-6 dark:border-indigo-900 dark:bg-indigo-950/30">
          <h2 className="text-xl font-semibold tracking-tight">Be open with everyone on the call</h2>
          <p className="text-sm">
            A visible bot will appear in the participant list and the meeting is recorded and transcribed. <strong>Before you use Interview Assist, tell the candidate and every other participant that the meeting will be recorded and analysed by an AI tool, and get their permission.</strong> Recording laws differ by country and state, and some require consent from everyone on the call. Using the tool is entirely at your own risk and you are responsible for complying with them.
          </p>
          <p className="text-sm muted">
            Audio and transcripts are handled by our meeting-bot provider, <a className="underline" href="https://www.recall.ai" target="_blank" rel="noreferrer">Recall.ai</a>, and analysed by our AI, which stores interview data in our private AI cloud (for suggestions). See the <Link className="underline" to="/privacy">Privacy Policy</Link> and <Link className="underline" to="/terms">Terms of Service</Link> for details.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
