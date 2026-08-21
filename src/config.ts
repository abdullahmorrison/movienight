import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

export const config = {
  port: num('PORT', 3000),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${num('PORT', 3000)}`,
  sessionSecret: req('SESSION_SECRET'),

  twitch: {
    clientId: req('TWITCH_CLIENT_ID'),
    clientSecret: req('TWITCH_CLIENT_SECRET'),
    redirectUri: process.env.TWITCH_REDIRECT_URI ?? `http://localhost:${num('PORT', 3000)}/auth/callback`,
  },

  bot: {
    enabled: process.env.BOT_ENABLED !== 'false',
    tokenFile: process.env.BOT_TOKEN_FILE ?? './bot-tokens.json',
  },

  // Single tenant for now. Every row still carries channel_id so a second
  // channel is a routing change, not a data migration.
  channel: {
    id: req('CHANNEL_ID'),
    login: req('CHANNEL_LOGIN').toLowerCase(),
  },

  rules: {
    shortlistSize: num('SHORTLIST_SIZE', 5),
    nominationsPerUser: num('NOMINATIONS_PER_USER', 2),
    pollDurationSeconds: num('POLL_DURATION_SECONDS', 240),
    repeatLockoutWeeks: num('REPEAT_LOCKOUT_WEEKS', 12),
  },

  dbPath: process.env.DB_PATH ?? './movienight.db',
} as const;
