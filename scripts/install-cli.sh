#!/usr/bin/env bash
# adrive CLI installer.
#
#   curl -fsSL https://raw.githubusercontent.com/davis7dotsh/aDrive/main/scripts/install-cli.sh | bash
#
# Installs the latest release (or $ADRIVE_CLI_VERSION, e.g. cli-v0.1.0)
# into ~/.adrive/bin with SHA-256 verification. No sudo, no PATH edits
# unless invoked with --modify-path.
set -euo pipefail

REPO="davis7dotsh/aDrive"
INSTALL_DIR="${ADRIVE_INSTALL_DIR:-${HOME}/.adrive/bin}"
MODIFY_PATH=0
[[ "${1:-}" == "--modify-path" ]] && MODIFY_PATH=1

say() { printf '\033[1madrive install:\033[0m %s\n' "$*"; }
die() { printf '\033[1madrive install:\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v curl >/dev/null || die "curl is required"

command -v node >/dev/null || die "Node.js >= 20 is required but was not found.
  macOS:  brew install node
  Linux:  https://nodejs.org/en/download/package-manager
  Any:    https://nodejs.org/en/download"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[[ "${NODE_MAJOR}" -ge 20 ]] || die "Node.js >= 20 is required (found $(node --version)). Upgrade via your package manager or https://nodejs.org"

if command -v shasum >/dev/null; then
	SHA_CMD=(shasum -a 256)
elif command -v sha256sum >/dev/null; then
	SHA_CMD=(sha256sum)
else
	die "Neither shasum nor sha256sum is available for checksum verification"
fi

# --- resolve release ---------------------------------------------------------
TAG="${ADRIVE_CLI_VERSION:-}"
if [[ -z "${TAG}" ]]; then
	TAG="$(curl -fsSL -H 'accept: application/vnd.github+json' \
		"https://api.github.com/repos/${REPO}/releases/latest" |
		node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).tag_name;if(!t)process.exit(1);console.log(t)})')" ||
		die "Could not resolve the latest release from GitHub"
fi
case "${TAG}" in
	cli-v*) ;;
	*) die "Release tag '${TAG}' does not look like a CLI release (expected cli-vX.Y.Z)" ;;
esac
VERSION="${TAG#cli-v}"
# ADRIVE_BASE_URL exists for testing the installer against a local mock.
BASE_URL="${ADRIVE_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
say "installing adrive v${VERSION} from ${TAG}"

# --- download and verify -----------------------------------------------------
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

curl -fsSL -o "${WORK_DIR}/adrive.mjs" "${BASE_URL}/adrive.mjs" ||
	die "Could not download adrive.mjs from ${BASE_URL}"
curl -fsSL -o "${WORK_DIR}/checksums.txt" "${BASE_URL}/checksums.txt" ||
	die "Could not download checksums.txt from ${BASE_URL}"

EXPECTED="$(awk '$2 == "adrive.mjs" { print $1 }' "${WORK_DIR}/checksums.txt")"
[[ -n "${EXPECTED}" ]] || die "checksums.txt has no entry for adrive.mjs"
ACTUAL="$("${SHA_CMD[@]}" "${WORK_DIR}/adrive.mjs" | awk '{ print $1 }')"
[[ "${EXPECTED}" == "${ACTUAL}" ]] ||
	die "Checksum mismatch for adrive.mjs (expected ${EXPECTED}, got ${ACTUAL}). Aborting."
say "checksum verified"

# --- install -----------------------------------------------------------------
# Stage under temporary names and verify the new bundle actually runs
# BEFORE swapping it in, so a broken download can never clobber a
# working installation.
mkdir -p "${INSTALL_DIR}"
# The staged name must keep the .mjs extension — Node refuses to load
# ESM from an unknown extension like .new.
install -m 0755 "${WORK_DIR}/adrive.mjs" "${INSTALL_DIR}/.staged-adrive.mjs"
cat >"${INSTALL_DIR}/.staged-adrive" <<'LAUNCHER'
#!/usr/bin/env bash
exec node "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/adrive.mjs" "$@"
LAUNCHER
chmod 0755 "${INSTALL_DIR}/.staged-adrive"

STAGED_VERSION="$(node "${INSTALL_DIR}/.staged-adrive.mjs" --version 2>/dev/null | head -1)" || {
	rm -f "${INSTALL_DIR}/.staged-adrive.mjs" "${INSTALL_DIR}/.staged-adrive"
	die "Downloaded CLI failed to run; existing installation left untouched"
}
mv "${INSTALL_DIR}/.staged-adrive.mjs" "${INSTALL_DIR}/adrive.mjs"
mv "${INSTALL_DIR}/.staged-adrive" "${INSTALL_DIR}/adrive"
say "installed: ${STAGED_VERSION} -> ${INSTALL_DIR}/adrive"

# --- PATH --------------------------------------------------------------------
case ":${PATH}:" in
	*":${INSTALL_DIR}:"*)
		say "ready — run: adrive login <your-drive-url>"
		;;
	*)
		PROFILE=""
		case "$(basename "${SHELL:-}")" in
			zsh) PROFILE="${HOME}/.zshrc" ;;
			bash) PROFILE="${HOME}/.bashrc" ;;
			fish) PROFILE="" ;; # fish uses fish_add_path below
		esac
		EXPORT_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
		if [[ "${MODIFY_PATH}" == "1" && -n "${PROFILE}" ]]; then
			printf '\n%s\n' "${EXPORT_LINE}" >>"${PROFILE}"
			say "added ${INSTALL_DIR} to PATH in ${PROFILE} — restart your shell"
		else
			say "add adrive to your PATH:"
			if [[ "$(basename "${SHELL:-}")" == "fish" ]]; then
				printf '\n  fish_add_path %s\n\n' "${INSTALL_DIR}"
			else
				printf '\n  %s\n\n' "${EXPORT_LINE}"
			fi
			say "(or re-run with --modify-path to do it automatically)"
		fi
		;;
esac
