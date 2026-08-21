import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config.js';
import * as q from '../db/queries.js';
import * as poll from '../poll.js';
import * as tmdb from '../tmdb.js';
import { authRoutes, loadUser, requireUser, requireBroadcaster } from './auth.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const CHANNEL = config.channel.id;

export function createServer(): http.Server {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(loadUser);
  app.use(authRoutes());

  app.get('/api/state', (req, res) => {
    const snap = poll.snapshot(CHANNEL);
    res.json({
      ...snap,
      channel: config.channel.login,
      me: req.user
        ? { id: req.user.id, login: req.user.login, isBroadcaster: req.user.id === CHANNEL }
        : null,
      myInterest: req.user ? q.myInterest(CHANNEL, req.user.id) : [],
      myBallot: req.user && snap.poll ? q.myBallot(CHANNEL, snap.poll.id, req.user.id) : [],
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

  app.post('/api/interest/:id', requireUser, (req, res) => {
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
    const raw = (req.body as { nominationIds?: unknown }).nominationIds;
    const ids = Array.isArray(raw) ? raw.map(Number).filter(Number.isInteger) : [];
    try {
      const count = q.castBallot(CHANNEL, open.id, req.user!.id, ids, 'web');
      poll.broadcast(CHANNEL);
      res.json({ ok: true, picks: count });
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
    const winner = poll.close(CHANNEL);
    if (!winner) {
      res.status(409).json({ error: 'No poll is open.' });
      return;
    }
    res.json({ ok: true, winner });
  });

  app.post('/api/veto/:id', requireBroadcaster, (req, res) => {
    const id = Number(req.params.id);
    const reason = String((req.body as { reason?: unknown }).reason ?? '');
    const ok = q.veto(CHANNEL, id, reason);
    poll.broadcast(CHANNEL);
    res.status(ok ? 200 : 404).json(ok ? { ok } : { error: 'Nothing to veto.' });
  });

  app.post('/api/unveto/:id', requireBroadcaster, (req, res) => {
    const ok = q.unveto(CHANNEL, Number(req.params.id));
    poll.broadcast(CHANNEL);
    res.status(ok ? 200 : 404).json(ok ? { ok } : { error: 'Nothing to restore.' });
  });

  app.use(express.static(publicDir));
  app.get('/control', (_req, res) => res.sendFile(path.join(publicDir, 'control.html')));
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

  // Keep the tally ticking down on overlays even when nobody votes.
  setInterval(() => {
    if (q.getOpenPoll(CHANNEL)) poll.broadcast(CHANNEL);
  }, 5000).unref();
}
