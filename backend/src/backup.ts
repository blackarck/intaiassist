/**
 * Backup CLI: writes a consistent snapshot of the SQLite database and keeps the newest N.
 *   node dist/backup.js [targetDir]        (DATABASE_PATH required; BACKUP_KEEP defaults to 7)
 * Run by deploy/backup-db.sh inside the container (cron on the VM).
 */
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteStore } from "./sqliteStore.js";

const dbPath = process.env.DATABASE_PATH;
if (!dbPath) {
  console.error("DATABASE_PATH is required");
  process.exit(1);
}
const dir = process.argv[2] ?? join(dirname(dbPath), "backups");
const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 7));

// YYYYMMDD-HHMMSS-mmm: unique even if run twice in the same second
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace("Z", "");
const file = join(dir, `intassist-${stamp}.db`);

const store = new SqliteStore(dbPath);
try {
  store.backupTo(file);
} finally {
  store.close();
}

const old = readdirSync(dir)
  .filter((f) => /^intassist-\d{8}-\d{6}(-\d{3})?\.db$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) rmSync(join(dir, f));
console.log(`backup written: ${file} (kept ${Math.min(keep, readdirSync(dir).length)}, removed ${old.length})`);
