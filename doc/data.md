# Data storage, backups, and the move to a cloud database

## What is stored, and where

SQLite, one file: `/data/intassist.db` inside the backend container, on the Docker volume `backend_data`
(on the VM: `/var/lib/docker/volumes/..._backend_data/_data`). Node's built-in `node:sqlite` is used, so there is no
native module to build. WAL mode: crash-safe, readers never block the writer.

| Table | Holds |
|---|---|
| `interviews` | One row per paid interview: alias, interviewer e-mail, meeting link and platform, start time, Recall bot id, status, recording result |
| `transcript_segments` | Final transcript utterances (speaker, role, text, timing). Partial utterances are never stored. Unique per (interview, speaker, start time), so Recall's at-least-once webhook retries cannot create duplicates |

The schema version is tracked with `PRAGMA user_version`; add a new entry to `MIGRATIONS` in `src/sqliteStore.ts` for every
change and never edit one that has shipped. Without `DATABASE_PATH` the server uses an in-memory store (tests, quick local runs).

## Designed for the move to a cloud database

Everything in the app talks to two interfaces in `src/store.ts`: `InterviewStore` and `TranscriptStore`. Every method is
async, so a network database drops in without touching callers. To move to Postgres (or Cosmos):

1. Write `PostgresStore implements InterviewStore, TranscriptStore` (keep the table and column names; the SQL in
   migration 1 translates directly).
2. Run `test/store.test.ts` against it: the contract suite (`contract(name, make)`) is the acceptance test, already run
   against both the in-memory and SQLite stores.
3. Pick the store in `server.ts` from `DATABASE_URL` (as it does for `DATABASE_PATH` today).
4. One-off copy of the SQLite file into the new database, then switch over.

A network database is also what allows running more than one backend instance; with SQLite there must be exactly one.

## Backups

- `deploy/backup-db.sh` (cron, 03:00 on the VM, installed by `deploy-backend.sh`) runs `dist/backup.js` in the container:
  a consistent snapshot (`VACUUM INTO`, safe while the app runs) into `/data/backups`, newest 7 kept.
- **These live on the same volume**, so they protect against corruption and mistakes, not against losing the VM or its disk.
  Copying them off the machine (Azure Blob) is a later step.
- Restore: stop the backend, copy the chosen `intassist-*.db` over `/data/intassist.db`, delete `intassist.db-wal` and
  `intassist.db-shm` if present, start the backend.

## Privacy

Transcripts contain interview content. There is no retention policy yet; `TranscriptStore.deleteSegments(interviewId)`
exists for retention and data-subject deletion and is not wired to anything. Decide a retention period before real use.
