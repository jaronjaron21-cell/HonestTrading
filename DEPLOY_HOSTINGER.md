# HonestTrading on Hostinger VPS

This repo is currently used with a Hostinger VPS deployment fronted by `nginx`.

## Mac Mini local setup

Clone the repo:

```bash
cd /Users/jaronfiestada/Documents/Playground
git clone git@github.com:jaronjaron21-cell/HonestTrading.git
cd HonestTrading
```

Create a Mac-local data directory outside the repo so local testing never overwrites tracked repo data:

```bash
mkdir -p /Users/jaronfiestada/Documents/Playground/HonestTrading-local-data
```

Run locally:

```bash
cd /Users/jaronfiestada/Documents/Playground/HonestTrading
DATA_DIR=/Users/jaronfiestada/Documents/Playground/HonestTrading-local-data npm start
```

Open:

- `http://127.0.0.1:4173/login?next=%2F`
- `http://127.0.0.1:4173/shopify-page.html`

## Required runtime variables

The server reads these environment variables directly:

- `PORT`
- `DATA_DIR`
- `AUTH_ENABLED`
- `APP_USERNAME`
- `APP_PASSWORD`
- `SESSION_COOKIE_NAME`
- `SESSION_MAX_AGE_SEC`

Use `.env.example` as the reference list. Do not commit real secrets.

## Production data rule

- Treat the VPS runtime data as the source of truth.
- Keep live data outside Git with `DATA_DIR` pointing to a server path such as `/opt/honesttrading/data` or `/data`.
- Do not deploy local `data/storage.json` over live data.

## VPS audit checklist

Before changing the live deployment, SSH into the VPS and confirm:

```bash
ssh <user>@<hostinger-vps-ip>

pwd
ls -la
ps -axo pid,command | egrep 'node|pm2|docker'
docker ps
pm2 list
systemctl list-units --type=service | egrep 'node|honest|nginx'
nginx -T
find / -name storage.json 2>/dev/null
find / -name 'HonestTrading' 2>/dev/null
printenv | egrep 'PORT|DATA_DIR|APP_|AUTH_|SESSION_'
```

Confirm all of the following:

- app folder path on the VPS
- runtime manager: Docker, `pm2`, `systemd`, or plain `node`
- app port behind `nginx`
- live `DATA_DIR` path
- restart command
- whether the VPS already has a Git checkout

## Standard deploy workflow

After the audit, keep the deploy flow consistent:

```bash
cd /Users/jaronfiestada/Documents/Playground/HonestTrading
git pull
git checkout -b <feature-branch>
# edit files
git add .
git commit -m "<message>"
git push -u origin <feature-branch>
```

Then deploy on the VPS:

1. SSH into the VPS.
2. Go to the live app checkout.
3. Back up the live storage file before any code deploy.
4. Pull the new Git commit.
5. Restart the app using the runtime manager already in use.
6. Verify login and dashboard load in the browser.

Common restart patterns after the audit identifies the live runtime:

```bash
sudo systemctl restart <service-name>
pm2 restart <app-name>
docker restart <container-name>
docker compose up -d --build
```

## Backup procedure

Back up the live storage file before deploys:

```bash
cp <DATA_DIR>/storage.json <DATA_DIR>/storage.$(date +%F-%H%M%S).json
```

The repo also includes:

```bash
bash scripts/backup_storage.sh
```

That script creates compressed backups from the active `DATA_DIR` without modifying the live file.
