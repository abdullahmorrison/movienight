import { config } from './config.js';
import { resolveChannelId } from './twitch.js';

// Must happen before anything imports the database: the schema seeds a row for
// this channel, and every table keys on its id.
try {
  await resolveChannelId();
} catch (err) {
  console.error(`[twitch] could not resolve CHANNEL_LOGIN=${config.channel.login}`);
  console.error(`         ${(err as Error).message}`);
  console.error('         Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env, or hardcode CHANNEL_ID.');
  process.exit(1);
}

const { createServer } = await import('./web/server.js');
const { startBot } = await import('./bot/chat.js');
const poll = await import('./poll.js');

const server = createServer();

server.listen(config.port, () => {
  console.log(`[web] http://localhost:${config.port}`);
  console.log(`[web] overlay  /overlay`);
  console.log(`[web] control  /control`);
  poll.resume(config.channel.id);
});

if (config.bot.enabled) {
  startBot().catch((err) => console.error('[bot] failed to start', err));
} else {
  console.log('[bot] disabled (BOT_ENABLED=false)');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[app] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
