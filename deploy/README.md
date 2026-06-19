# Deployment

Irodori is a static site. The pipeline (`.github/workflows/deploy.yml`) runs on
every push to `master` (and via manual **Run workflow**):

1. **test** — `npm test` (76 tests). Deploy only runs if this is green.
2. **deploy** — stage runtime assets → rsync to `/opt/irodori` → install the
   nginx vhost → provision/renew SSL with certbot.

## Required GitHub configuration

Set these under **Settings → Secrets and variables → Actions**.

| Name              | Where            | Value |
|-------------------|------------------|-------|
| `SSH_PRIVATE_KEY` | **Secrets**      | Private key whose public half is in the server user's `~/.ssh/authorized_keys` |
| `SSH_HOST`        | **Secrets**      | Server hostname or IP |
| `SSH_USER`        | **Secrets**      | SSH login user (must have **passwordless sudo**) |
| `CERTBOT_EMAIL`   | Variables (opt.) | Email for Let's Encrypt expiry notices. If unset, certbot registers without an email. |

> The three SSH values are read from `secrets.*`. `CERTBOT_EMAIL` is optional and
> read from `vars.*` — leave it unset to have certbot register without an email.

## Server prerequisites

- nginx installed, with `sites-available` / `sites-enabled` (Debian/Ubuntu layout).
- `certbot` + the nginx plugin (`sudo apt install certbot python3-certbot-nginx`).
- DNS: `irodori.lasseharm.space` → server IP, ports **80** and **443** open
  (certbot's HTTP-01 challenge needs port 80 reachable).
- The SSH user can `sudo` without a password prompt.

## SSL

`deploy/nginx/irodori.conf` ships a plain HTTP vhost. On first deploy
`certbot --nginx` obtains the certificate and rewrites that file to add the 443
block and an HTTP→HTTPS redirect. Subsequent deploys are idempotent (certbot
sees the existing cert and no-ops); the system certbot timer handles renewals
between deploys.

## What gets deployed

Only `index.html`, `css/`, `js/`, `vendor/`, and `docs/assets/`. Tests,
specs (`docs/superpowers/`), and local `.3mf`/`.jpeg` working files never leave
the runner.
