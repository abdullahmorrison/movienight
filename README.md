# Movie Night

Chat votes on the movie. Nominations run all week; the streamer opens a short
poll on stream. Votes come from the website or from Twitch chat — both keyed on
the same Twitch user id, so one person is one ballot either way.

## How it works

**All week** — anyone searches for a movie and nominates it, or types
`!nominate The Thing` in chat. Picks come from TMDB, so every nomination has a
poster, a year, and a stable id — which keeps The Thing (1982) and The Thing
(2011) apart. Adding interest ranks the shortlist. It is not the vote.

**On stream** — the streamer opens a poll on the top N. Approval voting: check
*every* movie you'd be happy to watch, not just one. Timer runs out, winner locks.

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

Create one at https://dev.twitch.tv/console/apps. Add **both** redirect URIs:

- `http://localhost:3000/auth/callback` — viewers signing in
- `http://localhost:3001/callback` — the one-time bot login

Put the client id and secret in `.env` and set `CHANNEL_LOGIN` to the streamer's
username. Leave `CHANNEL_ID` blank — it gets looked up from the login at boot.

### Movie search

Get a key at https://www.themoviedb.org/settings/api (free, instant) and set
`TMDB_API_KEY`. Both the v3 key and the v4 read token work.

Without a key the app still runs — nominations fall back to plain typed titles
with no posters.

### Chat bot

Make a second Twitch account for the bot, then:

```bash
npm run bot-auth      # log in as the BOT account
```

That writes `bot-tokens.json` and the app refreshes it from then on. Mod the bot
in the channel (`/mod yourbotname`) or follower-only and slow mode will eat its
messages.

Set `BOT_ENABLED=false` to run the site without chat.

## Pages

| Path       | Who        | What |
|------------|------------|------|
| `/`        | viewers    | Search and nominate, add interest, vote |
| `/overlay` | OBS        | Live bars + timer, transparent background |
| `/control` | streamer   | Open/close polls, veto. Built for a phone |

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
| `!nominate <title>` | anyone |
| `!movies` | anyone |
| `!interest <id>` | anyone |
| `!vote 1 3` | anyone, while a poll is open |
| `!poll [seconds]` | mods + streamer |
| `!endpoll` | mods + streamer |
| `!veto <id> [reason]` | mods + streamer |

Votes get no chat reply on purpose — a busy chat would flood. The overlay shows
them land.

## Scripts

```bash
npm run dev         # tsx watch
npm run smoke       # end-to-end check of the voting rules, throwaway db
npm run typecheck
npm run dev-login <userId> <login>   # mint a session without Twitch, dev only
```

`dev-login` prints a cookie. Use the channel id as `<userId>` to get broadcaster
powers. Handy before the Twitch app exists:

```bash
curl -s localhost:3000/api/state -H "Cookie: $(npm run -s dev-login 4242 alice)"
```

## Settings

All in `.env`: `SHORTLIST_SIZE`, `NOMINATIONS_PER_USER`, `POLL_DURATION_SECONDS`,
`REPEAT_LOCKOUT_WEEKS`.

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
