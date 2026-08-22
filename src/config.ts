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

  tmdb: {
    // Optional: without it, nominations fall back to plain typed titles.
    apiKey: process.env.TMDB_API_KEY ?? '',
    imageBase: process.env.TMDB_IMAGE_BASE ?? 'https://image.tmdb.org/t/p',
  },

  bot: {
    enabled: process.env.BOT_ENABLED !== 'false',
    tokenFile: process.env.BOT_TOKEN_FILE ?? './bot-tokens.json',
  },

  // Single tenant for now. Every row still carries channel_id so a second
  // channel is a routing change, not a data migration.
  // `id` starts empty when unset and is filled in by resolveChannelId() at boot.
  channel: {
    id: process.env.CHANNEL_ID ?? '',
    login: req('CHANNEL_LOGIN').toLowerCase(),
  },

  rules: {
    shortlistSize: num('SHORTLIST_SIZE', 5),
    nominationsPerUser: num('NOMINATIONS_PER_USER', 2),
    pollDurationSeconds: num('POLL_DURATION_SECONDS', 240),
    repeatLockoutWeeks: num('REPEAT_LOCKOUT_WEEKS', 12),
    // How long the winner stays on the front page before it goes back to
    // taking nominations for next time.
    resultsVisibleHours: num('RESULTS_VISIBLE_HOURS', 12),
  },

  dbPath: process.env.DB_PATH ?? './movienight.db',
};
