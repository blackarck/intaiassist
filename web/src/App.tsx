import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { Spinner } from "./components/ui";
import { useMe } from "./hooks";
import { usePageMeta } from "./pageMeta";
import { AdminPage } from "./pages/Admin";
import { InterviewPage } from "./pages/Interview";
import { InterviewsPage } from "./pages/Interviews";
import { PrivacyPage, TermsPage } from "./pages/Legal";
import { LoginPage } from "./pages/Login";

function Shell() {
  const auth = useAuth();
  const me = useMe();
  const { pathname } = useLocation();
  usePageMeta(pathname, auth.status === "signedIn");
  if (pathname === "/terms") return <TermsPage />;
  if (pathname === "/privacy") return <PrivacyPage />;
  if (auth.status === "loading") return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  if (auth.status === "signedOut") return <LoginPage />;
  const link = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? "bg-zinc-200 dark:bg-zinc-800" : "muted hover:text-zinc-900 dark:hover:text-zinc-100"}`;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <Link to="/" className="font-semibold tracking-tight">Interview Assist</Link>
          <nav className="flex gap-1"><NavLink to="/" end className={link}>Interviews</NavLink>{me.data?.isAdmin && <NavLink to="/admin" className={link}>AI settings</NavLink>}</nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden muted sm:inline">{auth.name ?? auth.email}</span>
            <button className="btn-ghost !py-1" onClick={auth.signOut}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<InterviewsPage />} />
          <Route path="/i/:id" element={<InterviewPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<p className="muted">Page not found. <Link className="text-indigo-600 underline" to="/">Back to interviews</Link></p>} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  );
}
