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
const movie = (title: string, tmdbId: number, year: number) => ({
  title,
  tmdbId,
  year,
  posterPath: `/${tmdbId}.jpg`,
  backdropPath: `/${tmdbId}-back.jpg`,
  trailerKey: `yt${tmdbId}`,
  overview: `${title} (${year})`,
});

// Real TMDB ids, so the lockout check can find the winner's again later.
const TMDB: Record<string, [number, number]> = {
  'The Thing': [1091, 1982],
  Speed: [1637, 1994],
  Heat: [949, 1995],
  'Paddington 2': [346648, 2017],
  Aliens: [679, 1986],
  Predator: [106, 1987],
  'The Thing (2011)': [60935, 2011],
};
const pick = (name: string) => movie(name.replace(/ \(\d{4}\)$/, ''), TMDB[name]![0], TMDB[name]![1]);

const thing = q.nominate(CH, movie('The Thing', 1091, 1982), users.alice);
const speed = q.nominate(CH, movie('Speed', 1637, 1994), users.bob);
const heat = q.nominate(CH, movie('Heat', 949, 1995), users.carol);
const paddington = q.nominate(CH, movie('Paddington 2', 346648, 2017), users.dave);
check('nominating works', thing.ok && speed.ok && heat.ok && paddington.ok, true);

check(
  'same TMDB id is refused and points at the original',
  q.nominate(CH, movie('the thing!', 1091, 1982), users.bob),
  { ok: false, reason: 'duplicate', id: thing.ok ? thing.id : -1 },
);

// The whole reason to key on TMDB ids rather than normalised titles.
const remake = q.nominate(CH, pick('The Thing (2011)'), users.bob);
check('a remake with the same title is a separate movie', remake.ok, true);

check(
  'typed titles with no TMDB id still dedupe on the title',
  q.nominate(CH, { title: 'plain title' }, users.carol).ok &&
    !q.nominate(CH, { title: 'Plain  Title!' }, users.dave).ok,
  true,
);

q.nominate(CH, pick('Aliens'), users.alice); // alice is now at her cap of 2
const overCap = q.nominate(CH, pick('Predator'), users.alice);
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
check('posters ride along to the ballot', options[0]!.poster_path, '/1091.jpg');
check('trailers ride along to the ballot', options[0]!.trailer_key, 'yt1091');
check(
  'backdrops reach the snapshot for the hero',
  poll.snapshot(CH).options[0]!.backdrop,
  '/1091-back.jpg',
);

// One vote each.
q.castVote(CH, p.id, users.alice, options[1]!.nomination_id, 'web');
q.castVote(CH, p.id, users.bob, options[1]!.nomination_id, 'chat');
q.castVote(CH, p.id, users.carol, options[2]!.nomination_id, 'chat');

// Same person votes in chat then changes their mind on the site.
q.castVote(CH, p.id, users.dave, options[0]!.nomination_id, 'chat');
q.castVote(CH, p.id, users.dave, options[1]!.nomination_id, 'web');
check('one identity, one vote — the web vote replaces the chat vote', q.myVote(CH, p.id, users.dave),
  options[1]!.nomination_id);
check('changing your vote never adds a second one', q.voterCount(CH, p.id), 4);

const results = q.tally(CH, p.id);
// Dave's chat pick of option 1 was replaced by his web ballot, so it counts once for Alice only.
// alice, bob and dave all landed on option 1; carol on option 2; option 0 lost
// dave's vote when he switched, so it keeps nothing.
check('votes tallied', results.map((r) => [r.title, r.votes]), [
  [options[1]!.title, 3],
  [options[2]!.title, 1],
  [options[0]!.title, 0],
]);

let rejected = false;
try {
  q.castVote(CH, p.id, users.alice, 99999, 'chat');
} catch {
  rejected = true;
}
check('a vote for a movie not on the poll is refused', rejected, true);

console.log('\n— closing —');
const closed = poll.close(CH);
check('a clear result reports a winner', closed?.outcome, 'winner');
check('winner is the most-voted', closed?.outcome === 'winner' ? closed.winner.title : null,
  options[1]!.title);
const winner = closed?.outcome === 'winner' ? closed.winner : null;
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
// dave's only nomination was vetoed, so he has room to try again.
const relock = q.nominate(CH, pick(winner!.title), users.dave);
check('winner is locked out from re-nomination', relock.ok === false && relock.reason === 'locked', true);

console.log('\n— restart mid-poll —');
const p2 = poll.open(CH, 120);
q.castVote(CH, p2.id, users.alice, q.pollOptions(CH, p2.id)[0]!.nomination_id, 'web');
poll.resume(CH); // simulates the process coming back up
check('poll survives a restart', q.getOpenPoll(CH)?.id, p2.id);
check('votes survive a restart', q.voterCount(CH, p2.id), 1);
poll.close(CH);

console.log('\n— tie ordering —');

const tick = () => new Promise((r) => setTimeout(r, 3));
const order = () => q.listNominations(CH).map((n) => n.title);

const u = { a: '10', b: '11', c: '12', d: '13' };
for (const [name, id] of Object.entries(u)) q.upsertUser(id, `tie_${name}`, `tie_${name}`);

// Each nomination starts at 1 (the nominator's own interest).
q.nominate(CH, movie('Alien', 348, 1979), u.a);
await tick();
q.nominate(CH, movie('Solaris', 593, 1972), u.b);

const alienFirst = order().indexOf('Alien') < order().indexOf('Solaris');
check('equal counts keep the order they arrived in', alienFirst, true);

