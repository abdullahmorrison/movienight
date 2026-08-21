import { db, now } from './index.js';
import { config } from '../config.js';

export type Nomination = {
  id: number;
  title: string;
  nominated_by: string;
  nominator_login: string;
  created_at: number;
  interest: number;
  tmdb_id: number | null;
  year: number | null;
  poster_path: string | null;
  overview: string | null;
};

export type Tally = {
  nomination_id: number;
  title: string;
  approvals: number;
  year: number | null;
  poster_path: string | null;
};

/** What we store about a pick, whether it came from TMDB search or a typed title. */
export type MovieInput = {
  title: string;
  tmdbId?: number | null;
  year?: number | null;
  posterPath?: string | null;
  overview?: string | null;
};

/** Collapse punctuation/case/articles so "The Thing" and "the thing!" are one movie. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, '')
    .replace(/^(the|a|an)\s+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function upsertUser(id: string, login: string, displayName?: string): void {
  db.prepare(
    `INSERT INTO users (id, login, display_name, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET login = excluded.login,
                                   display_name = excluded.display_name,
                                   updated_at = excluded.updated_at`,
  ).run(id, login.toLowerCase(), displayName ?? login, now());
}

// --- nominations ---------------------------------------------------------

export type NominateResult =
  | { ok: true; id: number; title: string }
  | { ok: false; reason: 'cap' | 'locked' | 'duplicate'; detail?: string; id?: number };

export function nominate(channelId: string, movie: MovieInput, userId: string): NominateResult {
  const clean = movie.title.trim().replace(/\s+/g, ' ').slice(0, 160);
  // A TMDB id is the better identity: it keeps The Thing (1982) and
  // The Thing (2011) apart, which a normalised title cannot.
  const key = movie.tmdbId ? `tmdb:${movie.tmdbId}` : titleKey(clean);
  if (!key || key === 'tmdb:') return { ok: false, reason: 'duplicate', detail: 'Give me an actual title.' };

  const existing = db
    .prepare(
      `SELECT id FROM nominations
       WHERE channel_id = ? AND title_key = ? AND won_at IS NULL AND vetoed_at IS NULL`,
    )
    .get(channelId, key) as { id: number } | undefined;
  if (existing) return { ok: false, reason: 'duplicate', id: existing.id };

  const lockoutMs = config.rules.repeatLockoutWeeks * 7 * 24 * 60 * 60 * 1000;
  const recentWin = db
    .prepare(
      `SELECT won_at FROM nominations
       WHERE channel_id = ? AND title_key = ? AND won_at IS NOT NULL
       ORDER BY won_at DESC LIMIT 1`,
    )
    .get(channelId, key) as { won_at: number } | undefined;
  if (recentWin && now() - recentWin.won_at < lockoutMs) {
    const weeksLeft = Math.ceil((lockoutMs - (now() - recentWin.won_at)) / (7 * 24 * 3600 * 1000));
    return { ok: false, reason: 'locked', detail: `already won — back in ${weeksLeft}w` };
  }

  const mine = db
    .prepare(
      `SELECT COUNT(*) AS n FROM nominations
       WHERE channel_id = ? AND nominated_by = ? AND won_at IS NULL AND vetoed_at IS NULL`,
    )
    .get(channelId, userId) as { n: number };
  if (mine.n >= config.rules.nominationsPerUser) {
    return { ok: false, reason: 'cap', detail: `max ${config.rules.nominationsPerUser} live nominations` };
  }

  const info = db
    .prepare(
      `INSERT INTO nominations
         (channel_id, title, title_key, nominated_by, created_at, tmdb_id, year, poster_path, overview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      channelId,
      clean,
      key,
      userId,
      now(),
      movie.tmdbId ?? null,
      movie.year ?? null,
      movie.posterPath ?? null,
      (movie.overview ?? '').slice(0, 600) || null,
    );
  const id = Number(info.lastInsertRowid);

  // Nominating implies interest — otherwise your own pick starts at zero.
  addInterest(channelId, id, userId);
  return { ok: true, id, title: clean };
}

export function addInterest(channelId: string, nominationId: number, userId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO interest (channel_id, nomination_id, user_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(channelId, nominationId, userId, now());
}

/** Returns true if interest was added, false if it was removed. */
export function toggleInterest(channelId: string, nominationId: number, userId: string): boolean {
  const live = db
    .prepare(
      `SELECT id FROM nominations
       WHERE id = ? AND channel_id = ? AND won_at IS NULL AND vetoed_at IS NULL`,
    )
    .get(nominationId, channelId);
  if (!live) throw new Error('No such nomination');

  const removed = db
    .prepare(`DELETE FROM interest WHERE channel_id = ? AND nomination_id = ? AND user_id = ?`)
    .run(channelId, nominationId, userId);
  if (removed.changes > 0) return false;
  addInterest(channelId, nominationId, userId);
  return true;
}

