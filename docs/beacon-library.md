# Beacon library: technical design

The beacon library is the one Node implementation of the beacon contract (contracts 9.2): the hub socket loop that reconnects forever, the send loop that prefers the hub and falls back to HTTP, the heartbeat loop, the REST client, the leader monitor of contracts 7.5, and the store for the beacon's state document (contracts 9.5). Every Node beacon on the fleet is built on it. It exists so the reconnect behaviour is written, tested, and fixed in one place instead of being copied between repositories by hand.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); the contract wins on any difference. Choices this document makes are in section 9; choices that need the owner are in section 10.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict, ES modules. One runtime dependency: `@microsoft/signalr` (WebSockets only, negotiation skipped). Native `fetch`. No logger dependency: the caller hands in a logger |
| Package | `beacon-library`, built to `dist/` with type declarations; one entry point, `beacon-library` |
| Distribution | A tarball from `npm pack`, attached to a GitHub release per version tag and vendored by each consumer (section 6) |
| Tests | Vitest: the socket loop, the send loop decision table, the heartbeat loop against the vendored heartbeat schema, the REST client's state calls, the state store, the hub URL mapping, the leader monitor, the facade, and the conformance scenarios (section 5) |
| Repository | `beacon-library`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13); `docs/DESIGN.md` and `docs/contracts.md` are byte-identical copies of the originals in `wmsfo-api/docs` |

```
beacon-library/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
  .github/workflows/ci.yml  .github/workflows/release.yml
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  docs/beacon-library.md  docs/DESIGN.md  docs/contracts.md  docs/README.md
  conformance/
    scenarios.json              the socket loop scenarios every beacon implementation must pass (section 5)
    scenarios.schema.json       the shape of that file
  src/
    index.ts                    the public surface (section 3)
    beacon.ts                   createBeacon and gateOnLeader: the facade (section 4)
    socketLoop.ts               connect, join, stay connected, reconnect forever (section 2)
    sendLoop.ts                 hub first, HTTP fallback, the re-join rule
    heartbeatLoop.ts            POST /beacons/heartbeat every 15 s
    rest.ts                     POST /locations, /beacons/heartbeat, GET and PUT /beacons/me/state
    stateStore.ts               createStateStore: the beacon's state document with the conflict rule (section 4a)
    hub.ts                      the SignalR client behind the HubClient interface
    state.ts                    BeaconState, the latest fix, the counters the heartbeat reports
    backoff.ts                  1 s, 2 s, 3 s, 5 s, then 5 s forever; 10 s after a denied join
    leader.ts                   GET /internal/leader poll (contracts 7.5), 90 s expiry
    testing.ts                  the fakes consumers' own tests use (a scripted HubClient, a recording Rest with an in-memory state document)
  tests/
```

---

## 2. The guarantee

A beacon reconnects its hub socket forever, for every reason a socket can end, and the only way out of the loop is an explicit `stop()`. The cases the fleet produces, all of which must end in `socket connected`:

