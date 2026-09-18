# beacon-library

The WMSFO v2 beacon core for Node: the hub socket loop that reconnects forever, the send loop (hub first, HTTP fallback), the heartbeat loop, the REST client, and the leader monitor. Every Node beacon on the fleet is built on it, so the reconnect behaviour lives in one place.

Read `docs/` before touching anything:

- `docs/beacon-library.md`: this repository's technical design.
- `docs/DESIGN.md`: the design overview for all of v2 (a copy; the original is in `wmsfo-api/docs`).
- `docs/contracts.md`: the shared contracts every component codes against (a copy; wins on any conflict). Section 9 is the beacon contract.

## Run, test, build

Requires Node 22 or newer. `npm ci` installs dependencies.

| Command | What it does |
|---|---|
| `npm run contracts:check` | Verifies `contracts/` matches `wmsfo-api` at the pinned `CONTRACTS_SHA`. |
| `npm run typecheck` | `tsc --noEmit` over `src` and `tests`. |
| `npm test` | The Vitest suites. |
| `npm run build` | `tsc -p tsconfig.build.json`; emits `dist/` with type declarations. |
| `npm pack` | Builds, then writes `beacon-library-<version>.tgz`, the file consumers vendor. |

## Release

Bump `version` in `package.json` on `main`, tag `v<version>`, push the tag. `.github/workflows/release.yml` runs the checks, packs, and attaches the tarball and its SHA-256 to a GitHub release. Consumers vendor that tarball (`docs/beacon-library.md` section 6).
