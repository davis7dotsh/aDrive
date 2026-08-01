#!/usr/bin/env bash
# One-time setup on the backup host (an always-on machine on your own network). Copies the backup scripts into place, checks
# prerequisites, and installs the nightly cron entry (02:17 local — an
# off-minute on purpose). Run from a checkout or after scp'ing scripts/backup.
set -euo pipefail

INSTALL_DIR="${HOME}/adrive-backup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v rclone >/dev/null || {
	echo "rclone is required: https://rclone.org/install/" >&2
	exit 1
}
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

umask 077
mkdir -p "${INSTALL_DIR}"
cp "${SCRIPT_DIR}/backup.sh" "${INSTALL_DIR}/backup.sh"
chmod 700 "${INSTALL_DIR}/backup.sh"

# Tighten an existing backup destination created under a looser umask.
DEFAULT_BACKUP_ROOT="${HOME}/Backups/a-drive"
if [[ -d "${DEFAULT_BACKUP_ROOT}" ]]; then
	chmod -R go-rwx "${DEFAULT_BACKUP_ROOT}"
fi

if [[ ! -f "${INSTALL_DIR}/backup.env" ]]; then
	cp "${SCRIPT_DIR}/backup.env.example" "${INSTALL_DIR}/backup.env"
	chmod 600 "${INSTALL_DIR}/backup.env"
	echo "Created ${INSTALL_DIR}/backup.env — fill it in before the first run."
fi

CRON_LINE="17 2 * * * ${INSTALL_DIR}/backup.sh >> ${HOME}/adrive-backup/cron.log 2>&1"
if ! crontab -l 2>/dev/null | grep -Fq "${INSTALL_DIR}/backup.sh"; then
	(crontab -l 2>/dev/null; echo "${CRON_LINE}") | crontab -
	echo "Installed cron entry: ${CRON_LINE}"
else
	echo "Cron entry already present."
fi

echo
echo "Next steps:"
echo "  1. Edit ${INSTALL_DIR}/backup.env (rclone remote, account id, D1 id, API token, webhook)."
echo "  2. rclone config create adrive-r2 s3 provider=Cloudflare ... (read-only R2 token)"
echo "  3. Run ${INSTALL_DIR}/backup.sh once by hand and check \$BACKUP_ROOT/last-run.json."
echo "  4. Perform the restore drill in docs/backup-restore.md before trusting it."
