import { it } from "vitest";
import { InMemoryAiStore } from "../src/ai/configStore.js";
import { envModelFactory } from "../src/ai/models.js";
import type { TranscriptSegment } from "../src/meetingSource.js";
import { RoomService } from "../src/room/service.js";
import { InMemoryRoomStore, type RoomEvent } from "../src/room/types.js";
import { InMemoryStore } from "../src/store.js";

const script: [("interviewer" | "candidate"), string, number][] = [
  ["interviewer", "what kind of errors do you see with payment files in d365 and how do you fix them", 0],
  ["candidate", "so i've seen a lot of errors every day", 4],
  ["candidate", "and generally the payment file name was incorrectly added by the user", 3],
  ["interviewer", "is wrong answer", 2],
  ["candidate", "the obvious issues are the comment you have sent more text than required", 3],
  ["candidate", "about number is or amount is above the approval limit", 3],
  ["candidate", "or bank account is wrong and that's the most common one", 3],
  ["candidate", "you can log into the payment journal and then go to the payment status and see the error message there", 4],
  ["interviewer", "when you said bank account is wrong what specific places would you check first in d365", 4],
  ["candidate", "i would go to the vendor bank account and compare it with the invoice", 3],
];
/**
 * Live replay of a REAL two-person interview shape: the candidate talks in short fragments, the interviewer murmurs ("is wrong answer"),
 * then asks a real follow-up. Prints what the coach says and when. COSTS A FEW CENTS; only with LIVE_AI=1:
 *   LIVE_AI=1 node --env-file=.env node_modules/vitest/vitest.mjs run test/room.fragmented.live.test.ts --silent=false --reporter=verbose
 */
it.skipIf(!process.env.LIVE_AI)("fragmented speech", { timeout: 300_000 }, async () => {
  let clock = 1_000_000;
  const out: string[] = [];
  const store = new InMemoryStore();
  await store.save({ id: "i-1", alias: "K7M2QX9WPB", ownerEmail: "r@acme.com", status: "in_meeting" });
  const ai = new InMemoryAiStore();
  const room = new RoomService({ rooms: new InMemoryRoomStore(), transcripts: store, interviews: store, ai: { config: ai, log: ai, models: envModelFactory(process.env) }, now: () => clock });
  await room.configure({ interviewId: "i-1", roleTitle: "D365 Finance consultant", roleLevel: "senior", jd: "Dynamics 365 Finance: accounts payable, payment files, bank integration.", resumeSummary: "6 years D365 Finance. Implemented vendor payments and bank file formats for two clients.", presetQuestions: [] });
  let t = 0;
  room.bus.subscribe("i-1", (e: RoomEvent) => {
    if (e.type === "coach") { const d = e.data as { stance: string; remark: string; questions: { text: string; remark: string }[]; proof: { text: string } | null }; out.push(`[coach after segment ${t / 1000}s] ${d.stance.toUpperCase()} - ${d.remark}\n${d.questions.map((q) => `   ? ${q.text}  (${q.remark})`).join("\n")}${d.proof ? `\n   PROVE: ${d.proof.text}` : ""}`); }
    if (e.type === "score") out.push(`[score] ${(e.data as { output: { score: number } }).output.score}`);
  });
  for (const [role, text, gap] of script) {
    t += gap * 1000; clock += gap * 1000;
    const s: TranscriptSegment = { interviewId: "i-1", speakerId: role === "interviewer" ? "1" : "2", speakerName: role, role, text, isFinal: true, startMs: t, endMs: t + 2000 };
    await store.appendSegment(s); room.onSegment(s); await new Promise((r) => setTimeout(r, 100));
    room.tickAll();
    await room.idle("i-1");
  }
  clock += 4000; room.tickAll(); await room.idle("i-1");
  const answers = (await room.snapshot("i-1")).answers;
  out.push("answers: " + answers.map((a) => `${a.state} v${a.version} q="${a.questionText.slice(0, 50)}"`).join(" || "));
  await room.settle();
  console.log("\n" + out.join("\n"));
});