export function listNominations(channelId: string, limit?: number): Nomination[] {
  return db
    .prepare(
      `SELECT n.id, n.title, n.nominated_by, u.login AS nominator_login, n.created_at,
              n.tmdb_id, n.year, n.poster_path, n.overview,
              COUNT(i.user_id) AS interest
       FROM nominations n
       JOIN users u ON u.id = n.nominated_by
       LEFT JOIN interest i ON i.nomination_id = n.id
       WHERE n.channel_id = ? AND n.won_at IS NULL AND n.vetoed_at IS NULL
       GROUP BY n.id
       ORDER BY interest DESC, n.created_at ASC
       ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    )
    .all(channelId) as Nomination[];
}

export function myInterest(channelId: string, userId: string): number[] {
  const rows = db
    .prepare(`SELECT nomination_id FROM interest WHERE channel_id = ? AND user_id = ?`)
    .all(channelId, userId) as { nomination_id: number }[];
  return rows.map((r) => r.nomination_id);
}

export function veto(channelId: string, nominationId: number, reason: string): boolean {
  const r = db
    .prepare(
      `UPDATE nominations SET vetoed_at = ?, veto_reason = ?
       WHERE id = ? AND channel_id = ? AND vetoed_at IS NULL AND won_at IS NULL`,
    )
    .run(now(), reason.slice(0, 200), nominationId, channelId);
  return r.changes > 0;
}

export function unveto(channelId: string, nominationId: number): boolean {
  const r = db
    .prepare(
      `UPDATE nominations SET vetoed_at = NULL, veto_reason = NULL
       WHERE id = ? AND channel_id = ? AND vetoed_at IS NOT NULL`,
    )
    .run(nominationId, channelId);
  return r.changes > 0;
}

export function recentWinners(channelId: string, limit = 10) {
  return db
    .prepare(
      `SELECT id, title, year, poster_path, won_at FROM nominations
       WHERE channel_id = ? AND won_at IS NOT NULL
       ORDER BY won_at DESC LIMIT ?`,
    )
    .all(channelId, limit) as {
    id: number;
    title: string;
    year: number | null;
    poster_path: string | null;
    won_at: number;
  }[];
}

// --- polls ---------------------------------------------------------------

export type Poll = {
  id: number;
  channel_id: string;
  status: 'open' | 'closed';
  opened_at: number;
  closes_at: number;
  closed_at: number | null;
  winner_nomination_id: number | null;
};

export function getOpenPoll(channelId: string): Poll | undefined {
  return db
    .prepare(`SELECT * FROM polls WHERE channel_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`)
    .get(channelId) as Poll | undefined;
}

export function getPoll(channelId: string, pollId: number): Poll | undefined {
  return db.prepare(`SELECT * FROM polls WHERE id = ? AND channel_id = ?`).get(pollId, channelId) as
    | Poll
    | undefined;
}

export function latestPoll(channelId: string): Poll | undefined {
  return db.prepare(`SELECT * FROM polls WHERE channel_id = ? ORDER BY id DESC LIMIT 1`).get(channelId) as
    | Poll
    | undefined;
}

export function openPoll(channelId: string, durationSeconds: number, size: number): Poll {
  if (getOpenPoll(channelId)) throw new Error('A poll is already open');
  const shortlist = listNominations(channelId, size);
  if (shortlist.length < 2) throw new Error('Need at least 2 nominations to run a poll');

  const opened = now();
  const closes = opened + durationSeconds * 1000;

  const tx = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO polls (channel_id, status, opened_at, closes_at) VALUES (?, 'open', ?, ?)`)
      .run(channelId, opened, closes);
    const pollId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO poll_options (poll_id, channel_id, nomination_id, position) VALUES (?, ?, ?, ?)`,
    );
    shortlist.forEach((n, i) => ins.run(pollId, channelId, n.id, i + 1));
    return pollId;
  });

  return getPoll(channelId, tx())!;
}

export function pollOptions(channelId: string, pollId: number) {
  return db
    .prepare(
      `SELECT o.position, n.id AS nomination_id, n.title, n.year, n.poster_path
       FROM poll_options o JOIN nominations n ON n.id = o.nomination_id
       WHERE o.poll_id = ? AND o.channel_id = ? ORDER BY o.position`,
    )
    .all(pollId, channelId) as {
    position: number;
    nomination_id: number;
    title: string;
    year: number | null;
    poster_path: string | null;
  }[];
}

/** Replaces the voter's whole ballot — approval voting, so many picks per voter. */
export function castBallot(
  channelId: string,
  pollId: number,
  userId: string,
  nominationIds: number[],
  source: 'web' | 'chat',
): number {
  const poll = getPoll(channelId, pollId);
  if (!poll || poll.status !== 'open') throw new Error('No poll is open');
  if (now() > poll.closes_at) throw new Error('Voting has closed');

  const valid = new Set(pollOptions(channelId, pollId).map((o) => o.nomination_id));
  const picks = [...new Set(nominationIds)].filter((id) => valid.has(id));

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ballots WHERE poll_id = ? AND channel_id = ? AND user_id = ?`).run(
      pollId,
      channelId,
      userId,
    );
    const ins = db.prepare(
      `INSERT INTO ballots (poll_id, channel_id, user_id, nomination_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const id of picks) ins.run(pollId, channelId, userId, id, source, now());
  });
  tx();
  return picks.length;
}

export function myBallot(channelId: string, pollId: number, userId: string): number[] {
  const rows = db
    .prepare(`SELECT nomination_id FROM ballots WHERE poll_id = ? AND channel_id = ? AND user_id = ?`)
    .all(pollId, channelId, userId) as { nomination_id: number }[];
  return rows.map((r) => r.nomination_id);
}

export function tally(channelId: string, pollId: number): Tally[] {
  return db
    .prepare(
      `SELECT o.nomination_id, n.title, n.year, n.poster_path, COUNT(b.user_id) AS approvals
       FROM poll_options o
       JOIN nominations n ON n.id = o.nomination_id
       LEFT JOIN ballots b ON b.nomination_id = o.nomination_id AND b.poll_id = o.poll_id
       WHERE o.poll_id = ? AND o.channel_id = ?
       GROUP BY o.nomination_id
       ORDER BY approvals DESC, n.created_at ASC`,
    )
    .all(pollId, channelId) as Tally[];
}

export function voterCount(channelId: string, pollId: number): number {
  const r = db
    .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM ballots WHERE poll_id = ? AND channel_id = ?`)
    .get(pollId, channelId) as { n: number };
  return r.n;
}

