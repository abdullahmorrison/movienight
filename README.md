# Movie Night

Chat votes on the movie. Nominations run all week; the streamer opens a short
poll on stream. Votes come from the website or from Twitch chat — both keyed on
the same Twitch user id, so one person is one ballot either way.

## How it works

**All week** — anyone searches for a movie and nominates it, or types
`!nominate The Thing` in chat. Each person has a small number of slots; a
nomination stops using one the moment somebody else backs it, and an unbacked
one can be taken back to free the slot up. Picks come from TMDB, so every nomination has a
poster, a year, and a stable id — which keeps The Thing (1982) and The Thing
(2011) apart. Adding interest ranks the shortlist. It is not the vote.

**On stream** — the streamer opens a poll on the top N. The board freezes:
nominations and interest are refused while a poll runs, so the shortlist cannot
shift under people mid-vote. One vote each; you can move it until the timer runs
out. Most votes wins.

**If it draws** — nothing is decided. The tied movies stay on the board and the
streamer either runs a tiebreaker between just those, or calls it themselves.
A poll is never quietly resolved in favour of one side.

**After** — the winner leaves the board and can't come back for
`REPEAT_LOCKOUT_WEEKS`. Everyone else carries over with their interest intact.

The streamer can veto anything on the board at any time.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm run dev
```

### Twitch app

Create one at https://dev.twitch.tv/console/apps. Add the redirect URI:

- `http://localhost:3000/auth/callback` — viewers signing in

Put the client id and secret in `.env` and set `CHANNEL_LOGIN` to the streamer's
username. Leave `CHANNEL_ID` blank — it gets looked up from the login at boot.

### Movie search

Get a key at https://www.themoviedb.org/settings/api (free, instant) and set
`TMDB_API_KEY`. Both the v3 key and the v4 read token work.

Without a key the app still runs — nominations fall back to plain typed titles
with no posters.

### Chat

Nothing to set up. Twitch allows anonymous read-only connections, so the app
joins the channel with no bot account and no token, and it never posts.

Set `BOT_ENABLED=false` to run the site without reading chat at all.

## Pages

| Path       | Who        | What |
|------------|------------|------|
| `/`        | viewers    | Search and nominate, add interest, vote |
| `/overlay` | OBS        | Live bars + timer, transparent background |
| `/poll-controls` | streamer | Open/close the vote, break ties, veto. Built for a phone |

`/overlay?solid=1` gives it a background for previewing outside OBS.

### Accent colour

Twitch purple by default. Append `?accent=red` to any page for the
streaming-service red, `?accent=purple` to go back — the choice sticks per
browser. To change the default, edit `--accent` in `public/app.css` and the
matching `:root` block in `public/overlay.html`.

Urgency colours (the countdown under 30s, the live dot) deliberately stay red
whatever the accent is.

## Chat commands

| Command | Who |
|---|---|
| `!vote 2` | anyone, while a poll is open |

That is the whole list, on purpose. Voting is one number and needs no reply, so
it works well in chat. Nominating does not: picking the right film out of
several with the same title needs search, a poster and a year, and a typo in a
chat line silently nominates the wrong movie. Everything else happens on the
site, and the streamer's controls are on `/poll-controls`.

The app never writes to chat, so there is no reply to any command.

## Scripts

```bash
npm run dev              # tsx watch
npm test                 # typecheck + all three suites below
npm run smoke            # voting rules, against a throwaway database
npm run test:api         # HTTP layer: auth, streamer-only guards, validation
npm run test:migration   # boots on a first-version database and checks upgrades
npm run dev-login <userId> <login>   # mint a session without Twitch, dev only
```

`dev-login` prints a cookie. Use the channel id as `<userId>` to get broadcaster
powers. Handy before the Twitch app exists:

```bash
curl -s localhost:3000/api/state -H "Cookie: $(npm run -s dev-login 4242 alice)"
```

## Settings

All in `.env`: `SHORTLIST_SIZE`, `NOMINATIONS_PER_USER`, `POLL_DURATION_SECONDS`,
`REPEAT_LOCKOUT_WEEKS`, `RESULTS_VISIBLE_HOURS`.

## Notes

- **State lives in SQLite, not memory.** A restart mid-poll resumes with the
  tally and the timer intact. If the process was down past the deadline, the
  poll closes on the way back up.
- **Twitch access tokens for viewers are never stored.** Sign-in uses no scopes,
  reads the id and login, and throws the token away.
- **Every table carries `channel_id`** even though only one channel is served.
  A second streamer is a routing change, not a data migration.
- **Nominations dedupe on TMDB id**, falling back to a normalised title for
  anything typed in free-form.
