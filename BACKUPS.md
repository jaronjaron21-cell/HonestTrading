# Daily Backups for `storage.json` on Railway

This project stores live data in:

- `DATA_DIR/storage.json`
- Production target on Railway: `DATA_DIR=/data` so the file is `/data/storage.json`

The backup script creates compressed daily copies without modifying the live file.

## Script

Use:

```bash
bash scripts/backup_storage.sh
```

Behavior:

- Reads `DATA_DIR` (defaults to `/data`)
- Verifies `storage.json` exists
- Copies to `DATA_DIR/backups/storage_YYYY-MM-DD.json`
- Compresses it to `storage_YYYY-MM-DD.json.gz`
- Keeps only the latest 30 backup files (`storage_*.json.gz`)
- Never deletes or rewrites the live `storage.json`

## Railway Cron Setup

1. In the same Railway project, create a **separate Cron service**.
2. Point it to this same repository/branch.
3. Set the Cron command to:

   ```bash
   bash scripts/backup_storage.sh
   ```

4. Set the schedule to run daily, for example:

   ```cron
   0 2 * * *
   ```

5. Mount the **same Railway Volume** used by the app service at mount path `/data`.
6. Set environment variable on the Cron service:

   ```bash
   DATA_DIR=/data
   ```

7. Deploy the Cron service and confirm in logs that backups are created under `/data/backups`.

## Notes

- App startup logs the resolved storage path to help verify persistence wiring.
- In production, if `DATA_DIR` is not `/data`, the app logs a warning (it does not crash).
