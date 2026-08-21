#!/usr/bin/env bash
# a-drive release: validate -> check -> test -> build -> dry-run ->
# migrate -> deploy -> record. Run from the repo root: bun release
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="${ROOT}/apps/web"
ENV_NAME="${RELEASE_ENV:-production}"
RECORD_FILE="${ROOT}/.release-history"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Preflight"
cd "${ROOT}"
if [[ -n "$(git status --porcelain)" ]]; then
	echo "Working tree is dirty. Commit or stash before releasing." >&2
	exit 1
fi
COMMIT="$(git rev-parse HEAD)"
echo "Releasing ${COMMIT} to env ${ENV_NAME}"
if grep -q "replace-with-${ENV_NAME}" "${WEB}/wrangler.jsonc"; then
	echo "wrangler.jsonc still has placeholder ids for env ${ENV_NAME}." >&2
	echo "Create the D1 database / KV namespace and paste their ids first." >&2
	exit 1
fi

step "Format check"
bun run format:check

step "Type and lint checks"
bun run check

step "Tests"
bun run test

step "Dependency audit (informational)"
bun audit --prod || echo "Review advisories against docs/security-notes.md"

step "Build"
cd "${WEB}"
bun x vite build

step "Deploy dry run"
bun x wrangler deploy --dry-run --env "${ENV_NAME}"

step "D1 migrations"
# Migrations run before the new Worker so both old and new code briefly run
# against the migrated schema. Keep every migration backwards-compatible
# for at least one release (additive columns/tables; no drops or renames
# until the release after the code stops using them) so wrangler rollback
# stays safe.
bun x wrangler d1 migrations apply DB --env "${ENV_NAME}" --remote

step "Deploy"
bun x wrangler deploy --env "${ENV_NAME}"

step "Record"
cd "${ROOT}"
printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${ENV_NAME}" "${COMMIT}" \
	>>"${RECORD_FILE}"
echo "Recorded in ${RECORD_FILE}"

step "Next"
cat <<'EOF'
Deployment is live but NOT verified. Now run the production verification
skill against the deployment (see .agents/skills/verify-deployment):
ask an agent to "verify the a-drive deployment". A release is complete
only when the verification report passes.

Rollback: docs/release.md#rollback
EOF
