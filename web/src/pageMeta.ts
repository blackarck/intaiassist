import { useEffect } from "react";

const ORIGIN = "https://intassist.askproso.ai";

interface Meta { title: string; description: string; path: string; index: boolean }

const LANDING: Meta = {
  title: "Interview Assist: AI interview assistant for Teams, Zoom and Google Meet",
  description: "Interview Assist joins your Teams, Zoom or Google Meet interview, transcribes it live, scores each candidate answer on correctness, depth, clarity and relevance, and suggests follow-up questions. Open source.",
  path: "/",
  index: true,
};

const PAGES: Record<string, Meta> = {
  "/terms": { title: "Terms of Service | Interview Assist", description: "Terms of Service for Interview Assist: consent to record, AI output, data handling, and use at your own risk.", path: "/terms", index: true },
  "/privacy": { title: "Privacy Policy | Interview Assist", description: "What interview data Interview Assist collects, who processes it (Recall.ai and AI providers), and how it is stored.", path: "/privacy", index: true },
};

function setTag(selector: string, create: () => HTMLElement, attr: string, value: string) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) document.head.appendChild((el = create()));
  el.setAttribute(attr, value);
}

/** The page is a single-page app, so the head tags in index.html are the landing page's; this keeps them right per route. */
export function usePageMeta(pathname: string, signedIn: boolean) {
  useEffect(() => {
    // The signed-in app (interviews, transcripts) is private and must never be indexed.
    const m = PAGES[pathname] ?? (signedIn ? { ...LANDING, title: "Interview Assist", path: pathname, index: false } : { ...LANDING, path: pathname === "/" ? "/" : "/" });
    document.title = m.title;
    setTag('meta[name="description"]', () => Object.assign(document.createElement("meta"), { name: "description" }), "content", m.description);
    setTag('meta[name="robots"]', () => Object.assign(document.createElement("meta"), { name: "robots" }), "content", m.index ? "index, follow, max-image-preview:large" : "noindex, nofollow");
    setTag('link[rel="canonical"]', () => Object.assign(document.createElement("link"), { rel: "canonical" }), "href", ORIGIN + m.path);
  }, [pathname, signedIn]);
}
