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
| `SSH_PRIVATE_KEY` | **Secrets** ⚠️    | Private key whose public half is in the server user's `~/.ssh/authorized_keys` |
| `SSH_HOST`        | Variables        | Server hostname or IP |
| `SSH_USER`        | Variables        | SSH login user (must have **passwordless sudo**) |
| `CERTBOT_EMAIL`   | Variables (opt.) | Email for Let's Encrypt expiry notices. If unset, certbot registers without an email. |

> ⚠️ **`SSH_PRIVATE_KEY` must be a Secret, not a Variable.** Repository
> *Variables* are shown in plaintext in logs and the UI — a private key there is
> effectively leaked. The workflow reads it from `secrets.SSH_PRIVATE_KEY`. Move
> it to **Secrets** if you currently have it as a Variable; `SSH_HOST` and
> `SSH_USER` are fine as Variables.

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
