#!/usr/bin/env bash
# a-drive nightly backup: R2 sync + D1 export + retention + manifest.
# Runs on nexus from cron. Configuration comes from backup.env next to
# this script (see backup.env.example). Never prints secrets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/backup.env"

: "${BACKUP_ROOT:?BACKUP_ROOT is required (e.g. ~/Backups/a-drive)}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE is required (e.g. adrive-r2:adrive-production)}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_D1_DATABASE_ID:?CLOUDFLARE_D1_DATABASE_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
# ALERT_WEBHOOK_URL is optional but strongly recommended.

STAMP_DAY="$(date -u +%Y-%m-%d)"
STAMP_MONTH="$(date -u +%Y-%m)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

MIRROR_DIR="${BACKUP_ROOT}/r2-mirror"
TRASH_DIR="${BACKUP_ROOT}/r2-deleted/${STAMP_DAY}"
D1_DIR="${BACKUP_ROOT}/d1/daily"
D1_MONTHLY_DIR="${BACKUP_ROOT}/d1/monthly"
MANIFEST_DIR="${BACKUP_ROOT}/manifests"
LOG_DIR="${BACKUP_ROOT}/logs"
STATUS_FILE="${BACKUP_ROOT}/last-run.json"
LOG_FILE="${LOG_DIR}/backup-${STAMP_DAY}.log"

mkdir -p "${MIRROR_DIR}" "${TRASH_DIR}" "${D1_DIR}" "${D1_MONTHLY_DIR}" \
	"${MANIFEST_DIR}" "${LOG_DIR}"

log() {
	printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "${LOG_FILE}"
}