/** Closes the poll and marks the winner. Ties break toward the longest-waiting nomination. */
export function closePoll(channelId: string, pollId: number): Tally | null {
  const poll = getPoll(channelId, pollId);
  if (!poll || poll.status !== 'open') return null;

  const results = tally(channelId, pollId);
  const winner = results[0] ?? null;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE polls SET status = 'closed', closed_at = ?, winner_nomination_id = ?
       WHERE id = ? AND channel_id = ?`,
    ).run(now(), winner?.nomination_id ?? null, pollId, channelId);

    if (winner) {
      // Winner leaves the board; everyone else carries over with interest intact.
      db.prepare(`UPDATE nominations SET won_at = ? WHERE id = ? AND channel_id = ?`).run(
        now(),
        winner.nomination_id,
        channelId,
      );
    }
  });
  tx();
  return winner;
}

// --- sessions ------------------------------------------------------------

export function createSession(id: string, channelId: string, userId: string, ttlMs: number): void {
  db.prepare(
    `INSERT INTO sessions (id, channel_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, channelId, userId, now(), now() + ttlMs);
}

export function getSession(id: string, channelId: string) {
  return db
    .prepare(
      `SELECT s.user_id, u.login, u.display_name FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.channel_id = ? AND s.expires_at > ?`,
    )
    .get(id, channelId, now()) as { user_id: string; login: string; display_name: string } | undefined;
}

export function deleteSession(id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}
