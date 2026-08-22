/**
 * Exercises the HTTP layer: auth, the streamer-only guards, the board freeze and
 * request validation. smoke.ts calls the database functions directly and so
 * never sees any of this.
 *
 * Run: npm run test:api
 */
process.env.DB_PATH = './api-test.db';
process.env.SESSION_SECRET = 'api-test-secret';
process.env.TWITCH_CLIENT_ID = 'test';
process.env.TWITCH_CLIENT_SECRET = 'test';
process.env.CHANNEL_ID = '5000';           // set, so no Twitch lookup happens
process.env.CHANNEL_LOGIN = 'teststreamer';
process.env.TMDB_API_KEY = '';
process.env.BOT_ENABLED = 'false';
process.env.NOMINATIONS_PER_USER = '2';
process.env.SHORTLIST_SIZE = '5';
process.env.ADMIN_IDS = '6003';           // not the broadcaster, still gets the controls

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';

for (const f of ['./api-test.db', './api-test.db-wal', './api-test.db-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const { config } = await import('../src/config.js');
const q = await import('../src/db/queries.js');
const { createServer } = await import('../src/web/server.js');

const CH = config.channel.id;
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     expected ${e}\n     got      ${a}`}`);
}

/** Mints a signed session cookie the same way the auth middleware reads one. */
function sessionFor(userId: string, login: string): string {
  q.upsertUser(userId, login, login);
  const sid = crypto.randomBytes(18).toString('base64url');
  q.createSession(sid, CH, userId, 3600_000);
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url');
  return `mn_session=${sid}.${sig}`;
}

const server = createServer();
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

type Res = { status: number; body: any };
async function req(method: string, path: string, cookie?: string, body?: unknown): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* html or a redirect */
  }
  return { status: res.status, body: parsed };
}

const streamer = sessionFor(CH, 'teststreamer');
const viewer = sessionFor('6001', 'viewer');
const other = sessionFor('6002', 'other');
const admin = sessionFor('6003', 'admin');

console.log('\n— signed out —');
check('state is readable by anyone', (await req('GET', '/api/state')).status, 200);
check('but reports nobody', (await req('GET', '/api/state')).body.me, null);
check('nominating needs a session', (await req('POST', '/api/nominate', undefined, { title: 'X' })).status, 401);
check('voting needs a session', (await req('POST', '/api/vote', undefined, { nominationId: 1 })).status, 401);
check('search needs a session', (await req('GET', '/api/search?q=alien')).status, 401);

console.log('\n— streamer-only endpoints —');
for (const path of ['/api/poll/open', '/api/poll/close', '/api/poll/cancel', '/api/poll/tiebreak', '/api/poll/settle', '/api/poll/dismiss', '/api/settings/tally']) {
  check(`${path} rejects a viewer`, (await req('POST', path, viewer)).status, 403);
  check(`${path} rejects the signed out`, (await req('POST', path, undefined)).status, 401);
}
check('veto rejects a viewer', (await req('POST', '/api/veto/1', viewer, {})).status, 403);

console.log('\n— admins —');
{
  const me = (await req('GET', '/api/state', admin)).body.me;
  check('an admin is not the broadcaster', me.isBroadcaster, false);
  check('but can control', me.canControl, true);
  check('a viewer cannot', (await req('GET', '/api/state', viewer)).body.me.canControl, false);
  check('the streamer still can', (await req('GET', '/api/state', streamer)).body.me.canControl, true);
  // 409 not 403: it got past the guard and found no poll to cancel.
  check('an admin passes the guard', (await req('POST', '/api/poll/cancel', admin)).status, 409);
  check('and sees real counts', (await req('GET', '/api/state?full=1', admin)).status, 200);
}

console.log('\n— nominating —');
check('a title is required', (await req('POST', '/api/nominate', viewer, {})).status, 400);
const n1 = await req('POST', '/api/nominate', viewer, { title: 'Alien' });
check('a plain title works without TMDB', n1.status, 200);
const n2 = await req('POST', '/api/nominate', viewer, { title: 'Aliens' });
check('a second one works', n2.status, 200);
check('a third hits the cap', (await req('POST', '/api/nominate', viewer, { title: 'Predator' })).status, 409);
check(
  're-nominating the same title merges instead of duplicating',
  (await req('POST', '/api/nominate', other, { title: 'alien' })).body.merged,
  true,
);

