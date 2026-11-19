import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../src/meetingSource.js";
import { SqliteStore } from "../src/sqliteStore.js";
import { InMemoryStore, type Interview, type InterviewStore, type TranscriptStore } from "../src/store.js";

const base: Interview = { id: "i-1", alias: "7KQ2", ownerEmail: "r@acme.com", status: "paid" };
const seg = (over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  interviewId: "i-1",
  speakerId: "100",
  speakerName: "Asha",
  role: "candidate",
  text: "I built it",
  isFinal: true,
  startMs: 1500,
  endMs: 3000,
  ...over,
});

/**
 * One contract, run against every store implementation. A future Postgres/Cosmos store must pass this unchanged.
 */
function contract(name: string, make: () => InterviewStore & TranscriptStore) {
  describe(`store contract: ${name}`, () => {
    it("returns undefined for unknown ids, aliases and bot ids", async () => {
      const s = make();
      expect(await s.findById("nope")).toBeUndefined();
      expect(await s.findByAlias("NOPE")).toBeUndefined();
      expect(await s.findByBotId("nope")).toBeUndefined();
    });

    it("round-trips every field", async () => {
      const s = make();
      const full: Interview = {
        ...base,
        status: "scheduled",
        joinUrl: "https://meet.google.com/abc-defg-hij",
        platform: "meet",
        icalUid: "uid-1",
        startsAt: "2026-11-20T10:00:00Z",
        recallBotId: "bot-1",
        joinMode: "scheduled",
        teamsConversationId: "19:abc",
        recording: { ok: false, detail: "zoom_local_recording_denied" },
      };
      await s.save(full);
      expect(await s.findById("i-1")).toEqual(full);
    });

    it("finds by alias (case-insensitive) and by bot id", async () => {
      const s = make();
      await s.save({ ...base, recallBotId: "bot-9" });
      expect((await s.findByAlias("7kq2"))?.id).toBe("i-1");
      expect((await s.findByBotId("bot-9"))?.id).toBe("i-1");
    });

    it("updates in place when saved again and can clear optional fields", async () => {
      const s = make();
      await s.save({ ...base, joinUrl: "https://meet.google.com/abc-defg-hij", recording: { ok: true } });
      await s.save({ ...base, status: "in_meeting" });
      const got = await s.findById("i-1");
      expect(got?.status).toBe("in_meeting");
      expect(got?.joinUrl).toBeUndefined();
      expect(got?.recording).toBeUndefined();
    });

    it("distinguishes recording ok=true from not reported", async () => {
      const s = make();
      await s.save({ ...base, recording: { ok: true } });
      expect((await s.findById("i-1"))?.recording).toEqual({ ok: true });
    });

    it("refuses to give one alias to two interviews", async () => {
      const s = make();
      await s.save(base);
      await expect(s.save({ ...base, id: "i-2" })).rejects.toThrow();
      expect((await s.findByAlias("7KQ2"))?.id).toBe("i-1");
    });

    it("stores transcript segments in time order and ignores duplicates (webhook retries)", async () => {
      const s = make();
      await s.save(base);
      await s.appendSegment(seg({ speakerId: "2", startMs: 9000, text: "later" }));
      await s.appendSegment(seg({ startMs: 1500, text: "first" }));
      await s.appendSegment(seg({ startMs: 1500, text: "first" })); // retried delivery
      const list = await s.listSegments("i-1");
      expect(list.map((x) => x.text)).toEqual(["first", "later"]);
      expect(list[0]).toMatchObject({ speakerId: "100", speakerName: "Asha", role: "candidate", endMs: 3000, isFinal: true });
    });

    it("handles segments without optional fields", async () => {
      const s = make();
      await s.save(base);
      await s.appendSegment(seg({ speakerName: undefined, role: undefined, endMs: undefined }));
      const [got] = await s.listSegments("i-1");
      expect(got?.speakerName).toBeUndefined();
      expect(got?.role).toBeUndefined();
      expect(got?.endMs).toBeUndefined();
    });

    it("keeps transcripts per interview and deletes only the requested one", async () => {
      const s = make();
      await s.save(base);
      await s.save({ ...base, id: "i-2", alias: "ZZZ9" });
      await s.appendSegment(seg());
      await s.appendSegment(seg({ interviewId: "i-2" }));
      await s.deleteSegments("i-1");
      expect(await s.listSegments("i-1")).toEqual([]);
      expect(await s.listSegments("i-2")).toHaveLength(1);
    });
  });
}

contract("InMemoryStore", () => new InMemoryStore());
contract("SqliteStore (:memory:)", () => new SqliteStore(":memory:"));

describe("SqliteStore specifics", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "intassist-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("keeps data across a restart (close and reopen the file)", async () => {
    const file = join(tmp(), "nested", "db.sqlite"); // parent directory is created
    const a = new SqliteStore(file);
    await a.save({ ...base, recallBotId: "bot-1", status: "in_meeting" });
    await a.appendSegment(seg());
    a.close();

    const b = new SqliteStore(file);
    expect((await b.findByBotId("bot-1"))?.status).toBe("in_meeting");
    expect(await b.listSegments("i-1")).toHaveLength(1);
    b.close();
  });

  it("applies migrations once and is safe to reopen", () => {
    const file = join(tmp(), "db.sqlite");
    const a = new SqliteStore(file);
    expect(a.schemaVersion).toBe(1);
    a.close();
    const b = new SqliteStore(file);
    expect(b.schemaVersion).toBe(1);
    b.close();
  });

  it("uses WAL mode on a file database", () => {
    const file = join(tmp(), "db.sqlite");
    new SqliteStore(file).close();
    const raw = new DatabaseSync(file);
    expect((raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    raw.close();
  });

  it("enforces foreign keys: a segment for an unknown interview is rejected", async () => {
    const s = new SqliteStore(":memory:");
    await expect(s.appendSegment(seg({ interviewId: "ghost" }))).rejects.toThrow();
  });

  it("writes a restorable backup and refuses to overwrite one", async () => {
    const dir = tmp();
    const s = new SqliteStore(join(dir, "live.sqlite"));
    await s.save({ ...base, recallBotId: "bot-1" });
    await s.appendSegment(seg());

    const copy = join(dir, "backups", "snap.db");
    s.backupTo(copy);
    expect(existsSync(copy)).toBe(true);
    expect(() => s.backupTo(copy)).toThrow(/already exists/);

    const restored = new SqliteStore(copy);
    expect((await restored.findById("i-1"))?.recallBotId).toBe("bot-1");
    expect(await restored.listSegments("i-1")).toHaveLength(1);
    restored.close();
    s.close();
  });

  it("rolls a failed migration back and reports it", () => {
    const file = join(tmp(), "db.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE interviews (x INTEGER)"); // collides with migration 1's CREATE TABLE
    raw.close();
    expect(() => new SqliteStore(file)).toThrow(/migration 1 failed/);
  });
});
