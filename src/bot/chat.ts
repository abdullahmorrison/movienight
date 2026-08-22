import { ChatClient, type ChatMessage } from '@twurple/chat';
import { config } from '../config.js';
import * as q from '../db/queries.js';
import * as poll from '../poll.js';

const CHANNEL = config.channel.id;

/**
 * Reads chat and nothing else. Twitch accepts anonymous connections, so there is
 * no bot account, no token and no setup step — and nothing this can post.
 *
 * Only voting lives here. Nominating needs search, a poster and a year to pick
 * the right film out of several with the same name, none of which a chat line
 * can offer; the rest of the commands only existed to have the bot talk back.
 */
export async function startBot(): Promise<ChatClient | null> {
  const chat = new ChatClient({ channels: [config.channel.login] });

  chat.onMessage((_channel, _user, text, msg) => {
    try {
      handleVote(text, msg);
    } catch (err) {
      console.error('[bot] vote failed', err);
    }
  });

  chat.onConnect(() => console.log(`[bot] reading #${config.channel.login} (never posts)`));
  chat.onDisconnect((manual, reason) => {
    if (!manual) console.warn('[bot] disconnected, reconnecting:', reason?.message ?? reason);
  });

  chat.connect();
  return chat;
}

function handleVote(text: string, msg: ChatMessage): void {
  const raw = text.trim();
  if (!/^!vote\b/i.test(raw)) return;

  const open = q.getOpenPoll(CHANNEL);
  if (!open) return;

  // One vote each, so only the first number counts.
  const position = Number((raw.slice(5).trim().split(/[\s,]+/)[0] ?? '').replace('#', ''));
  if (!Number.isInteger(position)) return;

  const chosen = q.pollOptions(CHANNEL, open.id).find((o) => o.position === position);
  if (!chosen) return;

  // Keyed on the Twitch user id, the same one the website's sign-in returns, so
  // voting here and on the site is one ballot rather than two.
  q.upsertUser(msg.userInfo.userId, msg.userInfo.userName, msg.userInfo.displayName);
  q.castVote(CHANNEL, open.id, msg.userInfo.userId, chosen.nomination_id, 'chat');
  poll.broadcast(CHANNEL);
}
