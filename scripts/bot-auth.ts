/**
 * One-time login for the BOT account. Writes bot-tokens.json, which the app
 * then refreshes on its own forever.
 *
 *   npx tsx scripts/bot-auth.ts
 *
 * Requires the redirect URI below in your Twitch app's redirect URIs. Defaults to
 * http://localhost:3001/callback; override with BOT_AUTH_REDIRECT (and
 * BOT_AUTH_PORT if you are tunnelling to a different local port) when Twitch
 * will only accept an HTTPS URL.
 *
 *   BOT_AUTH_REDIRECT=https://your-tunnel.trycloudflare.com/callback \
 *     npx tsx scripts/bot-auth.ts
 *
 * Log in as the BOT account, not your own.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { config } from '../src/config.js';

const PORT = Number(process.env.BOT_AUTH_PORT ?? 3001);
const REDIRECT = process.env.BOT_AUTH_REDIRECT ?? `http://localhost:${PORT}/callback`;
const SCOPES = ['chat:read', 'chat:edit'];
const state = crypto.randomBytes(12).toString('hex');

const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
authUrl.searchParams.set('client_id', config.twitch.clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('force_verify', 'true');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    res.writeHead(400).end('Bad state. Run the script again.');
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
        redirect_uri: REDIRECT,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const token = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const meRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': config.twitch.clientId, Authorization: `Bearer ${token.access_token}` },
    });
    const me = ((await meRes.json()) as { data: { id: string; login: string }[] }).data[0]!;

    await fs.writeFile(
      config.bot.tokenFile,
      JSON.stringify(
        {
          userId: me.id,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresIn: token.expires_in,
          obtainmentTimestamp: Date.now(),
          scope: SCOPES,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log(`\n✅ Saved ${config.bot.tokenFile} for bot account "${me.login}".`);
    console.log(`   Now run: /mod ${me.login} in #${config.channel.login}\n`);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      `<body style="font-family:system-ui;background:#0e0c15;color:#ece9f5;padding:40px">
       <h2>✅ Bot authorised as ${me.login}</h2><p>You can close this tab.</p></body>`,
    );
  } catch (err) {
    console.error(err);
    res.writeHead(500).end(String(err));
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(PORT, () => {
  console.log(`\nListening on :${PORT}, expecting Twitch to redirect to ${REDIRECT}`);
  console.log('\nLog in as the BOT account (not your own) at:\n');
  console.log(`  ${authUrl}\n`);
});
