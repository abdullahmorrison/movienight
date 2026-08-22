import { EventEmitter } from 'node:events';
import { config } from './config.js';
import * as q from './db/queries.js';

export const events = new EventEmitter();

const timers = new Map<string, NodeJS.Timeout>();

export type Card = {
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  trailer: string | null;
  overview: string | null;
};

export type Snapshot = {
  phase: 'nominating' | 'voting' | 'results';
  /** Set on a finished poll that drew: the streamer decides what happens next. */
  tie: (Card & { nominationId: number; votes: number })[];
  poll: { id: number; closesAt: number; closedAt: number | null } | null;
  options: (Card & { position: number; nominationId: number; votes: number })[];
  nominations: (Card & {
    id: number;
    nominator: string;
    interest: number;
    /** False once someone other than the nominator wants it. */
    usesNominatorSlot: boolean;
  })[];
  voters: number;
  winner: (Card & { nominationId: number; votes: number }) | null;
  rules: typeof config.rules;
  posterBase: string;
  /** Where to send viewers who need to nominate; chat can only vote. */
  siteUrl: string;
  /** True while viewers are being kept from the running count. */
  tallyHidden: boolean;
  /** The streamer's setting, shown on their own controls. */
  showTally: boolean;
  /** Everything that has won before, newest first. */
  winners: {
    nominationId: number;
    title: string;
    year: number | null;
    poster: string | null;
    trailer: string | null;
    wonAt: number;
  }[];
};

/**
 * A finished result should not headline the page all week. Once it has had its
 * moment the page goes back to taking nominations — except after a draw, which
 * stays up until the streamer resolves it.
 */
const isOpenPoll = (poll: q.Poll) => poll.status === 'open';

function stillWorthShowing(poll: q.Poll): boolean {
  if (poll.status === 'open' || poll.outcome === 'tie') return true;
  if (!poll.closed_at) return true;
  return Date.now() - poll.closed_at < config.rules.resultsVisibleHours * 60 * 60 * 1000;
}

/**
 * `full` is for the streamer's own controls. Everyone else gets the counts
 * stripped rather than merely hidden in the page: a number sent to the browser
 * is a number anyone can read out of the websocket.
 */
export function snapshot(channelId: string, full = false): Snapshot {
  const open = q.getOpenPoll(channelId);
  const last = open ?? q.latestPoll(channelId);
  const poll = last && stillWorthShowing(last) ? last : undefined;

  const nominations = q.listNominations(channelId).map((n) => ({
    id: n.id,
    title: n.title,
    year: n.year,
    poster: n.poster_path,
    backdrop: n.backdrop_path,
    trailer: n.trailer_key,
    overview: n.overview,
    nominator: n.nominator_login,
    interest: n.interest,
    usesNominatorSlot: n.others_interest === 0,
  }));

  const posterBase = config.tmdb.imageBase;
  const winners = q.recentWinners(channelId, 12).map((w) => ({
    nominationId: w.id,
    title: w.title,
    year: w.year,
    poster: w.poster_path,
    trailer: w.trailer_key,
    wonAt: w.won_at,
  }));
  const siteUrl = config.publicUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

  const showTally = q.showsTally(channelId);

  if (!poll) {
    return {
      phase: 'nominating',
      tallyHidden: false,
      showTally,
      tie: [],
      poll: null,
      options: [],
      nominations,
      voters: 0,
      winner: null,
      rules: config.rules,
      posterBase,
      siteUrl,
      winners,
    };
  }

  const counts = new Map(q.tally(channelId, poll.id).map((t) => [t.nomination_id, t]));
  // Only while voting: the final result is the payoff and is always shown.
  const hide = isOpenPoll(poll) && !showTally && !full;

  const options = q.pollOptions(channelId, poll.id).map((o) => ({
    position: o.position,
    nominationId: o.nomination_id,
    title: o.title,
    year: o.year,
    poster: o.poster_path,
    backdrop: o.backdrop_path,
    trailer: o.trailer_key,
    overview: o.overview,
    votes: hide ? 0 : (counts.get(o.nomination_id)?.votes ?? 0),
  }));

  const isOpen = poll.status === 'open';
  let winner: Snapshot['winner'] = null;
  if (!isOpen && poll.winner_nomination_id) {
    const w = counts.get(poll.winner_nomination_id);
    if (w) {
      winner = {
        nominationId: w.nomination_id,
        title: w.title,
        year: w.year,
        poster: w.poster_path,
        backdrop: w.backdrop_path,
        trailer: w.trailer_key,
        overview: w.overview,
        votes: w.votes,
      };
    }
  }

  const tie = isOpen
    ? []
    : q.tiedIn(channelId, poll.id).map((t) => ({
        nominationId: t.nomination_id,
        title: t.title,
        year: t.year,
        poster: t.poster_path,
        backdrop: t.backdrop_path,
        trailer: t.trailer_key,
        overview: t.overview,
        votes: t.votes,
      }));

  return {
    phase: isOpen ? 'voting' : 'results',
    tallyHidden: hide,
    showTally,
    tie,
    poll: { id: poll.id, closesAt: poll.closes_at, closedAt: poll.closed_at },
    options,
    nominations,
    voters: q.voterCount(channelId, poll.id),
    winner,
    rules: config.rules,
    posterBase,
    siteUrl,
    winners,
  };
}

