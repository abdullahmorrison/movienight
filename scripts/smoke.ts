/**
 * End-to-end check of the voting rules against a throwaway database.
 * Run: npm run smoke
 */
process.env.DB_PATH = process.env.SMOKE_DB ?? './smoke.db';
process.env.SESSION_SECRET ??= 'smoke';
process.env.TWITCH_CLIENT_ID ??= 'smoke';
process.env.TWITCH_CLIENT_SECRET ??= 'smoke';
process.env.CHANNEL_ID ??= '100000001';
process.env.CHANNEL_LOGIN ??= 'tenzinniznet';
process.env.NOMINATIONS_PER_USER ??= '2';
process.env.SHORTLIST_SIZE ??= '3';
process.env.BOT_ENABLED = 'false';

import fs from 'node:fs';
for (const f of ['./smoke.db', './smoke.db-wal', './smoke.db-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const { config } = await import('../src/config.js');
const q = await import('../src/db/queries.js');
const poll = await import('../src/poll.js');

const CH = config.channel.id;
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     expected ${e}\n     got      ${a}`}`);
}

// Cast of chatters.
const users = { alice: '1', bob: '2', carol: '3', dave: '4', streamer: CH };
for (const [login, id] of Object.entries(users)) q.upsertUser(id, login, login);

console.log('\n— nominations —');
const thing = q.nominate(CH, 'The Thing', users.alice);
const speed = q.nominate(CH, 'Speed', users.bob);
const heat = q.nominate(CH, 'Heat', users.carol);
const paddington = q.nominate(CH, 'Paddington 2', users.dave);
check('nominating works', thing.ok && speed.ok && heat.ok && paddington.ok, true);

check(
  'duplicate title is refused and points at the original',
  q.nominate(CH, 'the thing!', users.bob),
  { ok: false, reason: 'duplicate', id: thing.ok ? thing.id : -1 },
);

q.nominate(CH, 'Aliens', users.alice);
const overCap = q.nominate(CH, 'Predator', users.alice);
check('nomination cap holds', overCap.ok === false && overCap.reason === 'cap', true);

console.log('\n— interest —');
if (!thing.ok || !speed.ok || !heat.ok) throw new Error('setup failed');
q.addInterest(CH, thing.id, users.bob);
q.addInterest(CH, thing.id, users.carol);
q.addInterest(CH, speed.id, users.carol);
check('nominator gets implicit interest', q.myInterest(CH, users.alice).includes(thing.id), true);
check('toggle off', q.toggleInterest(CH, thing.id, users.bob), false);
check('toggle back on', q.toggleInterest(CH, thing.id, users.bob), true);

console.log('\n— veto —');
check('veto removes it from the board', q.veto(CH, paddington.ok ? paddington.id : -1, 'seen it'), true);
check(
  'vetoed title is gone',
  q.listNominations(CH).some((n) => n.title === 'Paddington 2'),
  false,
);

console.log('\n— poll —');
const p = poll.open(CH, 120);
const options = q.pollOptions(CH, p.id);
check('ballot is the top N by interest', options.length, config.rules.shortlistSize);
check('most interest is position 1', options[0]!.title, 'The Thing');

// Approval voting: voters pick everything they'd watch.
q.castBallot(CH, p.id, users.alice, [options[0]!.nomination_id, options[1]!.nomination_id], 'web');
q.castBallot(CH, p.id, users.bob, [options[1]!.nomination_id], 'chat');
q.castBallot(CH, p.id, users.carol, [options[1]!.nomination_id, options[2]!.nomination_id], 'chat');

// Same person votes in chat then changes their mind on the site.
q.castBallot(CH, p.id, users.dave, [options[0]!.nomination_id], 'chat');
q.castBallot(CH, p.id, users.dave, [options[1]!.nomination_id, options[2]!.nomination_id], 'web');
check('one identity, one ballot — the web vote replaces the chat vote', q.myBallot(CH, p.id, users.dave), [
  options[1]!.nomination_id,
  options[2]!.nomination_id,
]);
check('voter count counts people, not picks', q.voterCount(CH, p.id), 4);

const results = q.tally(CH, p.id);
// Dave's chat pick of option 1 was replaced by his web ballot, so it counts once for Alice only.
check('approvals tallied', results.map((r) => [r.title, r.approvals]), [
  [options[1]!.title, 4],
  [options[2]!.title, 2],
  [options[0]!.title, 1],
]);

check(
  'votes for movies not on the ballot are dropped',
  q.castBallot(CH, p.id, users.alice, [99999], 'chat'),
  0,
);

console.log('\n— closing —');
const winner = poll.close(CH);
check('winner is the most-approved', winner?.title, options[1]!.title);
check('poll is closed', q.getOpenPoll(CH), undefined);

console.log('\n— after the poll —');
check(
  'winner leaves the board',
  q.listNominations(CH).some((n) => n.id === winner!.nomination_id),
  false,
);
check(
  'losers carry over with interest intact',
  q.listNominations(CH).some((n) => n.id === options[0]!.nomination_id),
  true,
);
const relock = q.nominate(CH, winner!.title, users.bob);
check('winner is locked out from re-nomination', relock.ok === false && relock.reason === 'locked', true);

console.log('\n— restart mid-poll —');
const p2 = poll.open(CH, 120);
q.castBallot(CH, p2.id, users.alice, [q.pollOptions(CH, p2.id)[0]!.nomination_id], 'web');
poll.resume(CH); // simulates the process coming back up
check('poll survives a restart', q.getOpenPoll(CH)?.id, p2.id);
check('votes survive a restart', q.voterCount(CH, p2.id), 1);
poll.close(CH);

console.log(failures === 0 ? '\n🎉 all checks passed\n' : `\n💥 ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
