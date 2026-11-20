import { Link } from "react-router-dom";

const REPO = "https://github.com/blackarck/intaiassist";

const ECOSYSTEM: { name: string; href: string; tag: string; dot: string; here?: boolean }[] = [
  { name: "proso.ai", href: "https://proso.ai", tag: "Platform", dot: "bg-violet-400" },
  { name: "askproso.ai", href: "https://askproso.ai", tag: "Enterprise AI", dot: "bg-rose-400" },
  { name: "pay.askproso.ai", href: "https://pay.askproso.ai", tag: "India Payroll", dot: "bg-emerald-400" },
  { name: "workkudo.ai", href: "https://workkudo.ai", tag: "Culture", dot: "bg-orange-400" },
  { name: "workwall.com", href: "https://workwall.com", tag: "Culture", dot: "bg-sky-400" },
  { name: "intassist.askproso.ai", href: "/", tag: "You're here", dot: "bg-indigo-400", here: true },
];

const col = "space-y-2.5 text-sm";
const heading = "mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400";
const link = "text-slate-400 transition hover:text-white";

/** Dark site footer for the public pages (landing, terms, privacy). The app itself has no footer. */
export function SiteFooter() {
  return (
    <footer className="bg-[#111a30] text-slate-300">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 md:grid-cols-[1.3fr_1.3fr_1fr_1fr]">
        <div className="space-y-5">
          <p className="text-xl font-semibold text-white">Interview Assist</p>
          <p className="max-w-xs text-sm text-slate-400">A quiet second pair of ears for interviewers: live transcript, answer scoring and follow-up questions.</p>
          <a href="https://proso.ai" target="_blank" rel="noreferrer" className="block w-fit rounded-xl border border-slate-700 bg-[#18223b] px-4 py-3 transition hover:border-slate-500">
            <span className="block font-mono text-[11px] text-slate-400">Sponsored by</span>
            <span className="block text-lg font-semibold text-white">Proso<span className="text-rose-500">AI</span></span>
          </a>
        </div>

        <div>
          <h2 className={heading}>Proso ecosystem</h2>
          <ul className="space-y-3 text-sm">
            {ECOSYSTEM.map((e) => (
              <li key={e.name} className="flex items-center gap-3">
                <span className={`h-2 w-2 rounded-full ${e.dot}`} aria-hidden />
                {e.here ? <span className="text-white">{e.name}</span> : <a className="text-white hover:underline" href={e.href} target="_blank" rel="noreferrer">{e.name}</a>}
                <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${e.here ? "border-orange-500/60 bg-orange-500/10 text-orange-300" : "border-slate-700 bg-slate-800/60 text-slate-400"}`}>{e.tag}</span>
              </li>
            ))}
          </ul>
          <a className="mt-6 inline-block text-sm font-medium text-orange-400 hover:underline" href="https://proso.ai" target="_blank" rel="noreferrer">Explore Proso.ai ↗</a>
        </div>

        <div>
          <h2 className={heading}>Product</h2>
          <ul className={col}>
            <li><a className={link} href="/#how-it-works">How it works</a></li>
            <li><a className={link} href="/#consent">Consent &amp; recording</a></li>
            <li><a className={link} href={REPO} target="_blank" rel="noreferrer">Source on GitHub</a></li>
            <li><a className={link} href={`${REPO}/issues`} target="_blank" rel="noreferrer">Report a bug</a></li>
          </ul>
        </div>

        <div>
          <h2 className={heading}>Legal</h2>
          <ul className={col}>
            <li><Link className={link} to="/terms">Terms of Service</Link></li>
            <li><Link className={link} to="/privacy">Privacy Policy</Link></li>
            <li><a className={link} href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noreferrer">Apache License 2.0</a></li>
          </ul>
        </div>
      </div>

      <div className="border-t border-slate-800 bg-[#0b111c]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-2 px-6 py-5 text-sm text-slate-500">
          <p>© {new Date().getFullYear()} Interview Assist, sponsored by Proso.ai. Open source under the <a className="underline hover:text-slate-300" href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">Apache License 2.0</a>.</p>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link className="hover:text-slate-300" to="/terms">Terms of Service</Link>
            <Link className="hover:text-slate-300" to="/privacy">Privacy Policy</Link>
            <a className="hover:text-slate-300" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
