import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config.js';
import * as q from '../db/queries.js';
import * as poll from '../poll.js';
import * as tmdb from '../tmdb.js';
import { lookupAvatar } from '../twitch.js';
import { authRoutes, loadUser, requireUser, requireBroadcaster } from './auth.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const CHANNEL = config.channel.id;

// Accounts that signed in before avatars were stored, and chat-only users, have
// none. Fill it in once per process rather than making anyone sign in again.
const avatarTried = new Set<string>();

// The board is frozen while a poll runs: letting it move under voters would
// change what the shortlist meant halfway through.
const NOMINATIONS_CLOSED = 'Nominations are closed while voting is open. They reopen when the poll ends.';

// The ballot is fixed when a poll opens, so a veto part-way through would not
// take the movie off it — people could still vote for it and it could still
// win. Close voting first.
const VETO_CLOSED = 'Close voting before vetoing — the ballot is already fixed.';
// And once a result is up, the board belongs to the next round rather than this
// one, so there is nothing a veto could affect until it has been cleared.
const VETO_SETTLED = 'Clear the last result before changing the board.';

/** Why the board cannot be edited right now, or null when it can. */
function boardLocked(): string | null {
  if (q.getOpenPoll(CHANNEL)) return VETO_CLOSED;
  const last = q.latestPoll(CHANNEL);
  if (last && last.status === 'closed') return VETO_SETTLED;
  return null;
}

function backfillAvatar(userId: string, login: string): void {
  if (avatarTried.has(userId)) return;
  avatarTried.add(userId);
  lookupAvatar(userId)
    .then((url) => {
      if (url) q.upsertUser(userId, login, undefined, url);
    })
    .catch((err) => console.warn('[twitch] avatar backfill failed', (err as Error).message));
}

