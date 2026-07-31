# Security notes

## Accepted dependency advisories

### `cookie@0.6.0` — GHSA-pxg6-pf52-xh8x (low)

- Path: `apps/web > runed > @sveltejs/kit > cookie`
- The advisory concerns out-of-bounds characters in user-controlled cookie
  names, paths, or domains. a-drive sets exactly one cookie
  (`adrive_session`) with a fixed name and fixed attributes
  (`Path=/; HttpOnly; Secure; SameSite=Strict`), and never reflects user
  input into cookie attributes, so the vulnerable condition is not
  reachable.
- Action: keep SvelteKit current and pick up the transitive fix
  (`cookie >= 0.7.0`) when a compatible SvelteKit release lands. Re-check
  with `pnpm audit --prod` during each release.

Accepted: 2026-07-31.
