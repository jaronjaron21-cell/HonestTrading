# Publish Guide (Synced Shared Data)

This app now supports real backend persistence through JSON storage (`data/storage.json`) via `/api/storage/*` endpoints.

## Recommended publish target: Railway

Why Railway for this app:
- Public URL for peers
- Persistent volume support for synced shared data
- Dockerfile-supported deploy flow

## 1) Push this folder to GitHub

```bash
cd "/Users/jaroncarlofiestada/Documents/New project"
git init
git add .
git commit -m "Publish-ready app with persistent backend storage"
# create your GitHub repo first, then:
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

## 2) Deploy on Railway

1. In Railway, create a new project.
2. Choose **Deploy from GitHub repo** and select your repo.
3. After first deploy, go to the service settings and attach a **Volume**.
4. Mount path: `/data`
5. Ensure env var `DATA_DIR=/data` is set.
6. In Networking, click **Generate Domain**.

Your peers will use that generated Railway URL.

## 3) Verify sync works

- Open the URL on your browser and upload/import data.
- Have a peer open the same URL in a different machine/browser.
- Confirm imported records appear for both users.

## Notes

- This storage model is single-service shared file persistence.
- Keep one service instance for consistent JSON-file writes.
- If you scale to multiple instances later, migrate storage from JSON file to a managed DB.

## Local run

```bash
cd "/Users/jaroncarlofiestada/Documents/New project"
node server.js
```

Then open:

`http://127.0.0.1:4173/shopify-page.html`
