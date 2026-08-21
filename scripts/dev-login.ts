/**
 * Mints a local session cookie so you can click through the app without a
 * Twitch app configured. Dev only — refuses to run in production.
 *
 *   npx tsx scripts/dev-login.ts <userId> <login>
 *   npx tsx scripts/dev-login.ts $CHANNEL_ID streamer   # broadcaster powers
 */
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { resolveChannelId } from '../src/twitch.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to mint a fake session in production.');
  process.exit(1);
}

// Sessions are keyed on the channel, so resolve it before touching the database
// — same ordering the server uses at boot.
await resolveChannelId();
const q = await import('../src/db/queries.js');

const [userId, login] = process.argv.slice(2);
if (!userId || !login) {
  console.error('usage: tsx scripts/dev-login.ts <userId> <login>');
  process.exit(1);
}

q.upsertUser(userId, login, login);
const sid = crypto.randomBytes(24).toString('base64url');
q.createSession(sid, config.channel.id, userId, 24 * 60 * 60 * 1000);
const sig = crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url');

console.log(`mn_session=${sid}.${sig}`);
