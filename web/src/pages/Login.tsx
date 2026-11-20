import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
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

export function LegalFooter() {
  return (
    <footer className="border-t border-zinc-200 py-8 text-sm muted dark:border-zinc-800">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4">
        <span>© {new Date().getFullYear()} Interview Assist</span>
        <Link className="hover:underline" to="/terms">Terms &amp; Conditions</Link>
        <Link className="hover:underline" to="/privacy">Privacy Policy</Link>
      </div>
    </footer>
  );
}

export function LoginPage() {
  const { error } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <span className="font-semibold tracking-tight">Interview Assist</span>
        <SignInButton className="btn-ghost" />
      </header>

      <main className="mx-auto max-w-5xl space-y-20 px-4 pb-20 pt-10">
        <section className="max-w-2xl space-y-5">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">A second pair of ears for every interview.</h1>
          <p className="text-lg muted">
            Interview Assist helps interviewers run better, fairer conversations. It follows your Teams, Zoom or Google Meet interview live, assesses each answer as it is given, and suggests the follow-up questions that will help you make a confident decision.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex flex-wrap items-center gap-3">
            <SignInButton />
            <span className="text-xs muted">Work, school and personal Microsoft accounts are supported.</span>
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

        <section className="space-y-6">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <ol className="space-y-5">
            <Step n={1} title="Sign in and add your interview">Sign in with Microsoft, paste the meeting link and add the role and what you want to assess.</Step>
            <Step n={2} title="A bot joins your meeting">At the start time, a meeting bot named “Interview Assist” joins your call as a participant. Please admit it from the lobby, otherwise it cannot hear the conversation and nothing will work.</Step>
            <Step n={3} title="Coaching appears on your screen">Only you see the transcript, scores and suggested questions. The assistant never speaks or types in the meeting.</Step>
          </ol>
        </section>

        <section className="card space-y-3 border-indigo-200 bg-indigo-50/60 p-6 dark:border-indigo-900 dark:bg-indigo-950/30">
          <h2 className="text-xl font-semibold tracking-tight">Be open with everyone on the call</h2>
          <p className="text-sm">
            A visible bot will appear in the participant list and the meeting is recorded and transcribed. <strong>Before you use Interview Assist, tell the candidate and every other participant that the meeting will be recorded and analysed by an AI tool, and get their permission.</strong> Recording laws differ by country and state, and some require consent from everyone on the call. Using the tool is entirely at your own risk and you are responsible for complying with them.
          </p>
          <p className="text-sm muted">
            Audio and transcripts are handled by our meeting-bot provider, <a className="underline" href="https://www.recall.ai" target="_blank" rel="noreferrer">Recall.ai</a>, and analysed by our AI, which stores interview data in our private AI cloud. See the <Link className="underline" to="/privacy">Privacy Policy</Link> and <Link className="underline" to="/terms">Terms &amp; Conditions</Link> for details.
          </p>
        </section>

        <section className="flex flex-col items-start gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">Ready for your next interview?</h2>
          <SignInButton />
          <p className="max-w-xl text-xs muted">By signing in you confirm that you have read and agree to the <Link className="underline" to="/terms">Terms &amp; Conditions</Link> and <Link className="underline" to="/privacy">Privacy Policy</Link>, and that you will get consent from everyone before recording an interview.</p>
        </section>
      </main>
      <LegalFooter />
    </div>
  );
}