alert() {
	local message="a-drive backup: $*"
	log "ALERT: $*"
	if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
		curl -fsS -m 15 -X POST \
			-H 'Content-Type: application/json' \
			-d "$(printf '{"text":%s}' "$(printf '%s' "${message}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
			"${ALERT_WEBHOOK_URL}" >/dev/null || log "alert webhook delivery failed"
	fi
}

fail() {
	printf '{"status":"failed","at":"%s","step":"%s"}\n' "${NOW_ISO}" "$1" \
		>"${STATUS_FILE}"
	alert "FAILED at step: $1 (see ${LOG_FILE})"
	exit 1
}

log "starting backup run ${NOW_ISO}"

# --- 1. R2 mirror -----------------------------------------------------------
# sync --backup-dir: objects deleted or overwritten upstream land in the
# dated trash dir instead of vanishing, satisfying delete retention.
PREVIOUS_COUNT=$(find "${MIRROR_DIR}" -type f 2>/dev/null | wc -l | tr -d ' ')

rclone sync "${RCLONE_REMOTE}" "${MIRROR_DIR}" \
	--backup-dir "${TRASH_DIR}" \
	--transfers 8 --checkers 16 \
	--log-file "${LOG_FILE}" --log-level INFO \
	|| fail "r2-sync"

CURRENT_COUNT=$(find "${MIRROR_DIR}" -type f | wc -l | tr -d ' ')
log "r2 mirror holds ${CURRENT_COUNT} objects (was ${PREVIOUS_COUNT})"

# A shrink larger than the configured tolerance is suspicious: mass deletion
# upstream, credential problems, or bucket misconfiguration. The bytes are in
# the trash dir either way; the alert asks a human to look.
SHRINK_TOLERANCE="${SHRINK_TOLERANCE:-100}"
if (( PREVIOUS_COUNT > 0 && CURRENT_COUNT + SHRINK_TOLERANCE < PREVIOUS_COUNT )); then
	alert "object count dropped ${PREVIOUS_COUNT} -> ${CURRENT_COUNT}; deleted objects retained in ${TRASH_DIR}"
fi

# --- 2. D1 export -----------------------------------------------------------
D1_EXPORT="${D1_DIR}/adrive-${STAMP_DAY}.sql.gz"
EXPORT_RESPONSE=$(curl -fsS -m 600 -X POST \
	"https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}/export" \
	-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
	-H 'Content-Type: application/json' \
	-d '{"output_format":"polling"}') || fail "d1-export-start"

SIGNED_URL=""
for _attempt in $(seq 1 60); do
	SIGNED_URL=$(printf '%s' "${EXPORT_RESPONSE}" | python3 -c '
import json, sys
body = json.load(sys.stdin)
result = body.get("result") or {}
print(result.get("signed_url") or "")
')
	[[ -n "${SIGNED_URL}" ]] && break
	BOOKMARK=$(printf '%s' "${EXPORT_RESPONSE}" | python3 -c '
import json, sys
body = json.load(sys.stdin)
result = body.get("result") or {}
print(result.get("at_bookmark") or "")
')
	[[ -z "${BOOKMARK}" ]] && fail "d1-export-poll"
	sleep 5
	EXPORT_RESPONSE=$(curl -fsS -m 600 -X POST \
		"https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}/export" \
		-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
		-H 'Content-Type: application/json' \
		-d "{\"output_format\":\"polling\",\"current_bookmark\":\"${BOOKMARK}\"}") \
		|| fail "d1-export-poll"
done
[[ -n "${SIGNED_URL}" ]] || fail "d1-export-timeout"

curl -fsS -m 600 "${SIGNED_URL}" | gzip >"${D1_EXPORT}" || fail "d1-download"
[[ -s "${D1_EXPORT}" ]] || fail "d1-empty-export"
log "d1 export written: $(du -h "${D1_EXPORT}" | cut -f1) ${D1_EXPORT}"

# Monthly snapshot: first successful run of each month is kept for a year.
D1_MONTHLY="${D1_MONTHLY_DIR}/adrive-${STAMP_MONTH}.sql.gz"
if [[ ! -f "${D1_MONTHLY}" ]]; then
	cp "${D1_EXPORT}" "${D1_MONTHLY}"
	log "monthly d1 snapshot recorded: ${D1_MONTHLY}"
fi

# --- 3. Manifest ------------------------------------------------------------
# Object keys, sizes, and rclone-side hashes for every mirrored object, plus
# the D1 export digest — enough to audit a restore without the live account.
MANIFEST="${MANIFEST_DIR}/manifest-${STAMP_DAY}.json"
{
	printf '{"generatedAt":"%s","objects":' "${NOW_ISO}"
	rclone lsjson -R --hash "${MIRROR_DIR}" --files-only
	printf ',"objectCount":%s' "${CURRENT_COUNT}"
	printf ',"d1Export":{"file":"%s","sha256":"%s"}' \
		"$(basename "${D1_EXPORT}")" \
		"$(shasum -a 256 "${D1_EXPORT}" | cut -d' ' -f1)"
	printf '}\n'
} >"${MANIFEST}" || fail "manifest"
log "manifest written: ${MANIFEST}"

# --- 4. Retention -----------------------------------------------------------
# Daily D1 exports, manifests, logs, and deleted-object trash: 30 days.
# Monthly D1 snapshots: 12 months.
find "${D1_DIR}" -name '*.sql.gz' -mtime +30 -delete
find "${MANIFEST_DIR}" -name 'manifest-*.json' -mtime +30 -delete
find "${LOG_DIR}" -name 'backup-*.log' -mtime +30 -delete
find "${BACKUP_ROOT}/r2-deleted" -mindepth 1 -maxdepth 1 -type d \
	-mtime +30 -exec rm -rf {} +
find "${D1_MONTHLY_DIR}" -name '*.sql.gz' -mtime +366 -delete

# --- 5. Status --------------------------------------------------------------
printf '{"status":"ok","at":"%s","objects":%s,"d1Export":"%s"}\n' \
	"${NOW_ISO}" "${CURRENT_COUNT}" "$(basename "${D1_EXPORT}")" \
	>"${STATUS_FILE}"
log "backup run complete"
