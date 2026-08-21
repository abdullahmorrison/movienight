import { EventEmitter } from 'node:events';
import { config } from './config.js';
import * as q from './db/queries.js';

export const events = new EventEmitter();

const timers = new Map<string, NodeJS.Timeout>();

export type Snapshot = {
  phase: 'nominating' | 'voting' | 'results';
  poll: { id: number; closesAt: number; closedAt: number | null } | null;
  options: { position: number; nominationId: number; title: string; approvals: number }[];
  nominations: { id: number; title: string; nominator: string; interest: number }[];
  voters: number;
  winner: { nominationId: number; title: string; approvals: number } | null;
  rules: typeof config.rules;
};

export function snapshot(channelId: string): Snapshot {
  const open = q.getOpenPoll(channelId);
  const poll = open ?? q.latestPoll(channelId);

  const nominations = q.listNominations(channelId).map((n) => ({
    id: n.id,
    title: n.title,
    nominator: n.nominator_login,
    interest: n.interest,
  }));

  if (!poll) {
    return { phase: 'nominating', poll: null, options: [], nominations, voters: 0, winner: null, rules: config.rules };
  }

  const counts = new Map(q.tally(channelId, poll.id).map((t) => [t.nomination_id, t]));
  const options = q.pollOptions(channelId, poll.id).map((o) => ({
    position: o.position,
    nominationId: o.nomination_id,
    title: o.title,
    approvals: counts.get(o.nomination_id)?.approvals ?? 0,
  }));

  const isOpen = poll.status === 'open';
  let winner: Snapshot['winner'] = null;
  if (!isOpen && poll.winner_nomination_id) {
    const w = counts.get(poll.winner_nomination_id);
    if (w) winner = { nominationId: w.nomination_id, title: w.title, approvals: w.approvals };
  }

  return {
    phase: isOpen ? 'voting' : 'results',
    poll: { id: poll.id, closesAt: poll.closes_at, closedAt: poll.closed_at },
    options,
    nominations,
    voters: q.voterCount(channelId, poll.id),
    winner,
    rules: config.rules,
  };
}

export function broadcast(channelId: string): void {
  events.emit('update', channelId, snapshot(channelId));
}

export function open(channelId: string, durationSeconds = config.rules.pollDurationSeconds) {
  const poll = q.openPoll(channelId, durationSeconds, config.rules.shortlistSize);
  schedule(channelId, poll.id, poll.closes_at);
  broadcast(channelId);
  return poll;
}

export function close(channelId: string, pollId?: number) {
  const poll = pollId ? q.getPoll(channelId, pollId) : q.getOpenPoll(channelId);
  if (!poll) return null;
  clearTimer(channelId);
  const winner = q.closePoll(channelId, poll.id);
  broadcast(channelId);
  events.emit('closed', channelId, winner);
  return winner;
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
