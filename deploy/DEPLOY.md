# Deploying

Two `systemd --user` services: the app, and a Cloudflare Tunnel that publishes
it. No root anywhere — user units run as you, so nothing else on the machine is
touched, and nothing here needs `sudo`.

Not in Docker: the only real collision risks are a port and a Node version, and
these pin both. A container would add a native `better-sqlite3` build and a
volume mount for the database in exchange for isolation `MemoryMax` and
`CPUQuota` already give.

A shared box is the normal case, so check first:

```sh
ss -tln | grep -E ':30[0-9][0-9] '     # pick a port nothing answers on
cloudflared tunnel list                # note any tunnel already running
```

## 1. Node 22, via nvm

The system Node is whatever else on the box needs; leave it alone.

```sh
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 22
node -v
```

## 2. Build

```sh
git clone https://github.com/abdullahmorrison/movienight ~/movienight
cd ~/movienight && npm ci && npm run build
```

## 3. Configure

```sh
cp .env.example .env && chmod 600 .env && nano .env
```

| Key | Value |
| --- | --- |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `CHANNEL_LOGIN` | the streamer's Twitch login |
| `TWITCH_CLIENT_ID` / `_SECRET` | from dev.twitch.tv |
| `TMDB_API_KEY` | from themoviedb.org |
| `ADMIN_LOGINS` | your login — keeps you on the controls page |
| `PORT` | the free one from above |
| `DB_PATH` | absolute, e.g. `/home/you/movienight/movienight.db` |
| `PUBLIC_URL` | `https://<login>.<domain>`, no trailing slash |
| `TWITCH_REDIRECT_URI` | `<PUBLIC_URL>/auth/callback` |

`PUBLIC_URL` starting with `https://` is what flips the session cookie to
`Secure`. The redirect URI has to be added to the app on dev.twitch.tv, matching
exactly.

## 4. Its own tunnel

Give the app a tunnel of its own rather than adding an ingress rule to one that
already serves something — a restart then cannot take the other thing down.

```sh
cloudflared tunnel login          # browser; pick the zone this domain lives in
cloudflared tunnel create movienight
```

`~/.cloudflared/movienight.yml`, with the id it printed:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/you/.cloudflared/<tunnel-id>.json

# Subdomain is the Twitch login, so host routing can read CHANNEL_LOGIN straight
# off it later. One streamer per process today, so one hostname is served.
ingress:
  - hostname: <login>.<domain>
    service: http://localhost:<port>
  - service: http_status:404
```

```sh
cloudflared tunnel route dns movienight <login>.<domain>
```

**`cert.pem` is scoped to the one zone you picked at login.** Given a hostname
outside it, `route dns` does not fail — it appends the name as a subdomain of
the zone it *is* allowed to write, and creates a record you did not want. If the
domain is new, log in again and pick it, or add the CNAME by hand in the
dashboard: name `<login>`, target `<tunnel-id>.cfargotunnel.com`, proxied on.

## 5. Start both

```sh
mkdir -p ~/.config/systemd/user
cp deploy/movienight.service deploy/movienight-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now movienight movienight-tunnel
loginctl enable-linger "$USER"     # or both stop when you log out
```

`enable-linger` is the step that makes this survive a reboot. Without it, user
services die with your session and never come back.

```sh
journalctl --user -u movienight -f
```

Expect `[twitch] resolved #<channel> -> <id>`, `[twitch] controls also granted
to …` and `[bot] reading #<channel>`.

## 6. Keep it awake with the lid shut

On a laptop, `/etc/systemd/logind.conf` — the one thing here that wants root:

```
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
```

```sh
sudo systemctl restart systemd-logind
```

## Updating

```sh
cd ~/movienight && git pull && npm ci && npm run build
systemctl --user restart movienight
```

## Verify

From anywhere, against the public hostname — local `curl` proves nothing about
the tunnel:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/
curl -s -o /dev/null -w '%{http_code}\n%{redirect_url}\n' https://<host>/auth/login
```

The redirect must carry `redirect_uri=` pointing at your own host. Then check
the WebSocket, since everything live rides on it — open the site in two
browsers and back a movie in one; the other updates without a reload.

## Notes

- Back the database up with `sqlite3 movienight.db ".backup backup.db"`, not
  `cp` — it runs in WAL mode.
- A Node upgrade under nvm changes the path in `ExecStart`. The unit pins it, so
  update that line and `daemon-reload` when you bump versions.
- Sessions are keyed to `channel_id`. Changing `CHANNEL_LOGIN` invalidates every
  existing cookie and empties the board, since the old rows belong to the old id.