console.log('\n— taking one back —');
check(
  "you cannot take back someone else's",
  (await req('POST', `/api/nominate/${n2.body.id}/withdraw`, other)).status,
  409,
);
check(
  'a backed nomination stays',
  (await req('POST', `/api/nominate/${n1.body.id}/withdraw`, viewer)).status,
  409,
);
check('an unbacked one goes', (await req('POST', `/api/nominate/${n2.body.id}/withdraw`, viewer)).status, 200);
check('a bad id is rejected', (await req('POST', '/api/nominate/abc/withdraw', viewer)).status, 400);

// Reaching the cap is not a precondition for taking one back.
const lone = await req('POST', '/api/nominate', other, { title: 'Ronin' });
check('a lone nomination can be taken back', (await req('POST', `/api/nominate/${lone.body.id}/withdraw`, other)).status, 200);

console.log('\n— the board freezes while voting —');
await req('POST', '/api/nominate', other, { title: 'Heat' });
const opened = await req('POST', '/api/poll/open', streamer, { durationSeconds: 300 });
check('the streamer can open a poll', opened.status, 200);
check('nominating is refused', (await req('POST', '/api/nominate', other, { title: 'Speed' })).status, 409);
check('so is marking interest', (await req('POST', `/api/interest/${n1.body.id}`, other)).status, 409);
check('and so is taking one back', (await req('POST', `/api/nominate/${n1.body.id}/withdraw`, viewer)).status, 409);
check('a second poll is refused', (await req('POST', '/api/poll/open', streamer)).status, 409);

// The ballot is fixed at open, so a veto now could not remove the movie from it.
check('the streamer cannot veto mid-poll', (await req('POST', `/api/veto/${n1.body.id}`, streamer, {})).status, 409);
check('nor un-veto', (await req('POST', `/api/unveto/${n1.body.id}`, streamer)).status, 409);

console.log('\n— voting —');
const state = (await req('GET', '/api/state')).body;
const [optA, optB] = state.options;
check('the poll is open', state.phase, 'voting');
check('a vote lands', (await req('POST', '/api/vote', viewer, { nominationId: optA.nominationId })).status, 200);
check('a movie not on the poll is refused', (await req('POST', '/api/vote', viewer, { nominationId: 99999 })).status, 409);
check('a non-numeric id is rejected', (await req('POST', '/api/vote', viewer, { nominationId: 'x' })).status, 400);
await req('POST', '/api/vote', viewer, { nominationId: optB.nominationId });
const afterSwitch = (await req('GET', '/api/state', viewer)).body;
check('switching moves the vote rather than adding one', afterSwitch.voters, 1);
check('and the page knows which one is yours', afterSwitch.myVote, optB.nominationId);

console.log('\n— hiding the running tally —');
check('viewers see counts by default', (await req('GET', '/api/state')).body.tallyHidden, false);
check('a viewer cannot change the setting', (await req('POST', '/api/settings/tally', viewer, { show: false })).status, 403);
check('the value must be a boolean', (await req('POST', '/api/settings/tally', streamer, { show: 'no' })).status, 400);
check('the streamer turns it off', (await req('POST', '/api/settings/tally', streamer, { show: false })).status, 200);

const hiddenPublic = (await req('GET', '/api/state')).body;
check('viewers are told the counts are hidden', hiddenPublic.tallyHidden, true);
// The point is that the numbers are absent, not merely unrendered.
check('and every count is stripped from their payload',
  (hiddenPublic.options as any[]).map((o) => o.votes), [0, 0]);
check('turnout still shows', hiddenPublic.voters, 1);

// The streamer on the vote page is a viewer like anyone else.
const ownerPlain = (await req('GET', '/api/state', streamer)).body;
check('the streamer sees the viewer page as viewers do', ownerPlain.tallyHidden, true);
check('with the counts gone there too',
  (ownerPlain.options as any[]).reduce((n, o) => n + o.votes, 0), 0);

