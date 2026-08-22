import { db, now } from './index.js';
import { config } from '../config.js';

export type Nomination = {
  id: number;
  title: string;
  reached_at: number;
  nominated_by: string;
  nominator_login: string;
  created_at: number;
  interest: number;
  /** Backers other than the nominator; while zero, it uses one of their slots. */
  others_interest: number;
  tmdb_id: number | null;
  year: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  trailer_key: string | null;
  overview: string | null;
};

export type Tally = {
  nomination_id: number;
  title: string;
  votes: number;
  reached_at: number;
  year: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  trailer_key: string | null;
  overview: string | null;
};

/** What we store about a pick, whether it came from TMDB search or a typed title. */
export type MovieInput = {
  title: string;
  tmdbId?: number | null;
  year?: number | null;
  posterPath?: string | null;
  backdropPath?: string | null;
  trailerKey?: string | null;
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

export function upsertUser(
  id: string,
  login: string,
  displayName?: string,
  avatarUrl?: string | null,
): void {
  db.prepare(
    `INSERT INTO users (id, login, display_name, avatar_url, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET login = excluded.login,
                                   display_name = excluded.display_name,
                                   -- Chat messages carry no avatar; keep the one
                                   -- we already have rather than blanking it.
                                   avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
                                   updated_at = excluded.updated_at`,
  ).run(id, login.toLowerCase(), displayName ?? login, avatarUrl ?? null, now());
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
       WHERE channel_id = ? AND title_key = ? AND won_at IS NULL AND vetoed_at IS NULL AND withdrawn_at IS NULL`,
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

  // Only nominations nobody else has backed count against the allowance. Once
  // chat wants it, it belongs to the board rather than to whoever typed it, so
  // holding a slot hostage would leave people stuck at the cap.
  const mine = db
    .prepare(
      `SELECT COUNT(*) AS n FROM nominations n
       WHERE n.channel_id = ? AND n.nominated_by = ?
         AND n.won_at IS NULL AND n.vetoed_at IS NULL AND n.withdrawn_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM interest i
           WHERE i.nomination_id = n.id AND i.user_id <> n.nominated_by
         )`,
    )
    .get(channelId, userId) as { n: number };
  if (mine.n >= config.rules.nominationsPerUser) {
    return { ok: false, reason: 'cap', detail: `max ${config.rules.nominationsPerUser} live nominations` };
  }

  const info = db
    .prepare(
      `INSERT INTO nominations
         (channel_id, title, title_key, nominated_by, created_at,
          tmdb_id, year, poster_path, backdrop_path, trailer_key, overview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      movie.backdropPath ?? null,
      movie.trailerKey ?? null,
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
       WHERE id = ? AND channel_id = ? AND won_at IS NULL AND vetoed_at IS NULL AND withdrawn_at IS NULL`,
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
              n.tmdb_id, n.year, n.poster_path, n.backdrop_path, n.trailer_key, n.overview,
              COUNT(i.user_id) AS interest,
              SUM(CASE WHEN i.user_id IS NOT NULL AND i.user_id <> n.nominated_by THEN 1 ELSE 0 END)
                AS others_interest,
              COALESCE(MAX(i.created_at), n.created_at) AS reached_at
       FROM nominations n
       JOIN users u ON u.id = n.nominated_by
       LEFT JOIN interest i ON i.nomination_id = n.id
       WHERE n.channel_id = ? AND n.won_at IS NULL AND n.vetoed_at IS NULL AND n.withdrawn_at IS NULL
       GROUP BY n.id
       -- Ties keep their existing order: the one that reached the count first
       -- stays ahead, so catching up never overtakes.
       ORDER BY interest DESC, reached_at ASC, n.id ASC
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

export type WithdrawResult = 'ok' | 'missing' | 'not-yours' | 'backed';

/**
 * Lets someone take back a nomination to free up their allowance. The one limit
 * is other people: once anybody else has backed it, it belongs to the board.
 *
 * Marked rather than deleted — past polls reference it, and a movie that lost a
 * vote is exactly the kind of thing someone wants their slot back from.
 */
export function withdrawNomination(
  channelId: string,
  nominationId: number,
  userId: string,
): WithdrawResult {
  const nom = db
    .prepare(
      `SELECT nominated_by FROM nominations
       WHERE id = ? AND channel_id = ? AND won_at IS NULL AND vetoed_at IS NULL AND withdrawn_at IS NULL`,
    )
    .get(nominationId, channelId) as { nominated_by: string } | undefined;
  if (!nom) return 'missing';
  if (nom.nominated_by !== userId) return 'not-yours';

  const backers = db
    .prepare(
      `SELECT COUNT(*) AS n FROM interest
       WHERE channel_id = ? AND nomination_id = ? AND user_id <> ?`,
    )
    .get(channelId, nominationId, userId) as { n: number };
  if (backers.n > 0) return 'backed';

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM interest WHERE channel_id = ? AND nomination_id = ?`).run(
      channelId,
      nominationId,
    );
    db.prepare(`UPDATE nominations SET withdrawn_at = ? WHERE id = ? AND channel_id = ?`).run(
      now(),
      nominationId,
      channelId,
    );
  });
  tx();
  return 'ok';
}