| Case | What the loop sees |
|---|---|
| A gateway node dies, the fleet is refreshed, or the fleet scales down | the WebSocket closes with `1006`, with or without an error |
| The leader gateway node dies | the same close; the API's leadership moves on its own |
| The whole fleet is gone for a while | every connect attempt fails until it is back; the backoff repeats 5 s forever |
| The fleet scales up | nothing, or a close if the load balancer moves the connection |
| A half-open socket | the handshake or the join never settles; the close signal ends the wait at once |
| The gateway evicts the beacon (`auth_expired`) | a re-join on the same connection |
| The gateway evicts the beacon (any other reason) | a reconnect |
| The join is denied (the key was rotated or the hub was switched off for this beacon; the gateway's error reads `Not authorized to join this channel`, and `denied`, `forbidden`, `401`, and `403` are recognised too) | the first retry waits 10 s, then the normal backoff; the send loop carries fixes over HTTP meanwhile |
| The hub client cannot be built | logged, backed off, retried |

Every transition logs one INFO line through the caller's logger: `socket connected` with `{ channel, reconnectCount, attempt }`, `socket closed; reconnecting` with `{ channel, err, delayMs, attempt }` (`attempt` is the attempt that just ended, counted from 0), and the denied, evicted, and rejoined lines with the channel. A steady socket logs nothing. No line ever carries the beacon key.

---

## 3. Public surface

Everything is exported from the one entry point.

| Export | Use |
|---|---|
| `createBeacon`, `gateOnLeader` | the facade most beacons use (section 4) |
| `createBeaconState`, `setLatestFix`, `hasUndeliveredFix`, `BeaconState`, `LatestFix` | the state a beacon's fix source writes into |
| `createRest`, `Rest`, `LocationBody`, `HeartbeatBody`, `HealthCore`, `RestError`, `GetStateResponse`, `PutStateResponse` | the REST client, for a beacon that needs it directly |
| `createStateStore`, `StateStore`, `StateStoreOptions`, `StateSnapshot`, `StateStoreError`, `STATE_STORE_MAX_ATTEMPTS` | the beacon's state document (section 4a) |
| `startSocketLoop`, `startSendLoop`, `startHeartbeatLoop`, `buildHubClient`, `HubClient`, `decide` | the loops, for a beacon that wires them itself |
| `startLeader`, `Leader`, `LeaderOptions` | the leader monitor |
| `backoffMs`, `BACKOFF_MS`, `JOIN_DENIED_FIRST_WAIT_MS`, `HTTP_FALLBACK_INTERVAL_MS`, `HUB_REJECTION_REJOIN_THRESHOLD` | the constants of contracts 9.2 |
| `BeaconLogger` | `{ info, warn, error }`, each `(fields, msg)`; a pino logger satisfies it as is |
| `FakeHubClient`, `createFakeRest` (from `testing.ts`, exported from the entry point) | fakes for consumers' tests: a scripted hub and a recording REST client that serves a versioned state document (`state`, `stateVersion`, `setState`, `nextStateError`, `stateCalls`) with the API's conflict rule |

Semantic versioning: a change to anything in this table that breaks a caller is a major version.

---

## 4. The facade

Both Node beacons wire the same four things the same way: build the REST client, start the socket loop with a hub factory, start the send loop with the re-join callback, start the heartbeat loop; and tear them down in the reverse order when leadership is lost. `createBeacon` owns that wiring.

```ts
const beacon = createBeacon({
  apiBaseUrl, beaconKey, hubUrl, ingestChannel,
  log,                                    // BeaconLogger
  buildHealth: () => HealthCore,          // the three optional health leaves (contracts 4.2)
  buildDebug: () => Record<string, unknown>,   // the beacon's own debug object
});

beacon.state            // BeaconState: the fix source calls setLatestFix(beacon.state, fix) and beacon.wake()
beacon.wake()           // a new fix is ready
beacon.start()          // idempotent; logs "starting beacon core"
await beacon.stop()     // idempotent; send loop, heartbeat loop, then the socket; logs "stopping beacon core"
beacon.running()
beacon.rest             // the REST client, for GET /beacons/me at boot
```

`gateOnLeader({ leader: LeaderOptions, beacon, onStart?, onStop? })` starts the beacon when this node becomes leader and stops it when it stops being leader, calling `onStart` after the start and `onStop` before the stop so a beacon can start and stop its own fix source (a poller, a replay worker) with it. It returns the `Leader`, so the health probe can read `polledOnce()`.

A beacon that needs something the facade does not offer uses the loops directly; the facade is built only from the public surface.

The facade hands its `BeaconState` to the REST client, so a `401` on the state calls marks it `revoked` exactly as a `401` heartbeat does.

---

## 4a. The state store

Each beacon has one JSON document the API keeps for it (contracts 4.2 and 9.5): `GET /beacons/me/state` reads it with its `stateVersion`, `PUT /beacons/me/state` writes it with the version it was based on as `expectedVersion`. It is how a restarted container, or a second instance that becomes leader, carries on from where the last one left off. The document is the only store of that state; a beacon keeps no copy of its own beside it. `createStateStore` is the one implementation of the read, change, and write cycle.

```ts
const store = createStateStore<ReplayState>({
  rest: beacon.rest,
  log,
  empty: () => ({ mode: "idle", cursor: null }),   // the document before the first write
  maxAttempts: 5,                                   // optional; writes per update, the first included
});

await store.load();                       // { state, version }; a null document reads as empty() at version 0
store.current();                          // the last copy loaded or written, null before the first load
await store.update((s) => { s.cursor = next; });   // mutate the copy, or return a new one
await store.refreshIfBehind(beacon.state.lastHeartbeat?.stateVersion ?? null);
```

- The conflict rule. `update` applies the mutator to a deep copy of the current copy (loading first when there is none) and writes it with the version that copy was read at. A `409 state_version_conflict` means another writer got there first: the store reads the document again, applies the same mutator to the fresh copy, and writes with the new version, logging INFO `state conflict; retrying` with `{ attempt, currentVersion }`. After `maxAttempts` writes in all it rejects with an `Error` whose `code` is `state_conflict`. The mutator can run more than once, so it computes its change from the copy it is given.
- Any other failure (no answer, a `5xx`, `401`, `413`, `429`) rejects with a `StateStoreError` carrying `code` (the API's code, `transport_error`, or `http_error`) and `status`, and leaves `current()` as it was. A final failure logs WARN `state write failed` with `{ code, status }`; a failed load logs `state read failed`. No line ever carries the document.
- `load`, `update`, and `refreshIfBehind` run on one queue: a second `update` waits for the first, so two changes from the same process never conflict with each other.
- `refreshIfBehind(version)`. The heartbeat answer carries `stateVersion`, which the heartbeat loop copies to `lastHeartbeat.stateVersion` (null until an answer carries it). Calling `refreshIfBehind` with it reloads when it is a number ahead of the current copy's version (or there is no copy yet) and does nothing otherwise, so a beacon picks up writes made by another instance without reading the document every beat. It never rejects; a failed reload is logged and the copy stays as it was.
- A beacon loads at start and on every leader change (the `onStart` of `gateOnLeader`), before it acts on the document.

---

## 5. Conformance scenarios

`conformance/scenarios.json` is the behaviour of section 2 written as data, so an implementation in another language can be held to the same cases. Red-Nose's Kotlin socket loop (red-nose.md 7.4) is the other implementation; the file is copied into that repository and run by its own test harness.

```json
{
  "schemaVersion": 1,
  "backoffMs": [1000, 2000, 3000, 5000],
  "joinDeniedFirstWaitMs": 10000,
  "joinDeniedErrorText": "Not authorized to join this channel",
  "scenarios": [
    {
      "name": "transport close while connected",
      "steps": [
        { "hub": "startResolves" },
        { "hub": "joinResolves" },
        { "expect": "connected", "reconnectCount": 1 },
        { "hub": "close", "error": "WebSocket closed with status code: 1006" },
        { "expect": "reconnecting", "delayMs": 1000 },
        { "advanceMs": 1000 },
        { "hub": "startResolves" },
        { "hub": "joinResolves" },
        { "expect": "connected", "reconnectCount": 2 }
      ]
    }
  ]
}
```

`joinDeniedErrorText` is the text the gateway puts in a denied join's error; a harness rejects the join of a `joinDenied` step with an error whose message contains it, so every implementation is held to recognising the real text.

A step is one of: a scripted hub event (`startResolves`, `startRejects`, `startNeverSettles`, `joinResolves`, `joinDenied`, `joinRejects`, `joinNeverSettles`, `close` with an optional `error`, `evict` with a `reason`, `buildThrows`), a clock move (`advanceMs`), a caller action (`rejoin`, `stop`), or an expectation (`expect` with the socket state, and any of `reconnectCount`, `rejoinCount`, `delayMs`, `hubsBuilt`). The scenarios cover every row of the section 2 table, plus: a clean close with no error, a close during the handshake, a close during the join, 25 consecutive closes (25 reconnects, the backoff sequence, then 5 s repeating), and `stop()` during a backoff wait. `tests/conformance.test.ts` runs every scenario against `startSocketLoop` with fake timers and the scripted fake hub; a scenario the runner does not understand fails the run.

---

## 6. Distribution and versioning

- `VERSION` is `package.json`'s version. A release is a tag `v<version>` on `main`. `.github/workflows/release.yml` runs the checks, runs `npm pack`, and attaches `beacon-library-<version>.tgz` and its SHA-256 to a GitHub release of that tag.
- A consumer vendors the tarball: `vendor/beacon-library-<version>.tgz` committed in its repository, `"beacon-library": "file:vendor/beacon-library-<version>.tgz"` in its `package.json`, and `BEACON_LIBRARY_SHA` holding the library commit the tarball was packed from, the same way `contracts/` is vendored with `CONTRACTS_SHA`. Nothing fetches at install time, so CI, the container build, and a task runner without network access all install the same bytes, and the repositories can stay private.
- Updating a consumer: copy the new tarball in, delete the old one, change the dependency line and `BEACON_LIBRARY_SHA`, `npm install`, run the consumer's suite, deploy.
- `contracts/` here follows the API like every consumer: when contracts 9.2, 4.2, or 7.5 change, the library changes first, then its consumers.

---

## 7. Consumers

| Consumer | Uses |
|---|---|
| `legacy-beacon` | `createBeacon` and `gateOnLeader`; its own poller, normalizer, heartbeat health and debug builders, health probe, configuration |
| `simulator-beacon` | the same; its own worker, scheduler, flights cache, control API, database row |
| `red-nose` | none of the code (its beacon is a native Kotlin service); the conformance scenarios of section 5 |

A consumer keeps no copy of the core: no `src/beacon/`, no `src/leader.ts`, no tests of the library's behaviour. Its tests cover what it adds.

---

## 8. Tests and CI

`npm run contracts:check && npm run typecheck && npm test && npm run build`, in that order, in `ci.yml` on every push to `main`, `dev`, `grunt`, and `grunt-**`, and on pull requests; `release.yml` runs the same before it packs. The socket loop tests use fake timers and the scripted fake hub, never a real socket. A test that a packed tarball installs into an empty project and that `import { createBeacon } from "beacon-library"` type-checks and runs there is part of `release.yml`.

---

## 9. Decisions made here

- One library for the Node beacons and shared scenarios for the phone, because the phone's beacon is a native Kotlin service that cannot load TypeScript (2026-09-18).
- The legacy beacon's socket loop is the base: it is the later of the two and carries the handshake race, the close-reason logging, and the guard that ignores a close from a client the loop already replaced. Both repositories' socket loop suites run against it.
- `attempt` in the closed line is the attempt that just ended, counted from 0, as Red-Nose logs it.
- No logger dependency; the caller's logger is an argument.
- The library does not read environment variables and knows nothing about a beacon's configuration keys; `forceLeader` is an option the caller sets from its own key.
- Vendored tarballs instead of a registry: no tokens anywhere, the same bytes everywhere, private repositories.

## 10. Needs a decision

Nothing at the moment. Add here as it comes up.
