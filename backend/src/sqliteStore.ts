import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MeetingPlatform } from "./invite.js";
import type { TranscriptSegment } from "./meetingSource.js";
import type { AiConfigStore, AiRun, AiRunLog, TaskOverride } from "./ai/configStore.js";
import type { RoomAnswer, RoomEvent, RoomEventType, RoomQuestion, RoomScore, RoomSetup, RoomStore } from "./room/types.js";
import type { InboundMessageLog, Interview, InterviewStatus, InterviewStore, TranscriptStore } from "./store.js";

/**
 * Schema versions, applied in order and tracked with SQLite's `PRAGMA user_version`.
 * Add a new entry for every schema change; never edit an old one once it has shipped.
 * (Moving to Postgres later: translate this SQL once, keep the table and column names.)
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE interviews (
        id                    TEXT PRIMARY KEY,
        alias                 TEXT NOT NULL UNIQUE,
        owner_email           TEXT NOT NULL,
        status                TEXT NOT NULL,
        join_url              TEXT,
        platform              TEXT,
        ical_uid              TEXT,
        starts_at             TEXT,
        recall_bot_id         TEXT,
        join_mode             TEXT,
        teams_conversation_id TEXT,
        recording_ok          INTEGER,
        recording_detail      TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX interviews_recall_bot_id ON interviews (recall_bot_id);

      CREATE TABLE transcript_segments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        interview_id TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
        speaker_id   TEXT NOT NULL,
        speaker_name TEXT,
        role         TEXT,
        text         TEXT NOT NULL,
        start_ms     INTEGER NOT NULL,
        end_ms       INTEGER,
        created_at   TEXT NOT NULL,
        UNIQUE (interview_id, speaker_id, start_ms)
      );
      CREATE INDEX transcript_segments_interview ON transcript_segments (interview_id, start_ms);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE inbound_messages (
        message_id  TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Operator overrides of the AI task settings (model, limits, kill switch). A missing row means "built-in default".
      CREATE TABLE ai_task_config (
        task       TEXT PRIMARY KEY,
        config     TEXT NOT NULL,           -- JSON of the overridden fields only
        updated_at TEXT NOT NULL
      );
      -- One row per AI call. Holds no prompts, transcripts or answers: only what ran, how fast, and the token counts.
      CREATE TABLE ai_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        task          TEXT NOT NULL,
        interview_id  TEXT,
        model         TEXT,
        ok            INTEGER NOT NULL,
        outcome       TEXT NOT NULL,
        attempts      TEXT NOT NULL,        -- JSON [{model, outcome, ms}]
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        ms            INTEGER NOT NULL
      );
      CREATE INDEX ai_runs_at ON ai_runs (at);
    `,
  },
  {
    version: 4,
    sql: `
      -- The live coaching room. JSON in "data" keeps the shape flexible while the product settles; the columns beside it are
      -- the ones we query by. Everything cascades with the interview (retention / deletion).
      CREATE TABLE room_setup (
        interview_id TEXT PRIMARY KEY REFERENCES interviews (id) ON DELETE CASCADE,
        data         TEXT NOT NULL
      );
      CREATE TABLE room_questions (
        id           TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
        data         TEXT NOT NULL
      );
      CREATE INDEX room_questions_interview ON room_questions (interview_id);
      CREATE TABLE room_answers (
        id           TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
        start_ms     INTEGER NOT NULL,
        data         TEXT NOT NULL
      );
      CREATE INDEX room_answers_interview ON room_answers (interview_id, start_ms);
      CREATE TABLE room_scores (
        answer_id    TEXT NOT NULL,
        version      INTEGER NOT NULL,
        interview_id TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
        data         TEXT NOT NULL,
        PRIMARY KEY (answer_id, version)
      );
      CREATE INDEX room_scores_interview ON room_scores (interview_id);
      -- Replay log for the live feed. seq is global but only ever compared within one interview.
      CREATE TABLE room_events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        interview_id TEXT NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
        type         TEXT NOT NULL,
        at           TEXT NOT NULL,
        data         TEXT NOT NULL
      );
      CREATE INDEX room_events_interview ON room_events (interview_id, seq);
    `,
  },
];

type Row = Record<string, string | number | null | bigint | Uint8Array>;
const s = (v: unknown) => (typeof v === "string" ? v : undefined);

function toInterview(r: Row): Interview {
  return {
    id: r.id as string,
    alias: r.alias as string,
    ownerEmail: r.owner_email as string,
    status: r.status as InterviewStatus,
    joinUrl: s(r.join_url),
    platform: s(r.platform) as MeetingPlatform | undefined,
    icalUid: s(r.ical_uid),
    startsAt: s(r.starts_at),
    recallBotId: s(r.recall_bot_id),
    joinMode: s(r.join_mode) as Interview["joinMode"],
    teamsConversationId: s(r.teams_conversation_id),
    recording: r.recording_ok === null ? undefined : { ok: Number(r.recording_ok) === 1, detail: s(r.recording_detail) },
  };
}

function toSegment(r: Row): TranscriptSegment {
  return {
    interviewId: r.interview_id as string,
    speakerId: r.speaker_id as string,
    speakerName: s(r.speaker_name),
    role: s(r.role) as TranscriptSegment["role"],
    text: r.text as string,
    isFinal: true, // only final segments are stored
    startMs: Number(r.start_ms),
    endMs: r.end_ms === null ? undefined : Number(r.end_ms),
  };
}

/**
 * SQLite persistence using Node's built-in `node:sqlite` (no native module to build).
 * One file, WAL mode (readers never block the writer, crash-safe). Fine for a single backend instance;
 * replace with a network database when running more than one.
 */