export function veto(channelId: string, nominationId: number, reason: string): boolean {
  const r = db
    .prepare(
      `UPDATE nominations SET vetoed_at = ?, veto_reason = ?
       WHERE id = ? AND channel_id = ? AND vetoed_at IS NULL AND won_at IS NULL AND withdrawn_at IS NULL`,
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
  /** null on polls closed before outcomes were recorded. */
  outcome: 'winner' | 'tie' | 'empty' | 'cancelled' | null;
  /** Set once the result has been cleared off the front page. */
  dismissed_at: number | null;
};

export type CloseResult =
  | { outcome: 'winner'; winner: Tally }
  | { outcome: 'tie'; tied: Tally[] }
  | { outcome: 'empty' };

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

/** The most recent poll, dismissed or not. */
export function mostRecentPoll(channelId: string): Poll | undefined {
  return db
    .prepare(`SELECT * FROM polls WHERE channel_id = ? ORDER BY id DESC LIMIT 1`)
    .get(channelId) as Poll | undefined;
}

/**
 * The poll the front page should be showing. Dismissing the newest result means
 * there is nothing to show — it must not fall through to an older one.
 */
export function latestPoll(channelId: string): Poll | undefined {
  const poll = mostRecentPoll(channelId);
  return poll && poll.dismissed_at ? undefined : poll;
}

/**
 * Abandons a running poll. Nothing wins, so nothing is marked won and nothing
 * leaves the board — for the case where a poll was started by accident. Cleared
 * from the front page at the same time: there is no result worth showing.
 */
export function cancelPoll(channelId: string, pollId: number): boolean {
  const r = db
    .prepare(
      `UPDATE polls
       SET status = 'closed', closed_at = ?, outcome = 'cancelled',
           winner_nomination_id = NULL, dismissed_at = ?
       WHERE id = ? AND channel_id = ? AND status = 'open'`,
    )
    .run(now(), now(), pollId, channelId);
  return r.changes > 0;
}

/** Clears a finished result off the front page, putting it back to nominations. */
export function dismissPoll(channelId: string, pollId: number): boolean {
  const r = db
    .prepare(
      `UPDATE polls SET dismissed_at = ?
       WHERE id = ? AND channel_id = ? AND status = 'closed' AND dismissed_at IS NULL`,
    )
    .run(now(), pollId, channelId);
  return r.changes > 0;
}

/**
 * `only` restricts the poll to specific nominations — used for a tiebreaker,
 * where the choices are the movies that drew, not the top of the board.
 */
export function openPoll(
  channelId: string,
  durationSeconds: number,
  size: number,
  only?: number[],
): Poll {
  if (getOpenPoll(channelId)) throw new Error('A poll is already open');

  const shortlist = only?.length
    ? listNominations(channelId).filter((n) => only.includes(n.id))
    : listNominations(channelId, size);
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
      `SELECT o.position, n.id AS nomination_id, n.title, n.year,
              n.poster_path, n.backdrop_path, n.trailer_key, n.overview
       FROM poll_options o JOIN nominations n ON n.id = o.nomination_id
       WHERE o.poll_id = ? AND o.channel_id = ? ORDER BY o.position`,
    )
    .all(pollId, channelId) as {
    position: number;
    nomination_id: number;
    title: string;
    year: number | null;
    poster_path: string | null;
    backdrop_path: string | null;
    trailer_key: string | null;
    overview: string | null;
  }[];
}

/**
 * One vote per person. Re-voting for the same movie is a no-op so the tie-break
 * timestamp is not disturbed; voting for a different one moves the vote.
 */
