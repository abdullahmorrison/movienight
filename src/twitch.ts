import { config } from './config.js';

let appToken: { value: string; expiresAt: number } | null = null;

/** Client-credentials token — enough for public lookups, no user login involved. */
async function getAppToken(): Promise<string> {
  if (appToken && Date.now() < appToken.expiresAt - 60_000) return appToken.value;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Twitch app token failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { access_token: string; expires_in: number };
  appToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return appToken.value;
}

export async function lookupUserId(login: string): Promise<string | null> {
  const token = await getAppToken();
  const url = new URL('https://api.twitch.tv/helix/users');
  url.searchParams.set('login', login.toLowerCase());

  const res = await fetch(url, {
    headers: { 'Client-Id': config.twitch.clientId, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Twitch user lookup failed: ${res.status}`);

  const body = (await res.json()) as { data: { id: string }[] };
  return body.data[0]?.id ?? null;
}

/**
 * CHANNEL_ID is just the numeric form of CHANNEL_LOGIN, so look it up rather
 * than making anyone hunt for it. Must run before the database is touched.
 */
export async function resolveChannelId(): Promise<void> {
  if (config.channel.id) return;

  const id = await lookupUserId(config.channel.login);
  if (!id) throw new Error(`No such Twitch channel: ${config.channel.login}`);

  config.channel.id = id;
  console.log(`[twitch] resolved #${config.channel.login} -> ${id}`);
}
