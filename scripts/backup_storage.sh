#!/usr/bin/env bash

set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
STORAGE_PATH="${DATA_DIR}/storage.json"
BACKUP_DIR="${DATA_DIR}/backups"
STAMP="$(date +%F)"
BACKUP_JSON_PATH="${BACKUP_DIR}/storage_${STAMP}.json"
BACKUP_GZ_PATH="${BACKUP_JSON_PATH}.gz"
KEEP_COUNT="${KEEP_COUNT:-30}"

if ! [[ "${KEEP_COUNT}" =~ ^[0-9]+$ ]] || [ "${KEEP_COUNT}" -lt 1 ]; then
  echo "Error: KEEP_COUNT must be a positive integer (got '${KEEP_COUNT}')." >&2
  exit 1
fi

if [ ! -f "${STORAGE_PATH}" ]; then
  echo "Error: storage file not found at ${STORAGE_PATH}" >&2
  exit 1
fi

if ! command -v gzip >/dev/null 2>&1; then
  echo "Error: gzip command is required but not available." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

cp "${STORAGE_PATH}" "${BACKUP_JSON_PATH}"
gzip -f "${BACKUP_JSON_PATH}"

if [ ! -f "${BACKUP_GZ_PATH}" ]; then
  echo "Error: backup file was not created at ${BACKUP_GZ_PATH}" >&2
  exit 1
fi

backup_files="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'storage_*.json.gz' -print | sort)"
backup_count="$(printf '%s\n' "${backup_files}" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ "${backup_count}" -gt "${KEEP_COUNT}" ]; then
  delete_count="$((backup_count - KEEP_COUNT))"
  printf '%s\n' "${backup_files}" \
    | sed '/^$/d' \
    | head -n "${delete_count}" \
    | while IFS= read -r old_backup; do
        rm -f -- "${old_backup}"
      done
fi

echo "Backup created: ${BACKUP_GZ_PATH}"
