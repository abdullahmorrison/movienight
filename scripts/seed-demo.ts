/**
 * Fills the board with real films so the site can be looked at with something
 * on it. Goes through the HTTP API, so open pages update live and every rule —
 * the nomination cap, the release check, duplicates — applies as normal.
 *
 * Dev only. Run against a live server: npm run seed-demo
 */
import crypto from 'node:crypto';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
const { resolveChannelId } = await import('../src/twitch.js');
await resolveChannelId();
const q = await import('../src/db/queries.js');

const BASE = process.env.SEED_URL ?? `http://localhost:${config.port}`;

/**
 * Real TMDB ids with the backing each should end up with, so the board has a
 * shape worth looking at instead of everything tied on one.
 */
const FILMS: { title: string; tmdbId: number; want: number }[] = [
  { title: 'Alien', tmdbId: 348, want: 9 },
  { title: 'The Thing', tmdbId: 1091, want: 8 },
  { title: 'Mad Max: Fury Road', tmdbId: 76341, want: 7 },
  { title: 'Blade Runner', tmdbId: 78, want: 7 },
  { title: 'Spirited Away', tmdbId: 129, want: 6 },
  { title: 'The Matrix', tmdbId: 603, want: 5 },
  { title: 'Parasite', tmdbId: 496243, want: 5 },
  { title: 'Back to the Future', tmdbId: 105, want: 4 },
  { title: 'Jurassic Park', tmdbId: 329, want: 4 },
  { title: 'Akira', tmdbId: 149, want: 3 },
  { title: 'The Shining', tmdbId: 694, want: 3 },
  { title: 'Pulp Fiction', tmdbId: 680, want: 3 },
  { title: 'Ghostbusters', tmdbId: 620, want: 2 },
  { title: 'The Terminator', tmdbId: 218, want: 2 },
  { title: 'Raiders of the Lost Ark', tmdbId: 85, want: 2 },
  { title: 'Heat', tmdbId: 949, want: 2 },
  { title: 'Se7en', tmdbId: 807, want: 1 },
  { title: 'The Prestige', tmdbId: 1124, want: 1 },
  { title: 'Everything Everywhere All at Once', tmdbId: 545611, want: 1 },
  { title: 'Arrival', tmdbId: 329865, want: 1 },
];

const VIEWERS = [
  'kaijufan', 'popcornpete', 'lurkerlarry', 'reelrachel', 'nightowl',
  'grainysam', 'vhsvicky', 'directorscut', 'matineemo', 'creditsroller',
];

function cookieFor(userId: string, login: string): string {
  q.upsertUser(userId, login, login);
  const sid = crypto.randomBytes(18).toString('base64url');
  q.createSession(sid, config.channel.id, userId, 24 * 60 * 60 * 1000);
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url');
  return `mn_session=${sid}.${sig}`;
}

async function post(path: string, cookie: string, body: unknown = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const owner = cookieFor(config.channel.id, config.channel.login);
const viewers = VIEWERS.map((name, i) => {
  const id = `8800000${i}`;
  return { name, id, cookie: cookieFor(id, name) };
});

// A vote in progress would refuse every nomination, and a finished one blocks
// the board until it is cleared.
await post('/api/poll/cancel', owner);
await post('/api/poll/dismiss', owner);

console.log(`\nSeeding ${BASE}\n`);

let added = 0;
for (const [i, film] of FILMS.entries()) {
  const who = viewers[i % viewers.length]!;
  const r = await post('/api/nominate', who.cookie, { tmdbId: film.tmdbId });
  if (r.status === 200 && !r.body.merged) {
    added++;
    console.log(`  + ${r.body.title ?? film.title}  — ${who.name}`);
  } else {
    console.log(`  · ${film.title}: ${r.body.error ?? 'already on the board'}`);
  }
}

// Bring each film to its target rather than backing by position: the board
// reorders as interest lands, so position is a moving target.
const byTmdb = new Map(
  q.listNominations(config.channel.id).map((n) => [n.tmdb_id, n]),
);
let backs = 0;
for (const film of FILMS) {
  const nom = byTmdb.get(film.tmdbId);
  if (!nom) continue;
  for (const who of viewers.slice(0, Math.min(film.want, viewers.length))) {
    // Interest is a toggle, so backing something twice would take it away.
    // Check first, and the script converges however often it is run.
    if (q.myInterest(config.channel.id, who.id).includes(nom.id)) continue;
    const r = await post(`/api/interest/${nom.id}`, who.cookie);
    if (r.status === 200 && r.body.interested) backs++;
  }
}

const final = q.listNominations(config.channel.id);
console.log(`\n${added} nominated, ${backs} backed. Board now:\n`);
for (const [i, n] of final.entries()) {
  const flag = i < config.rules.shortlistSize ? '★' : ' ';
  console.log(`  ${flag} ${String(n.interest).padStart(2)}  ${n.title}${n.year ? ` (${n.year})` : ''}`);
}
console.log();
