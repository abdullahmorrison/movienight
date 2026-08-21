import { config } from './config.js';
import { createServer } from './web/server.js';
import { startBot } from './bot/chat.js';
import * as poll from './poll.js';

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
