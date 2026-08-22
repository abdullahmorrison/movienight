# Deploying to the MacBook

Runs as a systemd service under its own user. Public over Tailscale Funnel —
no domain, no port forwarding, HTTPS handled for you.

Not in Docker: the only things this could collide with are a port and a Node
version, and systemd pins both. A container would add a native `better-sqlite3`
build and a volume mount for the database in exchange for isolation the unit
file already gives (`MemoryMax`, `CPUQuota`, `ProtectSystem=strict`).

## 1. Node

```sh
node -v            # want 22+
command -v node    # must NOT be under ~/.nvm
```

If it is nvm's, install a system-wide one — a system user cannot read another
user's home:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 2. Check it out

```sh
sudo useradd --system --home /srv/movienight --shell /usr/sbin/nologin movienight
sudo git clone https://github.com/abdullahmorrison/movienight /srv/movienight
cd /srv/movienight
sudo npm ci && sudo npm run build
sudo chown -R movienight:movienight /srv/movienight
```

## 3. Go public

```sh
sudo tailscale funnel --bg 3000
tailscale funnel status
```

First run prints a link if Funnel is not enabled on the tailnet yet. The
hostname it reports is your public URL:

```
https://abdullah-morrison-macbook-pro.tail4e587b.ts.net
```

## 4. Configure

```sh
sudo -u movienight cp .env.example .env
sudo -u movienight nano .env
```

| Key | Value |
| --- | --- |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `CHANNEL_LOGIN` | the streamer's Twitch login |
| `TWITCH_CLIENT_ID` / `_SECRET` | from dev.twitch.tv |
| `TMDB_API_KEY` | from themoviedb.org |
| `ADMIN_LOGINS` | `abdullahmorrison` — keeps you on the controls page |
| `PUBLIC_URL` | the Funnel hostname, no trailing slash |
| `TWITCH_REDIRECT_URI` | `<PUBLIC_URL>/auth/callback` |

Add that same redirect URI to the app on dev.twitch.tv, exactly. `PUBLIC_URL`
starting with `https://` is what flips the session cookie to `Secure`.

## 5. Start it

```sh
sudo cp deploy/movienight.service /etc/systemd/system/
sudo systemctl enable --now movienight
journalctl -u movienight -f
```

Expect `[twitch] resolved #<channel> -> <id>` and `[bot] reading #<channel>`.

## 6. Keep it awake with the lid shut

`/etc/systemd/logind.conf`:

```
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
```

```sh
sudo systemctl restart systemd-logind
```

## Updating

```sh
cd /srv/movienight
sudo -u movienight git pull
sudo -u movienight npm ci && sudo -u movienight npm run build
sudo systemctl restart movienight
```

## Notes

- **Test WebSockets first.** Open the site in two browsers and back a movie in
  one — the other should update without a reload. Everything live rides on it.
- The database is `/srv/movienight/movienight.db`. Back it up with
  `sqlite3 movienight.db ".backup backup.db"`, not `cp` (WAL mode).
- Funnel is meant for small-scale sharing. Fine for a chat voting; if the show
  gets big, move to a domain on Cloudflare Tunnel.
