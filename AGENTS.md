# AGENTS.md

aDrive is a Cloudflare-backed file spine — dashboard, tags, hybrid search,
static-site publishing — becoming a hosted multi-organization product.

## Testing policy

- Do not write automated tests: no unit, component, integration, or e2e
  tests, no `*.test.*` or `*.spec.*` files, no test frameworks or fixtures.
- Do not add test scripts to package.json or test jobs to CI workflows.
  CI verifies with typecheck, lint/format, diff check, and build only.
- If a change touches code that still has tests, delete the tests instead
  of updating them.
- Verify behavior manually: browser-check the affected flows, and rehearse
  migrations against disposable resources before deploying them.