export function broadcast(channelId: string): void {
  events.emit('update', channelId, snapshot(channelId));
}

/**
 * The handful of numbers that move while a poll runs. A vote changes nothing
 * else, and re-sending the whole board to every viewer for each one costs
 * voters x viewers snapshots over a night.
 */
export type Tally = {
  pollId: number;
  /** nominationId to votes. Empty while the counts are hidden from viewers. */
  votes: Record<number, number>;
  voters: number;
};

export function tallyOf(channelId: string): Tally | null {
  const open = q.getOpenPoll(channelId);
  if (!open) return null;

  // Zero first, then the counts: a cleared vote drops its row from the tally
  // entirely, and a client that kept the old number would never lose it.
  const votes: Record<number, number> = {};
  if (q.showsTally(channelId)) {
    for (const o of q.pollOptions(channelId, open.id)) votes[o.nomination_id] = 0;
    for (const t of q.tally(channelId, open.id)) votes[t.nomination_id] = t.votes;
  }

  return { pollId: open.id, votes, voters: q.voterCount(channelId, open.id) };
}

/** For a vote: the board is unchanged, so only the numbers go out. */
export function broadcastTally(channelId: string): void {
  events.emit('tally', channelId);
}

export function open(
  channelId: string,
  durationSeconds = config.rules.pollDurationSeconds,
  only?: number[],
) {
  // A finished result still headlining the page means the last night is not put
  // away yet; starting another poll under it reads as though nothing happened.
  // Tiebreakers pass `only` and are exempt — they are finishing that result.
  if (!only) {
    const last = q.latestPoll(channelId);
    if (last && last.status === 'closed') {
      throw new Error(
        last.outcome === 'tie'
          ? 'Settle the tie first, or run a tiebreaker.'
          : 'Clear the last result before starting a new poll.',
      );
    }
  }

  const poll = q.openPoll(channelId, durationSeconds, config.rules.shortlistSize, only);
  schedule(channelId, poll.id, poll.closes_at);
  broadcast(channelId);
  return poll;
}

/** Re-runs the last poll with only the movies that drew. */
export function tiebreak(channelId: string, durationSeconds = config.rules.pollDurationSeconds) {
  const last = q.latestPoll(channelId);
  if (!last || last.outcome !== 'tie') throw new Error('The last poll did not end in a tie');
  const ids = q.tiedIn(channelId, last.id).map((t) => t.nomination_id);
  if (ids.length < 2) throw new Error('Nothing to break');
  return open(channelId, durationSeconds, ids);
}

/** Abandons a running poll without deciding anything. */
export function cancel(channelId: string) {
  const open = q.getOpenPoll(channelId);
  if (!open) throw new Error('No poll is open');
  clearTimer(channelId);
  q.cancelPoll(channelId, open.id);
  broadcast(channelId);
  events.emit('cancelled', channelId, open.id);
  return open.id;
}

/** Puts the page back to nominations without waiting for the result to age out. */
export function dismiss(channelId: string) {
  const last = q.mostRecentPoll(channelId);
  if (!last) throw new Error('There is no result to clear');
  if (last.status === 'open') throw new Error('The poll is still running');
  if (last.outcome === 'tie') throw new Error('Settle the tie first');
  if (!q.dismissPoll(channelId, last.id)) throw new Error('Already cleared');
  broadcast(channelId);
}

export function settle(channelId: string, nominationId: number) {
  const last = q.latestPoll(channelId);
  if (!last || last.outcome !== 'tie') throw new Error('The last poll did not end in a tie');
  const winner = q.settleTie(channelId, last.id, nominationId);
  if (!winner) throw new Error('That movie was not one of the tied choices');
  broadcast(channelId);
  events.emit('settled', channelId, winner);
  return winner;
}

export function close(channelId: string, pollId?: number) {
  const poll = pollId ? q.getPoll(channelId, pollId) : q.getOpenPoll(channelId);
  if (!poll) return null;
  clearTimer(channelId);
  const result = q.closePoll(channelId, poll.id);
  broadcast(channelId);
  events.emit('closed', channelId, result);
  return result;
}

function clearTimer(channelId: string) {
  const t = timers.get(channelId);
  if (t) clearTimeout(t);
  timers.delete(channelId);
}

function schedule(channelId: string, pollId: number, closesAt: number) {
  clearTimer(channelId);
  const delay = Math.max(0, closesAt - Date.now());
  timers.set(
    channelId,
    setTimeout(() => close(channelId, pollId), delay),
  );
}

/**
 * A restart mid-poll must resume, not reset. The tally lives in SQLite, so we
 * only need to re-arm the close timer (or close immediately if we were down
 * past the deadline).
 */
export function resume(channelId: string): void {
  const open = q.getOpenPoll(channelId);
  if (!open) return;
  if (Date.now() >= open.closes_at) {
    console.log(`[poll] poll ${open.id} expired while we were down — closing now`);
    close(channelId, open.id);
  } else {
    const secs = Math.round((open.closes_at - Date.now()) / 1000);
    console.log(`[poll] resuming poll ${open.id}, ${secs}s left`);
    schedule(channelId, open.id, open.closes_at);
  }
}
