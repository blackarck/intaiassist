import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MeetingPlatform } from "./invite.js";
import type { TranscriptSegment } from "./meetingSource.js";
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
export class SqliteStore implements InterviewStore, TranscriptStore, InboundMessageLog {
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
