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
  nominations: (Card & { id: number; nominator: string; interest: number })[];
  voters: number;
  winner: (Card & { nominationId: number; votes: number }) | null;
  rules: typeof config.rules;
  posterBase: string;
};

export function snapshot(channelId: string): Snapshot {
  const open = q.getOpenPoll(channelId);
  const poll = open ?? q.latestPoll(channelId);

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
  }));

  const posterBase = config.tmdb.imageBase;

  if (!poll) {
    return {
      phase: 'nominating',
      tie: [],
      poll: null,
      options: [],
      nominations,
      voters: 0,
      winner: null,
      rules: config.rules,
      posterBase,
    };
  }

  const counts = new Map(q.tally(channelId, poll.id).map((t) => [t.nomination_id, t]));
  const options = q.pollOptions(channelId, poll.id).map((o) => ({
    position: o.position,
    nominationId: o.nomination_id,
    title: o.title,
    year: o.year,
    poster: o.poster_path,
    backdrop: o.backdrop_path,
    trailer: o.trailer_key,
    overview: o.overview,
    votes: counts.get(o.nomination_id)?.votes ?? 0,
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
    tie,
    poll: { id: poll.id, closesAt: poll.closes_at, closedAt: poll.closed_at },
    options,
    nominations,
    voters: q.voterCount(channelId, poll.id),
    winner,
    rules: config.rules,
    posterBase,
  };
}

export function broadcast(channelId: string): void {
  events.emit('update', channelId, snapshot(channelId));
}

export function open(
  channelId: string,
  durationSeconds = config.rules.pollDurationSeconds,
  only?: number[],
) {
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