// Solaris pulls ahead on count.
const solarisId = q.listNominations(CH).find((n) => n.title === 'Solaris')!.id;
await tick();
q.addInterest(CH, solarisId, u.c);
check('a higher count does overtake', order().indexOf('Solaris') < order().indexOf('Alien'), true);

// Alien draws level. Solaris got to 2 first, so Alien must not pass it.
const alienId = q.listNominations(CH).find((n) => n.title === 'Alien')!.id;
await tick();
q.addInterest(CH, alienId, u.d);
const tied = q.listNominations(CH).filter((n) => n.title === 'Alien' || n.title === 'Solaris');
check('drawing level does not overtake', tied.map((n) => [n.title, n.interest]), [
  ['Solaris', 2],
  ['Alien', 2],
]);

// And going one better still does.
await tick();
q.addInterest(CH, alienId, u.c);
check('going one better overtakes', order().indexOf('Alien') < order().indexOf('Solaris'), true);

console.log('\n— one vote each —');
const p3 = poll.open(CH, 120);
const opts = q.pollOptions(CH, p3.id);
q.castVote(CH, p3.id, u.a, opts[0]!.nomination_id, 'web');
await tick();
q.castVote(CH, p3.id, u.b, opts[1]!.nomination_id, 'web');
const leader = q.tally(CH, p3.id)[0]!.nomination_id;

// Re-sending the same vote must not restamp it and reshuffle the bars.
await tick();
q.castVote(CH, p3.id, u.a, opts[0]!.nomination_id, 'web');
check('re-sending the same vote keeps the order', q.tally(CH, p3.id)[0]!.nomination_id, leader);

// Switching moves the vote instead of adding one.
q.castVote(CH, p3.id, u.a, opts[1]!.nomination_id, 'web');
const after = new Map(q.tally(CH, p3.id).map((t) => [t.nomination_id, t.votes]));
check('switching moves the vote', [after.get(opts[0]!.nomination_id), after.get(opts[1]!.nomination_id)], [0, 2]);
check('and the voter is still counted once', q.voterCount(CH, p3.id), 2);
poll.close(CH);

console.log('\n— ties —');

const tp = poll.open(CH, 120);
const tOpts = q.pollOptions(CH, tp.id);
q.castVote(CH, tp.id, u.a, tOpts[0]!.nomination_id, 'web');
q.castVote(CH, tp.id, u.b, tOpts[1]!.nomination_id, 'web');

const drawResult = poll.close(CH);
check('a draw is reported as a tie, not resolved quietly', drawResult?.outcome, 'tie');
check(
  'both drawn movies are named',
  drawResult?.outcome === 'tie' ? drawResult.tied.map((t) => t.nomination_id).sort() : [],
  [tOpts[0]!.nomination_id, tOpts[1]!.nomination_id].sort(),
);
check(
  'nothing is marked as won',
  q.listNominations(CH).filter((n) => n.id === tOpts[0]!.nomination_id).length,
  1,
);
check('the drawn movies stay on the board', q.listNominations(CH).filter(
  (n) => n.id === tOpts[0]!.nomination_id || n.id === tOpts[1]!.nomination_id).length, 2);

// A tiebreaker runs between the drawn movies only, whatever else is on the board.
const bp = poll.tiebreak(CH, 120);
check('the tiebreaker only offers the tied movies',
  q.pollOptions(CH, bp.id).map((o) => o.nomination_id).sort(),
  [tOpts[0]!.nomination_id, tOpts[1]!.nomination_id].sort());

q.castVote(CH, bp.id, u.a, tOpts[0]!.nomination_id, 'web');
q.castVote(CH, bp.id, u.b, tOpts[0]!.nomination_id, 'web');
const broken = poll.close(CH);
check('the tiebreaker produces a winner', broken?.outcome, 'winner');
check('and it leaves the board', q.listNominations(CH).some((n) => n.id === tOpts[0]!.nomination_id), false);

// The streamer can also just call it instead of re-running.
const sp = poll.open(CH, 120);
const sOpts = q.pollOptions(CH, sp.id);
q.castVote(CH, sp.id, u.a, sOpts[0]!.nomination_id, 'web');
q.castVote(CH, sp.id, u.b, sOpts[1]!.nomination_id, 'web');
check('drawn again', poll.close(CH)?.outcome, 'tie');
const called = poll.settle(CH, sOpts[1]!.nomination_id);
check('calling it declares that movie the winner', called.nomination_id, sOpts[1]!.nomination_id);
check('and it leaves the board too', q.listNominations(CH).some((n) => n.id === sOpts[1]!.nomination_id), false);

let refused = false;
try {
  poll.settle(CH, sOpts[0]!.nomination_id);
} catch {
  refused = true;
}
check('a settled tie cannot be settled again', refused, true);

console.log('\n— no votes at all —');
const ep = poll.open(CH, 120);
check('an empty poll is neither a win nor a tie', poll.close(CH)?.outcome, 'empty');
void ep;

console.log('\n— the board is frozen while voting —');

// The guard itself lives in the HTTP and chat layers, which this script does
// not exercise; what belongs here is the state they key off.
poll.open(CH, 120);
check('getOpenPoll reports the poll the guards check for', Boolean(q.getOpenPoll(CH)), true);
poll.close(CH);
check('nominations reopen once the poll ends', Boolean(q.getOpenPoll(CH)), false);
const reopened = q.nominate(CH, movie('Predator', 106, 1987), u.c);
check('and nominating works again', reopened.ok, true);

console.log(failures === 0 ? '\n🎉 all checks passed\n' : `\n💥 ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