export function createServer(): http.Server {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(loadUser);
  app.use(authRoutes());

  app.get('/api/state', (req, res) => {
    if (req.user && !req.user.avatar) backfillAvatar(req.user.id, req.user.login);
    const snap = poll.snapshot(CHANNEL);
    res.json({
      ...snap,
      channel: config.channel.login,
      me: req.user
        ? {
            id: req.user.id,
            login: req.user.login,
            displayName: req.user.displayName,
            avatar: req.user.avatar,
            isBroadcaster: req.user.id === CHANNEL,
          }
        : null,
      myInterest: req.user ? q.myInterest(CHANNEL, req.user.id) : [],
      myVote: req.user && snap.poll ? q.myVote(CHANNEL, snap.poll.id, req.user.id) : null,
    });
  });

  app.get('/api/winners', (_req, res) => res.json(q.recentWinners(CHANNEL)));

  app.get('/api/search', requireUser, async (req, res) => {
    const query = String(req.query.q ?? '');
    if (!tmdb.enabled()) {
      res.json({ enabled: false, results: [] });
      return;
    }
    try {
      res.json({ enabled: true, results: await tmdb.search(query), posterBase: config.tmdb.imageBase });
    } catch (err) {
      console.error('[tmdb] search failed', err);
      res.status(502).json({ error: 'Movie search is down — type a title instead.' });
    }
  });

  app.post('/api/nominate', requireUser, async (req, res) => {
    if (q.getOpenPoll(CHANNEL)) {
      res.status(409).json({ error: NOMINATIONS_CLOSED });
      return;
    }
    const body = req.body as { title?: unknown; tmdbId?: unknown };
    const tmdbId = Number(body.tmdbId);

    let movie: q.MovieInput | null = null;
    if (Number.isInteger(tmdbId) && tmdbId > 0) {
      // Re-fetch from TMDB rather than trusting the poster and title the
      // browser sent us.
      const found = await tmdb.byId(tmdbId).catch(() => null);
      if (found) {
        movie = {
          title: found.title,
          tmdbId: found.tmdbId,
          year: found.year,
          posterPath: found.posterPath,
          backdropPath: found.backdropPath,
          trailerKey: found.trailerKey,
          overview: found.overview,
        };
      }
    }
    if (!movie) {
      const title = String(body.title ?? '').trim();
      if (!title) {
        res.status(400).json({ error: 'Pick a movie from the search results.' });
        return;
      }
      movie = { title };
    }

    const result = q.nominate(CHANNEL, movie, req.user!.id);
    if (!result.ok) {
      const message =
        result.reason === 'duplicate' && result.id
          ? 'Already nominated — added your interest instead.'
          : (result.detail ?? 'Could not nominate that.');
      if (result.reason === 'duplicate' && result.id) {
        q.addInterest(CHANNEL, result.id, req.user!.id);
        poll.broadcast(CHANNEL);
        res.json({ ok: true, merged: true, id: result.id, message });
        return;
      }
      res.status(409).json({ error: message });
      return;
    }
    poll.broadcast(CHANNEL);
    res.json({ ok: true, id: result.id, title: result.title });
  });

  app.post('/api/nominate/:id/withdraw', requireUser, (req, res) => {
    if (q.getOpenPoll(CHANNEL)) {
      res.status(409).json({ error: NOMINATIONS_CLOSED });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Bad id.' });
      return;
    }

    const result = q.withdrawNomination(CHANNEL, id, req.user!.id);
    if (result === 'ok') {
      poll.broadcast(CHANNEL);
      res.json({ ok: true });
      return;
    }

    const why = {
      missing: 'That nomination is no longer on the board.',
      'not-yours': 'You can only take back your own nominations.',
      backed: 'Other people want this now, so it stays on the board.',
    }[result];
    res.status(409).json({ error: why });
  });

  app.post('/api/interest/:id', requireUser, (req, res) => {
    if (q.getOpenPoll(CHANNEL)) {
      res.status(409).json({ error: NOMINATIONS_CLOSED });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Bad id.' });
      return;
    }
    try {
      const added = q.toggleInterest(CHANNEL, id, req.user!.id);
      poll.broadcast(CHANNEL);
      res.json({ ok: true, interested: added });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/api/vote', requireUser, (req, res) => {
    const open = q.getOpenPoll(CHANNEL);
    if (!open) {
      res.status(409).json({ error: 'No poll is open.' });
      return;
    }
    const raw = (req.body as { nominationId?: unknown }).nominationId;
    try {
      if (raw === null) {
        q.clearVote(CHANNEL, open.id, req.user!.id);
        poll.broadcast(CHANNEL);
        res.json({ ok: true, nominationId: null });
        return;
      }
      const id = Number(raw);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'Pick a movie.' });
        return;
      }
      q.castVote(CHANNEL, open.id, req.user!.id, id, 'web');
      poll.broadcast(CHANNEL);
      res.json({ ok: true, nominationId: id });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/poll/open', requireBroadcaster, (req, res) => {
    const seconds = Number((req.body as { durationSeconds?: unknown }).durationSeconds);
    try {
      const p = poll.open(
        CHANNEL,
        Number.isFinite(seconds) && seconds > 0 ? seconds : config.rules.pollDurationSeconds,
      );
      res.json({ ok: true, pollId: p.id, closesAt: p.closes_at });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/poll/close', requireBroadcaster, (_req, res) => {
    const result = poll.close(CHANNEL);
    if (!result) {
      res.status(409).json({ error: 'No poll is open.' });
      return;
    }
    res.json({ ok: true, ...result });
  });

  app.post('/api/poll/cancel', requireBroadcaster, (_req, res) => {
    try {
      poll.cancel(CHANNEL);
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/poll/tiebreak', requireBroadcaster, (req, res) => {
    const seconds = Number((req.body as { durationSeconds?: unknown }).durationSeconds);
    try {
      const p = poll.tiebreak(
        CHANNEL,
        Number.isFinite(seconds) && seconds > 0 ? seconds : config.rules.pollDurationSeconds,
      );
      res.json({ ok: true, pollId: p.id, closesAt: p.closes_at });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/poll/dismiss', requireBroadcaster, (_req, res) => {
    try {
      poll.dismiss(CHANNEL);
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/poll/settle', requireBroadcaster, (req, res) => {
    const id = Number((req.body as { nominationId?: unknown }).nominationId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Pick one of the tied movies.' });
      return;
    }
    try {
      res.json({ ok: true, winner: poll.settle(CHANNEL, id) });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/veto/:id', requireBroadcaster, (req, res) => {
    const blocked = boardLocked();
    if (blocked) {
      res.status(409).json({ error: blocked });
      return;
    }
    const id = Number(req.params.id);
    const reason = String((req.body as { reason?: unknown }).reason ?? '');
    const ok = q.veto(CHANNEL, id, reason);
    poll.broadcast(CHANNEL);
    res.status(ok ? 200 : 404).json(ok ? { ok } : { error: 'Nothing to veto.' });
  });

  app.post('/api/unveto/:id', requireBroadcaster, (req, res) => {
    const blocked = boardLocked();
    if (blocked) {
      res.status(409).json({ error: blocked });
      return;
    }
    const ok = q.unveto(CHANNEL, Number(req.params.id));
    poll.broadcast(CHANNEL);
    res.status(ok ? 200 : 404).json(ok ? { ok } : { error: 'Nothing to restore.' });
  });

  app.use(express.static(publicDir));
  app.get('/poll-controls', (_req, res) => res.sendFile(path.join(publicDir, 'poll-controls.html')));
  // Anyone who bookmarked the old path still lands in the right place.
  app.get('/control', (_req, res) => res.redirect(301, '/poll-controls'));
  app.get('/overlay', (_req, res) => res.sendFile(path.join(publicDir, 'overlay.html')));

  const server = http.createServer(app);
  attachWebsocket(server);
  return server;
}

function attachWebsocket(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', data: poll.snapshot(CHANNEL) }));
  });

  poll.events.on('update', (channelId: string, snap: poll.Snapshot) => {
    if (channelId !== CHANNEL) return;
    const payload = JSON.stringify({ type: 'state', data: snap });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  // No periodic broadcast: every vote, nomination and veto already pushes, and
  // both the page and the overlay run their own countdown off closesAt. Sending
  // an unchanged snapshot every few seconds only made clients redraw for nothing.
}
