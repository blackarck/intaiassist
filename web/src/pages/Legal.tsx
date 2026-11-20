import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { SiteFooter } from "../components/SiteFooter";

const UPDATED = "20 November 2026";

function Page({ title, children }: { title: string; children: ReactNode }) {
  const { status } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
        <Link to="/" className="font-semibold tracking-tight">Interview Assist</Link>
        <Link to="/" className="btn-ghost">{status === "signedIn" ? "Back to interviews" : "Home"}</Link>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 pb-16 pt-6 text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="muted">Last updated {UPDATED}</p>
        {children}
        <p className="muted pt-6">This page is a plain-language summary and not legal advice. Have it reviewed by a lawyer for your jurisdiction before relying on it.</p>
      </main>
      <SiteFooter />
    </div>
  );
}

export function TermsPage() {
  return (
    <Page title="Terms of Service">
      <p>These terms govern your use of Interview Assist (the “Service”). By signing in or using the Service you agree to them. If you do not agree, do not use the Service.</p>

      <h2>1. What the Service does</h2>
      <p>The Service sends a meeting bot to a video call you choose, transcribes the conversation, and uses AI to assess candidate answers and suggest follow-up questions to the interviewer. It is an aid to your judgement, not a decision-maker.</p>

      <h2>2. Consent and notice — your responsibility</h2>
      <ul>
        <li>The bot appears as a participant and the meeting is recorded and transcribed. You must <strong>announce this to every participant and obtain their permission before using the Service</strong>, and before the bot is admitted to the meeting.</li>
        <li>You must admit the bot to the meeting for the Service to work.</li>
        <li>You are solely responsible for complying with all laws on recording, wiretapping, privacy, employment, anti-discrimination and automated decision-making that apply to you and to the people you interview, including any required notices or consents.</li>
        <li>Do not use the Service on anyone who has not been informed or who objects.</li>
      </ul>

      <h2>3. Data we and our providers collect and store</h2>
      <ul>
        <li>We collect and store interview data: meeting details, audio-derived transcripts, AI assessments, scores, questions and notes, and your account details.</li>
        <li>Our meeting-bot and recording provider, Recall.ai, processes and stores meeting data under its own terms and privacy policy.</li>
        <li>Transcripts are analysed by AI models, and results are stored in our private AI cloud.</li>
        <li>See the <Link className="underline" to="/privacy">Privacy Policy</Link> for more.</li>
      </ul>

      <h2>4. AI output may be wrong</h2>
      <p>Scores, assessments and suggested questions are generated automatically and can be inaccurate, incomplete or biased. Transcription can contain errors. Do not rely on them as the sole basis for any hiring decision. Humans must make and own every hiring decision.</p>

      <h2>5. Use at your own risk</h2>
      <p>The Service is provided “as is” and “as available”, without warranties of any kind, express or implied, including accuracy, availability, fitness for a purpose and non-infringement. You use the Service entirely at your own risk.</p>

      <h2>6. Limitation of liability</h2>
      <p>To the fullest extent permitted by law, we are not liable for any loss or damage arising from your use of the Service, including loss, corruption, deletion or unauthorised disclosure of data or recordings, failure of the bot to join or record, inaccurate AI output, hiring decisions, legal claims from participants, or the actions of third-party providers. Our total liability is limited to the amount you paid us for the Service in the three months before the claim, or zero if the Service was free. We do not guarantee that data will be retained or recoverable; keep your own copies of anything important.</p>

      <h2>7. Indemnity</h2>
      <p>You agree to indemnify us against claims, losses and costs arising from your use of the Service, including any failure to give notice to or obtain consent from meeting participants.</p>

      <h2>8. Acceptable use</h2>
      <p>Do not use the Service unlawfully, to discriminate, to record people without proper consent, to attempt to disrupt or reverse-engineer it, or to upload content you have no right to use.</p>

      <h2>9. Accounts, changes and termination</h2>
      <p>You sign in with a Microsoft account and are responsible for activity under it. We may change, suspend or end the Service, or these terms, at any time. Continued use after a change means you accept it.</p>

      <h2>10. Contact</h2>
      <p>Questions about these terms can be sent to the administrator of your Interview Assist workspace.</p>
    </Page>
  );
}

export function PrivacyPage() {
  return (
    <Page title="Privacy Policy">
      <p>This policy explains what information Interview Assist collects when you or your team use the Service, and how it is handled.</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account data:</strong> your name, email address and Microsoft account identifier from sign-in.</li>
        <li><strong>Interview data:</strong> the meeting link, schedule and any role or notes you enter; the live transcript of the meeting, including what candidates and other participants say and their display names; recordings or audio processed to produce the transcript.</li>
        <li><strong>AI-generated data:</strong> assessments, scores, suggested questions and summaries produced from the transcript.</li>
        <li><strong>Calendar data:</strong> if you grant the optional calendar permission, upcoming meetings read from your Microsoft calendar so you can pick one.</li>
        <li><strong>Technical data:</strong> logs and basic device and browser information needed to run and secure the Service.</li>
      </ul>

      <h2>How we use it</h2>
      <p>To send the bot to your meeting, show you the transcript and coaching, store your interview history, operate and secure the Service, and improve its reliability. We do not sell your data.</p>

      <h2>Who processes it</h2>
      <ul>
        <li><strong>Recall.ai</strong> provides the meeting bot, recording and transcription, and stores meeting data under its own terms and privacy policy.</li>
        <li><strong>AI models</strong> analyse transcripts to produce assessments. Results and interview data are stored in our private AI cloud.</li>
        <li><strong>Microsoft</strong> provides sign-in and, optionally, calendar access.</li>
        <li>Hosting and infrastructure providers that run the Service on our behalf.</li>
      </ul>

      <h2>Consent of people on the call</h2>
      <p>The interviewer using the Service is responsible for telling the candidate and all other participants that the meeting will be recorded, transcribed and analysed by AI, and for obtaining their permission beforehand. We do not contact participants directly. A bot is visible in the participant list while it is in the meeting.</p>

      <h2>Retention and deletion</h2>
      <p>Interview data is kept while it is needed to provide the Service unless deleted. We make no guarantee that data will be retained, backed up or recoverable, and we are not responsible for its loss. To request access to or deletion of data, contact your workspace administrator. Data held by Recall.ai may be subject to its own retention rules.</p>

      <h2>Security</h2>
      <p>We use reasonable safeguards, but no system is completely secure. We are not responsible for loss, theft or unauthorised access to data despite those safeguards.</p>

      <h2>Your rights</h2>
      <p>Depending on where you live, you may have rights to access, correct, delete or export your data, or to object to its processing. Contact your workspace administrator to exercise them.</p>

      <h2>Changes</h2>
      <p>We may update this policy and will change the date above when we do.</p>
    </Page>
  );
}
