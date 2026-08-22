import fs from 'node:fs/promises';
import { RefreshingAuthProvider } from '@twurple/auth';
import { ChatClient, type ChatMessage } from '@twurple/chat';
import { config } from '../config.js';
import * as q from '../db/queries.js';
import * as poll from '../poll.js';
import * as tmdb from '../tmdb.js';

const CHANNEL = config.channel.id;

type StoredToken = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  obtainmentTimestamp: number;
  userId: string;
};

/** Cheap per-key cooldown so a busy chat can't make the bot spam itself into a timeout. */
function cooldown(ms: number) {
  const last = new Map<string, number>();
  return (key: string): boolean => {
    const t = Date.now();
    if ((last.get(key) ?? 0) + ms > t) return false;
    last.set(key, t);
    return true;
  };
}

const canAnnounce = cooldown(5000);
const canErrorReply = cooldown(3000);

/**
 * Reading chat needs no account: Twitch accepts anonymous IRC connections. A
 * token only buys the ability to *reply*, so its absence downgrades to
 * read-only rather than turning commands off.
 */
async function buildClient(): Promise<{ chat: ChatClient; canSpeak: boolean }> {
  let stored: StoredToken | null = null;
  try {
    stored = JSON.parse(await fs.readFile(config.bot.tokenFile, 'utf8')) as StoredToken;
  } catch {
    stored = null;
  }

  if (!stored) {
    console.log(
      `[bot] read-only: no ${config.bot.tokenFile}, so commands work but the bot cannot reply.`,
    );
    console.log('[bot] run `npm run bot-auth` if you want it to talk in chat.');
    return { chat: new ChatClient({ channels: [config.channel.login] }), canSpeak: false };
  }

  const auth = new RefreshingAuthProvider({
    clientId: config.twitch.clientId,
    clientSecret: config.twitch.clientSecret,
  });

  auth.onRefresh(async (userId, newToken) => {
    await fs.writeFile(
      config.bot.tokenFile,
      JSON.stringify({ ...newToken, userId }, null, 2),
      'utf8',
    );
  });

  await auth.addUserForToken(stored, ['chat']);
  return { chat: new ChatClient({ authProvider: auth, channels: [config.channel.login] }), canSpeak: true };
}

export async function startBot(): Promise<ChatClient | null> {
  const { chat, canSpeak } = await buildClient();
  // Swallowed rather than branched at every call site: everything the bot says
  // is a convenience, and the overlay carries the same information.
  const announce = (message: string) => {
    if (canSpeak) chat.say(config.channel.login, message);
  };

  chat.onMessage((_channel, _user, text, msg) => {
    handleMessage(text, msg, announce).catch((err) => console.error('[bot] handler failed', err));
  });

  chat.onConnect(() =>
    console.log(
      `[bot] connected, joined #${config.channel.login}${canSpeak ? '' : ' (read-only)'}`,
    ),
  );
  chat.onDisconnect((manual, reason) => {
    if (!manual) console.warn('[bot] disconnected, reconnecting:', reason?.message ?? reason);
  });

  chat.connect();

  poll.events.on('closed', (channelId: string, result: q.CloseResult | null) => {
    if (channelId !== CHANNEL || !result) return;
    const say = announce;

    if (result.outcome === 'winner') {
      const { title, votes } = result.winner;
      return void say(`🎬 Voting closed — tonight's movie is ${title} with ${votes} ${votes === 1 ? 'vote' : 'votes'}.`);
    }
    if (result.outcome === 'tie') {
      const names = result.tied.map((t) => t.title).join(' vs ');
      return void say(
        `🤝 It's a TIE — ${names}, ${result.tied[0]!.votes} votes each. Mods: !tiebreak to run it again.`,
      );
    }
    return void say('🎬 Voting closed with no votes cast.');
  });

  poll.events.on('settled', (channelId: string, winner: q.Tally) => {
    if (channelId !== CHANNEL) return;
    announce(`🎬 Tie settled — tonight's movie is ${winner.title}.`);
  });

  return chat;
}