const hiddenOwner = (await req('GET', '/api/state?full=1', streamer)).body;
check('the controls page still gets the real counts',
  (hiddenOwner.options as any[]).reduce((n, o) => n + o.votes, 0), 1);
const viewerFull = (await req('GET', '/api/state?full=1', viewer)).body;
check('and a viewer asking for them is refused', viewerFull.tallyHidden, true);
check('getting zeros back', (viewerFull.options as any[]).reduce((n, o) => n + o.votes, 0), 0);

await req('POST', '/api/settings/tally', streamer, { show: true });
check('turning it back on restores them', (await req('GET', '/api/state')).body.tallyHidden, false);
await req('POST', '/api/settings/tally', streamer, { show: false });

console.log('\n— closing —');
check('a tiebreaker without a tie is refused', (await req('POST', '/api/poll/tiebreak', streamer)).status, 409);
const closed = await req('POST', '/api/poll/close', streamer);
check('closing reports the outcome', closed.body.outcome, 'winner');
// Hiding covers the live count only; the result itself is the payoff.
const afterClose = (await req('GET', '/api/state')).body;
check('the final tally is shown even with hiding on', afterClose.tallyHidden, false);
check('with the real numbers', (afterClose.options as any[]).reduce((n, o) => n + o.votes, 0), 1);
await req('POST', '/api/settings/tally', streamer, { show: true });
check('closing again is refused', (await req('POST', '/api/poll/close', streamer)).status, 409);
check('nominating works again', (await req('POST', '/api/nominate', other, { title: 'Speed' })).status, 200);
// The winner is still up at this point: nothing that edits the board is allowed
// and the next poll has to wait until it is cleared.
check('a new poll is refused while a result is up', (await req('POST', '/api/poll/open', streamer)).status, 409);
check('vetoing is refused while a result is up', (await req('POST', `/api/veto/${n1.body.id}`, streamer, {})).status, 409);
await req('POST', '/api/poll/dismiss', streamer);
check('and works once it is cleared', (await req('POST', `/api/veto/${n1.body.id}`, streamer, {})).status, 200);
check('a vetoed movie leaves the board',
  ((await req('GET', '/api/state')).body.nominations as any[]).some((n) => n.id === n1.body.id), false);

console.log('\n— clearing the result —');
check('the previous section already cleared it', (await req('GET', '/api/state')).body.phase, 'nominating');
check('clearing again is refused', (await req('POST', '/api/poll/dismiss', streamer)).status, 409);

console.log('\n— cancelling a poll —');
check('cancelling with no poll open is refused', (await req('POST', '/api/poll/cancel', streamer)).status, 409);
// Earlier sections consumed the board; a poll needs at least two choices.
await req('POST', '/api/nominate', other, { title: 'Ronin' });
await req('POST', '/api/nominate', viewer, { title: 'Sicario' });
const boardBefore = ((await req('GET', '/api/state')).body.nominations as any[]).map((n) => n.id).sort();
check('a poll opens for the cancel test', (await req('POST', '/api/poll/open', streamer, { durationSeconds: 300 })).status, 200);
const cancelOpts = (await req('GET', '/api/state')).body.options;
await req('POST', '/api/vote', viewer, { nominationId: cancelOpts[0].nominationId });
check('a viewer cannot cancel', (await req('POST', '/api/poll/cancel', viewer)).status, 403);
check('the streamer can', (await req('POST', '/api/poll/cancel', streamer)).status, 200);
const afterCancel = (await req('GET', '/api/state')).body;
check('no result is shown', afterCancel.phase, 'nominating');
check('nothing won', afterCancel.winner, null);
check('every movie stayed on the board',
  (afterCancel.nominations as any[]).map((n) => n.id).sort(), boardBefore);
check('and a new poll can start', (await req('POST', '/api/poll/open', streamer, { durationSeconds: 60 })).status, 200);
await req('POST', '/api/poll/cancel', streamer);

console.log('\n— search without a TMDB key —');
const search = await req('GET', '/api/search?q=alien', viewer);
check('reports itself as off rather than failing', search.body, { enabled: false, results: [] });

server.close();
console.log(failures === 0 ? '\n🎉 all API checks passed\n' : `\n💥 ${failures} API check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