export function castVote(
  channelId: string,
  pollId: number,
  userId: string,
  nominationId: number,
  source: 'web' | 'chat',
): number {
  const poll = getPoll(channelId, pollId);
  if (!poll || poll.status !== 'open') throw new Error('No poll is open');
  if (now() > poll.closes_at) throw new Error('Voting has closed');

  const valid = pollOptions(channelId, pollId).some((o) => o.nomination_id === nominationId);
  if (!valid) throw new Error('That movie is not on this poll');

  const tx = db.transaction(() => {
    const current = myVote(channelId, pollId, userId);
    if (current === nominationId) return;

    db.prepare(`DELETE FROM ballots WHERE poll_id = ? AND channel_id = ? AND user_id = ?`).run(
      pollId,
      channelId,
      userId,
    );
    db.prepare(
      `INSERT INTO ballots (poll_id, channel_id, user_id, nomination_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(pollId, channelId, userId, nominationId, source, now());
  });
  tx();
  return nominationId;
}

export function clearVote(channelId: string, pollId: number, userId: string): void {
  db.prepare(`DELETE FROM ballots WHERE poll_id = ? AND channel_id = ? AND user_id = ?`).run(
    pollId,
    channelId,
    userId,
  );
}

export function myVote(channelId: string, pollId: number, userId: string): number | null {
  const row = db
    .prepare(
      `SELECT nomination_id FROM ballots WHERE poll_id = ? AND channel_id = ? AND user_id = ? LIMIT 1`,
    )
    .get(pollId, channelId, userId) as { nomination_id: number } | undefined;
  return row?.nomination_id ?? null;
}

export function tally(channelId: string, pollId: number): Tally[] {
  return db
    .prepare(
      `SELECT o.nomination_id, n.title, n.year, n.poster_path, n.backdrop_path,
              n.trailer_key, n.overview, COUNT(b.user_id) AS votes,
              COALESCE(MAX(b.created_at), 0) AS reached_at
       FROM poll_options o
       JOIN nominations n ON n.id = o.nomination_id
       LEFT JOIN ballots b ON b.nomination_id = o.nomination_id AND b.poll_id = o.poll_id
       WHERE o.poll_id = ? AND o.channel_id = ?
       GROUP BY o.nomination_id
       -- Same rule as the board, so the live bars and the winner agree: a
       -- movie that ties only draws level, it does not overtake.
       ORDER BY votes DESC, reached_at ASC, o.position ASC`,
    )
    .all(pollId, channelId) as Tally[];
}

export function voterCount(channelId: string, pollId: number): number {
  const r = db
    .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM ballots WHERE poll_id = ? AND channel_id = ?`)
    .get(pollId, channelId) as { n: number };
  return r.n;
}

/**
 * Closes the poll. A draw at the top is reported as a tie rather than silently
 * resolved: nothing is marked won, so the drawn movies stay on the board and a
 * tiebreaker can include them.
 */
export function closePoll(channelId: string, pollId: number): CloseResult | null {
  const poll = getPoll(channelId, pollId);
  if (!poll || poll.status !== 'open') return null;

  const results = tally(channelId, pollId);
  const top = results[0];
  const drawn = top && top.votes > 0 ? results.filter((r) => r.votes === top.votes) : [];

  const result: CloseResult =
    drawn.length === 0
      ? { outcome: 'empty' }
      : drawn.length === 1
        ? { outcome: 'winner', winner: drawn[0]! }
        : { outcome: 'tie', tied: drawn };

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE polls SET status = 'closed', closed_at = ?, winner_nomination_id = ?, outcome = ?
       WHERE id = ? AND channel_id = ?`,
    ).run(
      now(),
      result.outcome === 'winner' ? result.winner.nomination_id : null,
      result.outcome,
      pollId,
      channelId,
    );

    if (result.outcome === 'winner') {
      // Winner leaves the board; everyone else carries over with interest intact.
      db.prepare(`UPDATE nominations SET won_at = ? WHERE id = ? AND channel_id = ?`).run(
        now(),
        result.winner.nomination_id,
        channelId,
      );
    }
  });
  tx();
  return result;
}

/** The movies that drew in a closed poll, in tally order. */
export function tiedIn(channelId: string, pollId: number): Tally[] {
  const poll = getPoll(channelId, pollId);
  if (!poll || poll.outcome !== 'tie') return [];
  const results = tally(channelId, pollId);
  const top = results[0];
  return top ? results.filter((r) => r.votes === top.votes) : [];
}

/** Ends a tie by declaring one of the drawn movies the winner. */
export function settleTie(channelId: string, pollId: number, nominationId: number): Tally | null {
  const drawn = tiedIn(channelId, pollId);
  const chosen = drawn.find((t) => t.nomination_id === nominationId);
  if (!chosen) return null;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE polls SET winner_nomination_id = ?, outcome = 'winner' WHERE id = ? AND channel_id = ?`,
    ).run(nominationId, pollId, channelId);
    db.prepare(`UPDATE nominations SET won_at = ? WHERE id = ? AND channel_id = ?`).run(
      now(),
      nominationId,
      channelId,
    );
  });
  tx();
  return chosen;
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
      `SELECT s.user_id, u.login, u.display_name, u.avatar_url FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.channel_id = ? AND s.expires_at > ?`,
    )
    .get(id, channelId, now()) as
    | { user_id: string; login: string; display_name: string; avatar_url: string | null }
    | undefined;
}

export function deleteSession(id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}