export class SqliteStore implements InterviewStore, TranscriptStore, InboundMessageLog, AiConfigStore, AiRunLog, RoomStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  get schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  private migrate() {
    for (const m of MIGRATIONS.filter((x) => x.version > this.schemaVersion).sort((a, b) => a.version - b.version)) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(m.sql);
        this.db.exec(`PRAGMA user_version = ${m.version}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw new Error(`schema migration ${m.version} failed: ${(e as Error).message}`);
      }
    }
  }

  // ---- interviews

  async findById(id: string) {
    const r = this.db.prepare("SELECT * FROM interviews WHERE id = ?").get(id) as Row | undefined;
    return r ? toInterview(r) : undefined;
  }
  async findByAlias(alias: string) {
    const r = this.db.prepare("SELECT * FROM interviews WHERE alias = ?").get(alias.toUpperCase()) as Row | undefined;
    return r ? toInterview(r) : undefined;
  }
  async findByBotId(botId: string) {
    const r = this.db.prepare("SELECT * FROM interviews WHERE recall_bot_id = ?").get(botId) as Row | undefined;
    return r ? toInterview(r) : undefined;
  }

  async save(i: Interview) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO interviews (id, alias, owner_email, status, join_url, platform, ical_uid, starts_at, recall_bot_id, join_mode,
                                 teams_conversation_id, recording_ok, recording_detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           alias = excluded.alias, owner_email = excluded.owner_email, status = excluded.status, join_url = excluded.join_url,
           platform = excluded.platform, ical_uid = excluded.ical_uid, starts_at = excluded.starts_at,
           recall_bot_id = excluded.recall_bot_id, join_mode = excluded.join_mode,
           teams_conversation_id = excluded.teams_conversation_id, recording_ok = excluded.recording_ok,
           recording_detail = excluded.recording_detail, updated_at = excluded.updated_at`,
      )
      .run(
        i.id,
        i.alias.toUpperCase(),
        i.ownerEmail,
        i.status,
        i.joinUrl ?? null,
        i.platform ?? null,
        i.icalUid ?? null,
        i.startsAt ?? null,
        i.recallBotId ?? null,
        i.joinMode ?? null,
        i.teamsConversationId ?? null,
        i.recording ? (i.recording.ok ? 1 : 0) : null,
        i.recording?.detail ?? null,
        now,
        now,
      );
  }

  // ---- transcript

  async appendSegment(seg: TranscriptSegment) {
    this.db
      .prepare(
        `INSERT INTO transcript_segments (interview_id, speaker_id, speaker_name, role, text, start_ms, end_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(interview_id, speaker_id, start_ms) DO NOTHING`,
      )
      .run(seg.interviewId, seg.speakerId, seg.speakerName ?? null, seg.role ?? null, seg.text, seg.startMs, seg.endMs ?? null, new Date().toISOString());
  }
  async listSegments(interviewId: string) {
    const rows = this.db
      .prepare("SELECT * FROM transcript_segments WHERE interview_id = ? ORDER BY start_ms, id")
      .all(interviewId) as Row[];
    return rows.map(toSegment);
  }
  async deleteSegments(interviewId: string) {
    this.db.prepare("DELETE FROM transcript_segments WHERE interview_id = ?").run(interviewId);
  }

  // ---- inbound e-mail de-duplication

  async hasMessageSeen(messageId: string) {
    return this.db.prepare("SELECT 1 FROM inbound_messages WHERE message_id = ?").get(messageId) !== undefined;
  }
  async markMessageSeen(messageId: string) {
    this.db
      .prepare("INSERT INTO inbound_messages (message_id, received_at) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING")
      .run(messageId, new Date().toISOString());
  }

  // ---- AI task configuration and run log

  async getOverrides() {
    const out: Record<string, TaskOverride> = {};
    for (const r of this.db.prepare("SELECT task, config FROM ai_task_config").all() as Row[]) out[r.task as string] = JSON.parse(r.config as string) as TaskOverride;
    return out;
  }
  async setOverride(task: string, patch: TaskOverride) {
    const merged = { ...(await this.getOverrides())[task], ...patch };
    this.db
      .prepare("INSERT INTO ai_task_config (task, config, updated_at) VALUES (?, ?, ?) ON CONFLICT(task) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at")
      .run(task, JSON.stringify(merged), new Date().toISOString());
  }
  async clearOverride(task: string) {
    this.db.prepare("DELETE FROM ai_task_config WHERE task = ?").run(task);
  }
  async record(run: AiRun) {
    this.db
      .prepare("INSERT INTO ai_runs (at, task, interview_id, model, ok, outcome, attempts, input_tokens, output_tokens, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.at, run.task, run.interviewId ?? null, run.model ?? null, run.ok ? 1 : 0, run.outcome, JSON.stringify(run.attempts), run.inputTokens, run.outputTokens, run.ms);
  }
  async recent(limit: number) {
    const rows = this.db.prepare("SELECT * FROM ai_runs ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(limit, 500))) as Row[];
    return rows.map((r): AiRun => ({
      at: r.at as string,
      task: r.task as string,
      interviewId: s(r.interview_id),
      model: s(r.model),
      ok: r.ok === 1,
      outcome: r.outcome as string,
      attempts: JSON.parse(r.attempts as string) as AiRun["attempts"],
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      ms: Number(r.ms),
    }));
  }

  // ---- coaching room

  async getSetup(interviewId: string) {
    const r = this.db.prepare("SELECT data FROM room_setup WHERE interview_id = ?").get(interviewId) as Row | undefined;
    return r ? (JSON.parse(r.data as string) as RoomSetup) : undefined;
  }
  async saveSetup(setup: RoomSetup) {
    this.db
      .prepare("INSERT INTO room_setup (interview_id, data) VALUES (?, ?) ON CONFLICT(interview_id) DO UPDATE SET data = excluded.data")
      .run(setup.interviewId, JSON.stringify(setup));
  }
  async saveQuestion(q: RoomQuestion) {
    this.db.prepare("INSERT INTO room_questions (id, interview_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(q.id, q.interviewId, JSON.stringify(q));
  }
  async deleteQuestions(interviewId: string, ids: string[]) {
    const del = this.db.prepare("DELETE FROM room_questions WHERE id = ? AND interview_id = ?");
    for (const id of ids) del.run(id, interviewId);
  }
  async listQuestions(interviewId: string) {
    // rowid order = creation order (an upsert keeps the row's position)
    return (this.db.prepare("SELECT data FROM room_questions WHERE interview_id = ? ORDER BY rowid").all(interviewId) as Row[]).map((r) => JSON.parse(r.data as string) as RoomQuestion);
  }
  async saveAnswer(a: RoomAnswer) {
    this.db
      .prepare("INSERT INTO room_answers (id, interview_id, start_ms, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, start_ms = excluded.start_ms")
      .run(a.id, a.interviewId, a.startMs, JSON.stringify(a));
  }
  async listAnswers(interviewId: string) {
    return (this.db.prepare("SELECT data FROM room_answers WHERE interview_id = ? ORDER BY start_ms").all(interviewId) as Row[]).map((r) => JSON.parse(r.data as string) as RoomAnswer);
  }
  async saveScore(sc: RoomScore) {
    this.db
      .prepare("INSERT INTO room_scores (answer_id, version, interview_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(answer_id, version) DO UPDATE SET data = excluded.data")
      .run(sc.answerId, sc.version, sc.interviewId, JSON.stringify(sc));
  }
  async listScores(interviewId: string) {
    return (this.db.prepare("SELECT data FROM room_scores WHERE interview_id = ? ORDER BY rowid").all(interviewId) as Row[]).map((r) => JSON.parse(r.data as string) as RoomScore);
  }
  async appendEvent(interviewId: string, type: RoomEventType, data: unknown) {
    const at = new Date().toISOString();
    const res = this.db.prepare("INSERT INTO room_events (interview_id, type, at, data) VALUES (?, ?, ?, ?)").run(interviewId, type, at, JSON.stringify(data));
    return { seq: Number(res.lastInsertRowid), at, type, data } as RoomEvent & { seq: number };
  }
  private toEvent(r: Row) {
    return { seq: Number(r.seq), at: r.at as string, type: r.type as RoomEventType, data: JSON.parse(r.data as string) as unknown };
  }
  async eventsAfter(interviewId: string, afterSeq: number, limit: number) {
    return (this.db.prepare("SELECT * FROM room_events WHERE interview_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(interviewId, afterSeq, limit) as Row[]).map((r) => this.toEvent(r));
  }
  async lastEvent(interviewId: string, type: RoomEventType) {
    const r = this.db.prepare("SELECT * FROM room_events WHERE interview_id = ? AND type = ? ORDER BY seq DESC LIMIT 1").get(interviewId, type) as Row | undefined;
    return r ? this.toEvent(r) : undefined;
  }
  async deleteRoom(interviewId: string) {
    for (const t of ["room_setup", "room_questions", "room_answers", "room_scores", "room_events"]) this.db.prepare(`DELETE FROM ${t} WHERE interview_id = ?`).run(interviewId);
  }

  // ---- operations

  /** Consistent snapshot of the live database into a new file (safe while the app is running). */
  backupTo(dest: string) {
    if (existsSync(dest)) throw new Error(`backup target already exists: ${dest}`);
    mkdirSync(dirname(dest), { recursive: true });
    this.db.prepare("VACUUM INTO ?").run(dest);
  }

  close() {
    this.db.close();
  }
}