async function handleMessage(
  text: string,
  msg: ChatMessage,
  say: (message: string) => void,
): Promise<void> {
  const raw = text.trim();
  if (!raw.startsWith('!')) return;

  const [cmdRaw, ...rest] = raw.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? '').toLowerCase();
  const arg = rest.join(' ');
  const userId = msg.userInfo.userId;
  const login = msg.userInfo.userName;
  const isPrivileged = msg.userInfo.isMod || msg.userInfo.isBroadcaster;

  // Same Twitch user id the web app keys on, so chat and web are one ballot.
  q.upsertUser(userId, login, msg.userInfo.displayName);

  switch (cmd) {
    case 'nominate':
    case 'nom': {
      if (!arg) return void say(`@${login} usage: !nominate <movie title>`);

      // Chat gets the same poster treatment as the site: take TMDB's best match.
      const match = await tmdb.search(arg).catch(() => []);
      // Search results carry no videos, so pull the full record for the trailer.
      const full = match[0] ? await tmdb.byId(match[0].tmdbId).catch(() => null) : null;
      const best = full ?? match[0];
      const movie: q.MovieInput = best
        ? {
            title: best.title,
            tmdbId: best.tmdbId,
            year: best.year,
            posterPath: best.posterPath,
            backdropPath: best.backdropPath,
            trailerKey: best.trailerKey,
            overview: best.overview,
          }
        : { title: arg };

      const result = q.nominate(CHANNEL, movie, userId);
      if (result.ok) {
        poll.broadcast(CHANNEL);
        const yr = movie.year ? ` (${movie.year})` : '';
        return void say(`@${login} nominated "${result.title}"${yr} — #${result.id} 🍿`);
      }
      if (result.reason === 'duplicate' && result.id) {
        q.addInterest(CHANNEL, result.id, userId);
        poll.broadcast(CHANNEL);
        return void say(`@${login} already on the board (#${result.id}) — added your interest.`);
      }
      return void say(`@${login} ${result.detail ?? 'cannot nominate that'}`);
    }

    case 'interest':
    case 'want': {
      const id = Number(arg.replace('#', ''));
      if (!Number.isInteger(id)) return void say(`@${login} usage: !interest <id from !movies>`);
      try {
        const added = q.toggleInterest(CHANNEL, id, userId);
        poll.broadcast(CHANNEL);
        if (canErrorReply(`interest:${userId}`)) {
          say(`@${login} ${added ? 'added' : 'removed'} interest on #${id}`);
        }
      } catch {
        if (canErrorReply(`interest:${userId}`)) say(`@${login} no live nomination #${id}`);
      }
      return;
    }

    case 'trailer': {
      const id = Number(arg.replace('#', ''));
      const n = q.listNominations(CHANNEL).find((x) => x.id === id);
      if (!n) return void say(`@${login} no live nomination #${id}`);
      if (!n.trailer_key) return void say(`@${login} no trailer on file for "${n.title}"`);
      return void say(`🎞️ ${n.title} — https://youtu.be/${n.trailer_key}`);
    }

    case 'movies':
    case 'list': {
      if (!canAnnounce('movies')) return;
      const top = q.listNominations(CHANNEL, config.rules.shortlistSize);
      if (top.length === 0) return void say('No nominations yet — !nominate <movie title>');
      return void say(
        `🍿 Shortlist: ${top.map((n) => `#${n.id} ${n.title} (${n.interest})`).join(' · ')}`,
      );
    }

    case 'vote': {
      const open = q.getOpenPoll(CHANNEL);
      if (!open) {
        if (canErrorReply('novote')) say('No poll is open right now.');
        return;
      }
      const options = q.pollOptions(CHANNEL, open.id);
      // One vote each, so only the first number counts.
      const position = Number((arg.split(/[\s,]+/)[0] ?? '').replace('#', ''));
      if (!Number.isInteger(position)) {
        if (canErrorReply(`vote:${userId}`)) {
          say(`@${login} usage: !vote 2 — one movie each`);
        }
        return;
      }
      const chosen = options.find((o) => o.position === position);
      if (!chosen) {
        if (canErrorReply(`vote:${userId}`)) say(`@${login} there's no #${position} on this poll`);
        return;
      }
      // No per-vote reply: a busy chat would flood. The overlay shows it land.
      q.castVote(CHANNEL, open.id, userId, chosen.nomination_id, 'chat');
      poll.broadcast(CHANNEL);
      return;
    }

    case 'poll': {
      if (!isPrivileged) return;
      const seconds = Number(arg) || config.rules.pollDurationSeconds;
      try {
        const p = poll.open(CHANNEL, seconds);
        const options = q.pollOptions(CHANNEL, p.id);
        say(
          `🗳️ Voting is OPEN for ${seconds}s — !vote <number> for ONE movie: ${options
            .map((o) => `${o.position}) ${o.title}`)
            .join(' · ')}`,
        );
      } catch (err) {
        say(`@${login} ${(err as Error).message}`);
      }
      return;
    }

    case 'tiebreak': {
      if (!isPrivileged) return;
      const seconds = Number(arg) || config.rules.pollDurationSeconds;
      try {
        const p = poll.tiebreak(CHANNEL, seconds);
        const options = q.pollOptions(CHANNEL, p.id);
        say(
          `🤝 TIEBREAKER open for ${seconds}s — !vote <number>: ${options
            .map((o) => `${o.position}) ${o.title}`)
            .join(' · ')}`,
        );
      } catch (err) {
        say(`@${login} ${(err as Error).message}`);
      }
      return;
    }

    case 'endpoll': {
      if (!isPrivileged) return;
      if (!poll.close(CHANNEL)) say(`@${login} no poll is open`);
      return;
    }

    case 'veto': {
      if (!isPrivileged) return;
      const [idPart, ...reasonParts] = arg.split(/\s+/);
      const id = Number((idPart ?? '').replace('#', ''));
      if (!Number.isInteger(id)) return void say(`@${login} usage: !veto <id> [reason]`);
      const ok = q.veto(CHANNEL, id, reasonParts.join(' '));
      poll.broadcast(CHANNEL);
      return void say(ok ? `🚫 #${id} vetoed.` : `@${login} nothing to veto at #${id}`);
    }

    default:
      return;
  }
}
