import { useAuth } from "../auth";
import { ErrorNote } from "../components/ui";

export function LoginPage() {
  const { signIn, canSignIn, error } = useAuth();
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="card w-full max-w-md space-y-6 p-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Interview Assist</h1>
          <p className="mt-2 text-sm muted">A quiet second pair of ears on your interview: live transcript, questions to ask next, and a score for each answer. Only you see it. The assistant never speaks in the meeting.</p>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        {canSignIn ? (
          <button className="btn-primary w-full" onClick={signIn}>
            <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden><rect width="10" height="10" fill="#f25022" /><rect x="11" width="10" height="10" fill="#7fba00" /><rect y="11" width="10" height="10" fill="#00a4ef" /><rect x="11" y="11" width="10" height="10" fill="#ffb900" /></svg>
            Sign in with Microsoft
          </button>
        ) : (
          <ErrorNote>Sign-in is not set up in this build (no Microsoft client id).</ErrorNote>
        )}
        <p className="text-xs muted">Work, school and personal Microsoft accounts are supported.</p>
      </div>
    </div>
  );
}
