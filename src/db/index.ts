import Database from 'better-sqlite3';
import { config } from '../config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  display_name  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nominations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  title         TEXT NOT NULL,
  title_key     TEXT NOT NULL,
  nominated_by  TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  vetoed_at     INTEGER,
  veto_reason   TEXT,
  won_at        INTEGER,
  tmdb_id       INTEGER,
  year          INTEGER,
  poster_path   TEXT,
  overview      TEXT
);

-- One live nomination per title per channel. Winners and vetoes drop out of
-- the constraint so a title can come back after its lockout expires.
CREATE UNIQUE INDEX IF NOT EXISTS nominations_live_title
  ON nominations(channel_id, title_key)
  WHERE won_at IS NULL AND vetoed_at IS NULL;

CREATE INDEX IF NOT EXISTS nominations_channel ON nominations(channel_id, created_at);

CREATE TABLE IF NOT EXISTS interest (
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  nomination_id INTEGER NOT NULL REFERENCES nominations(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (nomination_id, user_id)
);

CREATE INDEX IF NOT EXISTS interest_channel ON interest(channel_id);

CREATE TABLE IF NOT EXISTS polls (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id           TEXT NOT NULL REFERENCES channels(id),
  status               TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at            INTEGER NOT NULL,
  closes_at            INTEGER NOT NULL,
  closed_at            INTEGER,
  winner_nomination_id INTEGER REFERENCES nominations(id)
);

CREATE INDEX IF NOT EXISTS polls_channel ON polls(channel_id, opened_at);

CREATE TABLE IF NOT EXISTS poll_options (
  poll_id       INTEGER NOT NULL REFERENCES polls(id),
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  nomination_id INTEGER NOT NULL REFERENCES nominations(id),
  position      INTEGER NOT NULL,
  PRIMARY KEY (poll_id, nomination_id)
);

-- Approval voting: one row per (voter, movie they'd watch), so a voter has
-- many rows in one poll. Keyed on Twitch user id, which chat and OAuth share.
CREATE TABLE IF NOT EXISTS ballots (
  poll_id       INTEGER NOT NULL REFERENCES polls(id),
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  nomination_id INTEGER NOT NULL REFERENCES nominations(id),
  source        TEXT NOT NULL CHECK (source IN ('web', 'chat')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, nomination_id)
);

CREATE INDEX IF NOT EXISTS ballots_poll ON ballots(poll_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
`;

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

/** Adds columns to databases created before they existed. */
function addColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

addColumn('nominations', 'tmdb_id', 'INTEGER');
addColumn('nominations', 'year', 'INTEGER');
addColumn('nominations', 'poster_path', 'TEXT');
addColumn('nominations', 'overview', 'TEXT');

// Seed the one channel we serve.
db.prepare(
  `INSERT INTO channels (id, login, display_name, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET login = excluded.login`,
).run(config.channel.id, config.channel.login, config.channel.login, Date.now());

export function now(): number {
  return Date.now();
}
