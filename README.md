# 🍿 Movie Night

Chat picks the movie for a Twitch streamer's weekly movie night. Nominations run
all week on the site; the streamer opens a timed vote on stream.

Votes come from the website or from chat, both keyed on the same Twitch user id,
so one person is one vote either way.

## How it works

**All week** — anyone signs in and searches for a movie. Picks come from TMDB, so
each one carries a poster, a year and a stable id, which keeps The Thing (1982)
and The Thing (2011) apart. Films that are not out yet are refused. Marking
"want it" ranks the board; it is not the vote.

Each person has a few nomination slots. A nomination stops using one as soon as
somebody else backs it, and an unbacked one can be taken back.

**On stream** — the streamer opens a vote on the most wanted few. The board
freezes: nothing can be nominated, backed, taken back or vetoed while it runs.
One vote each, movable until the timer ends. Most votes wins.

The running tally is shown to viewers by default; **Hide vote counts from
viewers** on the controls turns it off so nobody piles onto whatever is already
ahead. The counts are stripped from the
payload rather than hidden in the page, and the final result is always shown.

Ties are reported, not broken quietly — the drawn films stay on the board and the
streamer runs a tiebreaker between them or calls it. A vote started by mistake
can be cancelled, which decides nothing.

**After** — the winner leaves the board and cannot return for
`REPEAT_LOCKOUT_WEEKS`. Everything else carries over with its interest. The
result headlines the page until it is cleared or `RESULTS_VISIBLE_HOURS` passes,
and nominations reopen once it is.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

**Twitch app** — create one at https://dev.twitch.tv/console/apps with the
redirect URI `http://localhost:3000/auth/callback`. Put the client id and secret
in `.env` and set `CHANNEL_LOGIN`. Leave `CHANNEL_ID` blank; it is looked up at
boot.

**Movie search** — get a free key at https://www.themoviedb.org/settings/api and
set `TMDB_API_KEY`. v3 keys and v4 read tokens both work. Without one the app
still runs, falling back to plain typed titles with no posters.

**Controls access** — the channel owner always has it. `ADMIN_LOGINS` is a
comma-separated list of Twitch logins that get it too, which is how you keep the
controls page when running this on somebody else's channel. Logins are resolved
to ids at boot, since a login can be renamed away and later claimed by someone
else.

**Chat** — nothing to set up. The app joins anonymously, reads `!vote`, and never
posts. `BOT_ENABLED=false` turns it off entirely.

**Production** — [deploy/DEPLOY.md](deploy/DEPLOY.md) runs it as a systemd
service behind Tailscale Funnel.

## Pages

| Path | Who | What |
|---|---|---|
| `/` | viewers | Nominate, back what you want, vote |
| `/poll-controls` | streamer | Start and end votes, break ties, veto. Built for a phone |
| `/overlay` | OBS | Live bars and timer on a transparent background |

The overlay is meant to be added once and left on: it stays invisible until a
vote opens, slides in, holds the winner for `OVERLAY_REVEAL_SECONDS` after it
settles, then slides away.

`/overlay?solid=1` previews the overlay outside OBS. `?accent=red` on any page
swaps Twitch purple for a streaming-service red, remembered per browser.

## Chat

`!vote 2` while a vote is open. That is the only command, on purpose: a single
number needs no reply, whereas nominating needs search, a poster and a year, and
a mistyped title would silently nominate the wrong film.

## Scripts

```bash
npm run dev              # tsx watch
npm test                 # typecheck plus the three suites below
npm run smoke            # voting rules, against a throwaway database
npm run test:api         # HTTP layer: auth, streamer-only guards, validation
npm run test:migration   # boots on a first-version database and checks upgrades
npm run dev-login <id> <login>   # mints a session without Twitch, dev only
```

Pass the channel id to `dev-login` for streamer access.

## Settings

In `.env`: `ADMIN_LOGINS`, `SHORTLIST_SIZE`, `NOMINATIONS_PER_USER`, `POLL_DURATION_SECONDS`,
`REPEAT_LOCKOUT_WEEKS`, `RESULTS_VISIBLE_HOURS`, `OVERLAY_REVEAL_SECONDS`.

## Notes

- **A vote sends the numbers, not the board.** Every other change pushes a full
  snapshot; a vote pushes ~70 bytes and at most once a second. Otherwise a busy
  poll costs voters x viewers snapshots.
- **State is in SQLite, not memory.** A restart mid-vote resumes with the tally
  and timer intact, or closes the vote if it was down past the deadline.
- **Viewer access tokens are never stored.** Sign-in requests no scopes, reads
  the id and login, and discards the token.
- **Every table carries `channel_id`** though one channel is served. A second
  streamer is a routing change, not a data migration.
