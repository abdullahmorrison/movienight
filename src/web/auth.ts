import crypto from 'node:crypto';
import type { Request, Response, NextFunction, Router } from 'express';
import express from 'express';
import { config } from '../config.js';
import * as q from '../db/queries.js';

const SESSION_COOKIE = 'mn_session';
const STATE_COOKIE = 'mn_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  login: string;
  displayName: string;
  avatar: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

function sign(value: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function pack(value: string): string {
  return `${value}.${sign(value)}`;
}

function unpack(signed: string | undefined): string | null {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 1) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = sign(value);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}

function cookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: Response, name: string, value: string, maxAgeMs: number): void {
  const secure = config.publicUrl.startsWith('https://');
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      maxAgeMs / 1000,
    )}${secure ? '; Secure' : ''}`,
  );
}

function clearCookie(res: Response, name: string): void {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export function loadUser(req: Request, _res: Response, next: NextFunction): void {
  const raw = unpack(cookies(req)[SESSION_COOKIE]);
  if (raw) {
    const s = q.getSession(raw, config.channel.id);
    if (s) {
      req.user = {
        id: s.user_id,
        login: s.login,
        displayName: s.display_name ?? s.login,
        avatar: s.avatar_url,
      };
    }
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in with Twitch first.' });
    return;
  }
  next();
}

export function requireBroadcaster(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in with Twitch first.' });
    return;
  }
  if (req.user.id !== config.channel.id) {
    res.status(403).json({ error: 'Streamer only.' });
    return;
  }
  next();
}

export function authRoutes(): Router {
  const r = express.Router();

  r.get('/auth/login', (_req, res) => {
    const state = crypto.randomBytes(16).toString('base64url');
    setCookie(res, STATE_COOKIE, pack(state), 10 * 60 * 1000);
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('client_id', config.twitch.clientId);
    url.searchParams.set('redirect_uri', config.twitch.redirectUri);
    url.searchParams.set('response_type', 'code');
    // No scopes: /helix/users returns our own id and login without any.
    url.searchParams.set('scope', '');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  r.get('/auth/callback', async (req, res) => {
    const expected = unpack(cookies(req)[STATE_COOKIE]);
    clearCookie(res, STATE_COOKIE);
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || !expected || state !== expected) {
      res.status(400).send('Bad OAuth state. Try signing in again.');
      return;
    }

    try {
      const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.twitch.clientId,
          client_secret: config.twitch.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: config.twitch.redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const token = (await tokenRes.json()) as { access_token: string };

      const userRes = await fetch('https://api.twitch.tv/helix/users', {
        headers: {
          'Client-Id': config.twitch.clientId,
          Authorization: `Bearer ${token.access_token}`,
        },
      });
      if (!userRes.ok) throw new Error(`user lookup failed: ${userRes.status}`);
      const body = (await userRes.json()) as {
        data: { id: string; login: string; display_name: string; profile_image_url?: string }[];
      };
      const me = body.data[0];
      if (!me) throw new Error('no user returned');

      // We only ever wanted the identity. Drop the access token on the floor —
      // nothing to store, nothing to leak, nothing to refresh.
      q.upsertUser(me.id, me.login, me.display_name, me.profile_image_url ?? null);
      const sid = crypto.randomBytes(24).toString('base64url');
      q.createSession(sid, config.channel.id, me.id, SESSION_TTL_MS);
      setCookie(res, SESSION_COOKIE, pack(sid), SESSION_TTL_MS);
      res.redirect('/');
    } catch (err) {
      console.error('[auth] callback failed', err);
      res.status(502).send('Twitch sign-in failed. Try again.');
    }
  });

  r.post('/auth/logout', (req, res) => {
    const raw = unpack(cookies(req)[SESSION_COOKIE]);
    if (raw) q.deleteSession(raw);
    clearCookie(res, SESSION_COOKIE);
    res.json({ ok: true });
  });

  return r;
}
