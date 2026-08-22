/**
 * Boots against a database written by the FIRST version of this app and checks
 * that it comes up with the current schema and its data intact.
 *
 * smoke.ts and api-test.ts both start from an empty file, so neither of them
 * runs a single ALTER TABLE — which is how a startup crash on an existing
 * database reached a running server unnoticed.
 *
 * Run: npm run test:migration
 */
const DB = './migration-test.db';
process.env.DB_PATH = DB;
process.env.SESSION_SECRET = 'migration-test';
process.env.TWITCH_CLIENT_ID = 'test';
process.env.TWITCH_CLIENT_SECRET = 'test';
process.env.CHANNEL_ID = '7000';
process.env.CHANNEL_LOGIN = 'oldchannel';
process.env.BOT_ENABLED = 'false';

import fs from 'node:fs';
import Database from 'better-sqlite3';

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// The original schema: no avatars, no TMDB columns, no outcome, no withdrawals.
const V1 = `
CREATE TABLE channels (id TEXT PRIMARY KEY, login TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, login TEXT NOT NULL, display_name TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE nominations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, title TEXT NOT NULL,
  title_key TEXT NOT NULL, nominated_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  vetoed_at INTEGER, veto_reason TEXT, won_at INTEGER);
CREATE UNIQUE INDEX nominations_live_title ON nominations(channel_id, title_key)
  WHERE won_at IS NULL AND vetoed_at IS NULL;
CREATE TABLE interest (channel_id TEXT NOT NULL, nomination_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (nomination_id, user_id));
CREATE TABLE polls (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')), opened_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL, closed_at INTEGER, winner_nomination_id INTEGER);
CREATE TABLE poll_options (poll_id INTEGER NOT NULL, channel_id TEXT NOT NULL,
  nomination_id INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (poll_id, nomination_id));
CREATE TABLE ballots (poll_id INTEGER NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
  nomination_id INTEGER NOT NULL, source TEXT NOT NULL CHECK (source IN ('web','chat')),
  created_at INTEGER NOT NULL, PRIMARY KEY (poll_id, user_id, nomination_id));
CREATE TABLE sessions (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

const seed = new Database(DB);
seed.exec(V1);
const t = Date.now();
seed.prepare(`INSERT INTO channels VALUES (?,?,?,?)`).run('7000', 'oldchannel', 'oldchannel', t);
seed.prepare(`INSERT INTO users VALUES (?,?,?,?)`).run('7001', 'veteran', 'Veteran', t);
seed
  .prepare(`INSERT INTO nominations (channel_id,title,title_key,nominated_by,created_at) VALUES (?,?,?,?,?)`)
  .run('7000', 'The Thing', 'thing', '7001', t);
seed.prepare(`INSERT INTO interest VALUES (?,?,?,?)`).run('7000', 1, '7001', t);
seed.close();

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     expected ${e}\n     got      ${a}`}`);
}

console.log('\n— booting on a first-version database —');

// Importing this is what runs the migrations; a throw here is the failure.
const { db } = await import('../src/db/index.js');
const q = await import('../src/db/queries.js');
console.log('✅ the schema loads without throwing');

const nominationCols = (db.prepare(`PRAGMA table_info(nominations)`).all() as { name: string }[]).map((c) => c.name);
for (const col of ['tmdb_id', 'year', 'poster_path', 'backdrop_path', 'trailer_key', 'overview', 'withdrawn_at']) {
  check(`nominations.${col} was added`, nominationCols.includes(col), true);
}
const userCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
check('users.avatar_url was added', userCols.includes('avatar_url'), true);
const pollCols = (db.prepare(`PRAGMA table_info(polls)`).all() as { name: string }[]).map((c) => c.name);
check('polls.outcome was added', pollCols.includes('outcome'), true);
check('polls.dismissed_at was added', pollCols.includes('dismissed_at'), true);

// The old index would keep a withdrawn title from ever being nominated again.
const idx = db
  .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='nominations_live_title'`)
  .get() as { sql: string } | undefined;
check('the live-title index was rebuilt with the new predicate',
  Boolean(idx && idx.sql.includes('withdrawn_at IS NULL')), true);

console.log('\n— the data that was already there —');
const board = q.listNominations('7000');
check('the old nomination survived', board.map((n) => n.title), ['The Thing']);
check('with its interest', board[0]?.interest, 1);
check('and reads back through the current queries', board[0]?.tmdb_id ?? null, null);

console.log('\n— and it still works —');
check('nominating on the migrated database', q.nominate('7000', { title: 'Heat' }, '7001').ok, true);
check('withdrawing uses the new column', q.withdrawNomination('7000', board[0]!.id, '7001'), 'ok');
check('which frees the title', q.nominate('7000', { title: 'The Thing' }, '7001').ok, true);

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log(failures === 0 ? '\n🎉 migration checks passed\n' : `\n💥 ${failures} migration check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
