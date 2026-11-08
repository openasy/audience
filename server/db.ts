import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- One row per person. sources lists every source that sent something about them, space-separated.
   CREATE TABLE profiles (
     id TEXT PRIMARY KEY,
     name TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_at TEXT,
     first_source TEXT NOT NULL,
     sources TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX profiles_last ON profiles (last_at DESC, id);
   CREATE INDEX profiles_created ON profiles (created_at);
   -- How a person is known: email, phone and your user id, and nothing else. Within the kinds the file matches by, a
   -- value belongs to one profile only; the code that matches keeps it so.
   CREATE TABLE identifiers (
     kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'user_id')),
     value TEXT NOT NULL,
     profile TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
     added_at TEXT NOT NULL,
     source TEXT NOT NULL,
     PRIMARY KEY (kind, value, profile)
   ) WITHOUT ROWID;
   CREATE INDEX identifiers_profile ON identifiers (profile, kind);
   -- Traits as the file declares them. value is the text form, num the number for number traits, folded the value
   -- lowercased for comparisons that ignore case.
   CREATE TABLE traits (
     profile TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     num REAL,
     folded TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     source TEXT NOT NULL,
     PRIMARY KEY (profile, key)
   ) WITHOUT ROWID;
   CREATE INDEX traits_value ON traits (key, folded);
   -- The timeline. external is the source's own id for the event, so the same event sent twice is kept once.
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     profile TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
     source TEXT NOT NULL,
     type TEXT NOT NULL,
     at TEXT NOT NULL,
     text TEXT,
     props TEXT,
     external TEXT,
     recorded_at TEXT NOT NULL
   );
   CREATE INDEX events_rule ON events (profile, type, at);
   CREATE INDEX events_timeline ON events (profile, at DESC, id DESC);
   CREATE INDEX events_at ON events (at);
   CREATE UNIQUE INDEX events_external ON events (source, external) WHERE external IS NOT NULL;
   -- Events per day and source, for the overview; they name nobody, so they stay when a person is deleted.
   CREATE TABLE daily (day TEXT NOT NULL, source TEXT NOT NULL, events INTEGER NOT NULL, PRIMARY KEY (day, source)) WITHOUT ROWID;
   -- Two profiles that turned out to be one person: from is gone, into is the person now.
   CREATE TABLE merges (id INTEGER PRIMARY KEY, from_profile TEXT NOT NULL, into_profile TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL);
   CREATE INDEX merges_from ON merges (from_profile);
   CREATE INDEX merges_at ON merges (at);
   -- Analytics visitors that are a profile, so their visits are read once and deleted with the person.
   CREATE TABLE analytics_visitors (
     site TEXT NOT NULL,
     visitor TEXT NOT NULL,
     profile TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
     PRIMARY KEY (site, visitor)
   ) WITHOUT ROWID;
   CREATE INDEX analytics_visitors_profile ON analytics_visitors (profile);
   CREATE TABLE source_state (source TEXT PRIMARY KEY, cursor TEXT, last_at TEXT, last_ok_at TEXT, error TEXT, read INTEGER NOT NULL DEFAULT 0);

   CREATE TABLE segments (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT,
     rules TEXT NOT NULL,
     owner TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     size INTEGER NOT NULL DEFAULT 0,
     counted_at TEXT
   );
   -- Who is in each segment now, and since when; kept up to date as events come in and counted again on a timer for
   -- rules with a period, which change as days pass.
   CREATE TABLE segment_members (
     segment TEXT NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
     profile TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
     since TEXT NOT NULL,
     PRIMARY KEY (segment, profile)
   ) WITHOUT ROWID;
   CREATE INDEX segment_members_profile ON segment_members (profile);
   CREATE TABLE segment_changes (
     id INTEGER PRIMARY KEY,
     segment TEXT NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
     profile TEXT NOT NULL,
     change TEXT NOT NULL CHECK (change IN ('joined', 'left')),
     at TEXT NOT NULL
   );
   CREATE INDEX segment_changes_at ON segment_changes (segment, id);
   CREATE INDEX segment_changes_profile ON segment_changes (profile);
   CREATE TABLE segment_sizes (
     segment TEXT NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
     day TEXT NOT NULL,
     size INTEGER NOT NULL,
     PRIMARY KEY (segment, day)
   ) WITHOUT ROWID;
   -- Who reads a segment's members, such as Messages with its token, and when they last did.
   CREATE TABLE segment_readers (
     segment TEXT NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
     actor TEXT NOT NULL,
     last_at TEXT NOT NULL,
     reads INTEGER NOT NULL,
     PRIMARY KEY (segment, actor)
   ) WITHOUT ROWID;

   -- A CSV kept from its upload until it is imported or discarded; afterwards only the counts stay.
   CREATE TABLE imports (
     id TEXT PRIMARY KEY,
     file TEXT NOT NULL,
     actor TEXT NOT NULL,
     uploaded_at TEXT NOT NULL,
     rows INTEGER NOT NULL,
     columns TEXT NOT NULL,
     data BLOB,
     state TEXT NOT NULL CHECK (state IN ('uploaded', 'done', 'discarded')),
     mapping TEXT,
     created INTEGER,
     matched INTEGER,
     skipped INTEGER,
     done_at TEXT
   );

   -- Deletions on request: the reference, when and by whom, and how much was deleted, never who.
   CREATE TABLE deletions (
     id TEXT PRIMARY KEY,
     reference TEXT NOT NULL,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     profiles INTEGER NOT NULL,
     events INTEGER NOT NULL
   );
   CREATE TRIGGER deletions_fixed BEFORE UPDATE ON deletions BEGIN SELECT RAISE(ABORT, 'the deletion log is never changed'); END;
   CREATE TRIGGER deletions_kept BEFORE DELETE ON deletions BEGIN SELECT RAISE(ABORT, 'the deletion log is never deleted'); END;
   -- Each linked product's part of a deletion. people holds the identifiers the product needs until it is done, and
   -- is then cleared, so the log keeps no one's data.
   CREATE TABLE deletion_tasks (
     deletion TEXT NOT NULL REFERENCES deletions (id),
     product TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'waiting', 'done', 'failed')),
     people TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at TEXT NOT NULL,
     detail TEXT,
     deleted INTEGER,
     done_at TEXT,
     PRIMARY KEY (deletion, product)
   ) WITHOUT ROWID;
   CREATE INDEX deletion_tasks_due ON deletion_tasks (state, next_at);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
