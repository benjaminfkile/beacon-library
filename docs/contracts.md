# WMSFO v2 shared contracts

This document is the interface every WMSFO v2 component codes against: the API (`wmsfo-api`), the public site, the admin panel, the Red-Nose beacon app, and the one-off migration tool. The design overview (`DESIGN.md`) is authoritative; this document makes it exact. Choices the overview does not make are listed in section 14, and choices that need the owner are in section 15. Nothing in the body is a choice that is not listed in one of those two sections.

---

## 0. Conventions

### 0.1 Placeholders

Every environment-specific value is written as a placeholder. Each placeholder has a dev value and a prod value.

| Placeholder | Meaning |
|---|---|
| `<gateway-domain>` | Public host of the gateway fleet. The hub is `wss://<gateway-domain>/hub`. |
| `<api-domain>` | Host that serves the API with bare paths (ALB host rule with URL rewrite). One per environment. |
| `<service>` | Manifest service name: `wmsfo-api` (prod) or `wmsfo-api-dev` (dev). Also the hub channel prefix. |
| `<cdn-domain>` | CloudFront distribution in front of the environment's bucket. |
| `<bucket>` | The environment's S3 bucket (private; read only by CloudFront through origin access control). |
| `<site-domain>` | Production public site origin host. |
| `<preview-site-domain>` | Preview (dev) public site origin host. |
| `<admin-domain>` | Admin panel origin host (deployed from `main`, targets prod). |
| `<admin-dev-domain>` | Admin panel origin host for dev (a second Vercel project deployed from `dev`). |
| `<pool-id>`, `<region>`, `<cognito-domain>` | Cognito user pool id, its region, and its hosted UI domain. |
| `<site-client-id>`, `<admin-client-id>` | Cognito app client ids. |
| `<account-id>` | AWS account id (ECR image path). |
| `<docker-bridge-ip>` | Address of the host's Docker bridge, where the gateway's internal listener answers on port 8080. |
| `<db-host>` | RDS endpoint or RDS proxy endpoint. |
| `<secret-name>` | Secrets Manager secret holding the API container env. |
| `<mail-domain>` | SES-verified sending domain. |

### 0.2 Wire format

| Rule | Value |
|---|---|
| JSON casing | camelCase on every wire (REST, hub, CDN objects). snake_case in SQL only. |
| Timestamps | RFC 3339, UTC, `Z` suffix, exactly three fractional digits on output: `2026-12-22T01:31:07.412Z`. Inputs accept any RFC 3339 offset and are normalized to UTC. Bare dates are rejected. Postgres `timestamptz` microseconds are truncated to milliseconds on output. |
| Ids | 64-bit integers serialized as JSON numbers. Identity columns start at 1 and never approach 2^53. Clients type them as `number` (TypeScript) or `Long` (Kotlin). |
| Units | metres (`altitudeM`, `accuracyM`), metres per second (`speedMps`), degrees (`lat`, `lng`, `headingDeg`). `headingDeg` is 0 to 360 inclusive, clockwise from true north. |
| Numbers | IEEE doubles. `NaN` and infinities are rejected on input. Doubles are written in .NET's shortest round-trippable form (the System.Text.Json default). |
| Money | `amountDonated` is a JSON number with at most two decimals, parsed by the API as `decimal` straight from the number token (no double round trip) and written back with two decimals (`250.10`) through a converter that writes `decimal.Round(v, 2).ToString("F2", CultureInfo.InvariantCulture)` as a raw number token. Clients display it and never compute with it. It appears only on admin surfaces. |
| Unknown fields | Rejected with `400 validation_failed` on every request body the API accepts (exceptions: nested telemetry keys in the heartbeat, section 4.2; the two gateway callback bodies, sections 2.4 and 2.5; the form body on `POST /subscriptions/unsubscribe`, section 4.3, which is ignored entirely). Clients tolerate unknown fields on every response and every CDN object. |
| Strings | UTF-8. Length limits count UTF-16 code units (JavaScript `string.length`, C# `string.Length`, Kotlin `String.length`). Leading and trailing whitespace is trimmed before validation. |
| Booleans | JSON `true` and `false` only. |
| Nullability | Written as `type \| null` in field tables. A field that is not nullable is always present with a value. |
| Schema version | Every CDN JSON object carries `schemaVersion` (int) as its first key. It is `1`. The API changes it only for a non-additive change. A client that reads a value it does not know stops applying objects and shows its reload prompt. |

Type notation in field tables: `int64`, `int`, `number`, `string`, `bool`, `rfc3339`, `T[]`, `object`.

### 0.3 Error shape

Every non-2xx response from the API has `Content-Type: application/json` and this body:

```json
{
  "code": "validation_failed",
  "message": "lat must be between -90 and 90",
  "details": { "fields": { "lat": "must be between -90 and 90" } },
  "requestId": "0HN7Q2K3L9V4A:00000003"
}
```

| Field | Type | Notes |
|---|---|---|
| `code` | `string` | One of the codes in section 4.7. Stable; clients switch on it. |
| `message` | `string` | Human readable, English, safe to show in the admin panel and Red-Nose's debug log. Never shown verbatim on the public site. |
| `details` | `object \| null` | Code-specific. `validation_failed` carries `fields` (field path to message). `rate_limited` carries `retryAfterSeconds`. |
| `requestId` | `string` | The ASP.NET Core trace identifier. Appears in the CloudWatch log line. |

A `429` also sets the `Retry-After` header (seconds). A `405` has no body. The two exceptions with an empty body are the `404` on the callback paths (section 3.5) and `405`.

### 0.4 Base URLs and paths

The API is reachable at two URLs that serve the same routes:

- `https://<gateway-domain>/<service>/<path>`: the gateway strips `/<service>` before the container sees the request.
- `https://<api-domain>/<path>`: bare paths.

All paths in this document are bare. Clients use `VITE_API_BASE_URL` (site, admin) or the enrolled `apiBaseUrl` (Red-Nose) and append the bare path. There is no version prefix. The only path under `/api` is `/api/health`, because that is the path the gateway probes (section 4.1).

The API has no public read endpoint. The public reads the CDN objects in section 1 and nothing else.

### 0.5 Lookups on the wire

**Event status** (table `event_status`, fixed, never edited through the API):

| `statusId` | `name` | Page role at `/` |
|---|---|---|
| 1 | `planned` | `planned` |
| 2 | `scheduled` | `scheduled` (the countdown section counts to `scheduledAt`) |
| 3 | `live` | `live` (the page that holds the `map` section) |
| 4 | `ended` | `ended` |
| 5 | `cancelled` | `cancelled` |
| 6 | `postponed` | `postponed` |

The site renders one admin-composed page per status, plus the `no_event` page when `eventStatusId` is null (1.3a). There is no other grouping of statuses.

**Subscriber channel**: `"email"` (in use), `"sms"` (reserved; `400 validation_failed` in v1).

**Beacon socket state** (telemetry): `"connected"`, `"connecting"`, `"reconnecting"`, `"disconnected"`.

**Thermal status** (telemetry, Android PowerManager names): `"none"`, `"light"`, `"moderate"`, `"severe"`, `"critical"`, `"emergency"`, `"shutdown"`, `"unknown"`.

**Memory pressure** (telemetry): `"normal"`, `"moderate"`, `"low"`, `"critical"`, `"unknown"`.

**Eviction reason** (hub): `"auth_expired"`, `"service_removed"`.

**Outbox topic**: `event.status_changed`, `event.message_posted`, `subscription.verify`, `contact.received` (section 7.7).

---

## 1. Read model: the CDN objects

The public site reads exactly three JSON objects plus media and icon files from the CDN and never calls the API for reads (the one exception is the preview endpoint in 4.3, used only by the admin panel's preview frame). Everything a page renders comes from these objects or from the hub carrying the first of them.

### 1.1 Object inventory

| Key in `<bucket>` | Content | Written by | When | `Cache-Control` |
|---|---|---|---|---|
| `live/location.json` | Live object (1.2) | An API node | Every stored update from the active beacon; after every snapshot-affecting admin write; by the leader when the cookie tally moved while the event has status 3 (7.4); once by an ingest node that observes a version change (1.8); on explicit republish; on first boot of an environment | `s-maxage=1, max-age=0` |
| `snapshots/{sha256}.json` | Snapshot (1.3) | The API node handling a snapshot-affecting admin write | Inside the write's transaction, before commit | `public, max-age=31536000, immutable` |
| `routes/{sha256}.json` | Route (1.4) | The API node handling `POST /admin/routes`; the migration tool | Before the row insert | `public, max-age=31536000, immutable` |
| `media/{mediaId}/{filename}` | An uploaded media asset (1.3b): sponsor logos, page images, uploaded icons | The admin panel, straight to S3 with a presigned PUT (4.5 Media); the migration tool | Before confirm; the object carries the tag `state=pending` until the API confirms it | `public, max-age=31536000, immutable` |
| `media/{mediaId}/w{width}.webp` | Derived width variants of a raster asset (480, 960, 1600) | The API node handling the confirm | Inside the confirm | `public, max-age=31536000, immutable` |
| `media/{mediaId}/dzi/poster.dzi`, `media/{mediaId}/dzi/poster_files/{level}/{col}_{row}.png` | The Deep Zoom tile pyramid of a large raster asset (longest side 2048 px or more): the descriptor and its lossless PNG tiles (1.3b); an asset confirmed before the PNG pyramid carries JPEG tiles and its descriptor says `Format="jpg"`, which the viewer honours | The API node handling the confirm | Inside the confirm | `public, max-age=31536000, immutable` |
| `icons/{sha256}.svg` | One icon of the built-in library (1.3b) | The node that migrates on boot, once per library change | Under the migration lock | `public, max-age=31536000, immutable` |
| `email/{sha256}.png` | The bundled email images, `templates/email/logo.png`, `ornaments.png`, and `lights.png` (7.8) | The node that migrates on boot, once per image change (a `HEAD` finds the key absent) | Under the migration lock | `public, max-age=31536000, immutable` |
| `maps/{packageKey}/tiles.pmtiles` | The vector tile archive of a tracker map (1.3 `event.trackerMap`), a PMTiles archive the site reads with HTTP range requests | The tile CLI (`tools/tiles`, platform.md 1.8) from an operator's machine, through the multipart upload the API starts and signs part by part (4.5 Maps) | Before confirm; a package whose confirm never comes is swept with its open uploads after a day (7.6) | `public, max-age=31536000, immutable` |
| `maps/{packageKey}/terrain.pmtiles` | The map's terrain archive, raster-dem PMTiles in terrarium encoding; absent when the package was built without terrain | The same | The same | `public, max-age=31536000, immutable` |
| `maps/{packageKey}/manifest.json` | The map row's fields (the `TrackerMap` shape of 4.0), for operators | The API node handling the confirm | Inside the confirm | `public, max-age=31536000, immutable` |
| `themes/{sha256}.json` | A tracker theme's style body (1.3 `trackerThemes[].styleUrl`): the canonical JSON the API accepted, a Google styles array or a MapLibre style | The API node handling the theme create or style replace (4.5 Themes); the node that migrates on boot for the seeded themes (sql.md 8.16) | Before the row write; under the migration lock | `public, max-age=31536000, immutable` |
| `themes/{themeId}/sprites/{sha256}/sprite.json`, `sprite.png`, `sprite@2x.json`, `sprite@2x.png` | A MapLibre theme's sprite set (1.3 `trackerThemes[].spriteUrl`); `{sha256}` is the hash of the canonical bytes of `sprite.json`, the index that names the images, so a re-upload is a new prefix and the old one stays | The admin panel, straight to S3 with a presigned PUT (4.5 Themes) | Before the sprite confirm; the object carries the tag `state=pending` until the API confirms it | `public, max-age=31536000, immutable` |
| `basemap/tiles.pmtiles`, `basemap/terrain.pmtiles`, `basemap/glyphs/{fontstack}/{range}.pbf` | The archives of the seeded "Missoula valley" map (its `prefix` is `basemap`, section 5) and the glyph set every MapLibre theme's labels use | The operator, by hand, once (platform.md 1.8) | Before the seed | `public, max-age=86400` |

The bucket is private; CloudFront reads it through origin access control and is the only reader (1.7). Nothing under any other prefix is written by v2. `{sha256}` is the lowercase hex SHA-256 of the object bytes (canonical bytes for JSON, section 1.6; the file bytes for icons and the bundled email images). `{mediaId}` is the asset's UUID; `{filename}` is the uploaded name sanitized to `[A-Za-z0-9._-]`, at most 100 characters. `{packageKey}` is the lowercase hex SHA-256 of the canonical JSON `{ bbox, minZoom, maxZoom, terrainMaxZoom }` of the package (4.5 Maps); `{themeId}` is the theme row's id. No object under any prefix is ever overwritten in place.

`Content-Type` is `application/json; charset=utf-8` for JSON, `image/svg+xml` for SVG, the sniffed type for raster uploads, `image/webp` for variants, `image/png` for the email images and the sprite images, `application/octet-stream` for the PMTiles archives. All JSON is written minified.

The API never reads any of these objects back except at a confirm (a media upload, the first 127 bytes of each archive of a map package, a theme's sprite files). The database is the source of truth; the objects are projections.

### 1.2 Live object: `live/location.json` and the hub `location` event

The API hands the same bytes to the CDN PUT and to the hub publish (section 2.6). The site holds exactly one copy in its store and replaces it by the rules below whichever path delivered it.

```json
{
  "schemaVersion": 1,
  "eventId": 7,
  "eventStatusId": 3,
  "pollIntervalMs": 5000,
  "hubEnabled": true,
  "snapshotUrl": "https://<cdn-domain>/snapshots/3f9a1c...b2e1.json",
  "cookieTally": { "1": 412, "3": 90 },
  "seq": 1832,
  "lat": 46.87,
  "lng": -114.0,
  "speedMps": 31.2,
  "altitudeM": 1210,
  "headingDeg": 84,
  "accuracyM": 6,
  "recordedAt": "2026-12-22T01:31:07.000Z",
  "receivedAt": "2026-12-22T01:31:07.412Z",
  "publishedAt": "2026-12-22T01:31:07.430Z",
  "onlineCount": 214
}
```

Keys appear in this order.

| Field | Type | Null when | Meaning |
|---|---|---|---|
| `schemaVersion` | `int` | never | `1` |
| `eventId` | `int64 \| null` | no event is current | The current event (1.3 defines "current"). |
| `eventStatusId` | `int \| null` | `eventId` is null | Status of the current event. The site's page switch. |
| `pollIntervalMs` | `int` | never | CDN poll cadence floor. From setting `poll_interval_ms`. |
| `hubEnabled` | `bool` | never | Whether the site may use the hub. From setting `hub_enabled`. While false the site does not connect (and drops a connection it holds) and runs on the poll alone; the operator's switch for every visitor at once (1.9). |
| `snapshotUrl` | `string` | never (a snapshot always exists after first boot) | Absolute CDN URL of the current snapshot. Changes only when the snapshot is rebuilt with different content. |
| `cookieTally` | `object` | never (`{}` when no cookies or no event) | Keys are cookie type ids as decimal strings, emitted in ascending numeric id order; values are `int` counts of cookies on the current event, seeded cookies (4.5 Events) included. A type with zero cookies is absent; the site fills zeros from `snapshot.cookieTypes`. |
| `seq` | `int64 \| null` | the current event has no published location | Arrival sequence of the location fields below, per event, strictly increasing. |
| `lat`, `lng` | `number \| null` | same as `seq` | Degrees. |
| `speedMps`, `altitudeM`, `headingDeg`, `accuracyM` | `number \| null` | same as `seq`, or the update carried null | Units per 0.2. `speedMps` on the live object is the beacon's value when the fix carried one, else the value the API derived from the previous stored fix on the event (haversine distance divided by the seconds between the two `recordedAt` values). |
| `recordedAt` | `rfc3339 \| null` | same as `seq` | The fix time the beacon sent. Informational; it never decides anything. |
| `receivedAt` | `rfc3339 \| null` | same as `seq` | When the API stored the update. |
| `publishedAt` | `rfc3339` | never | When this object was built. Used for the "last update" display and the tie-break below. |
| `onlineCount` | `int \| null` | the count is not being published: `eventStatusId` is not 3, `hubEnabled` is false, or the gateway count read failed, timed out, or is not configured | How many sockets are subscribed to the site's `<service>:location` channel, from the gateway's `GET /internal/presence/<service>:location/count` (7.4). The site shows the count only while it is non-null and hides it otherwise; the map section's `overlays.onlineCount` hides it on a page. |

Rules:

- The location fields are the last published fix on the current event, stored or carried, read from `event.latest_fix` (the newest `location` row with `published = true` when `latest_fix` is null). Switching the active beacon leaves these fields as they are until the newly active beacon's first update arrives.
- `cookieTally` is the count of cookies on the current event at the time the object is built while the event's status is 1, 2, 3, or 5. On entry into status 4 the counts are copied to `event.final_cookie_tally` and every later live object for that event carries that column unchanged. There is no cookie moderation: a cookie once left counts until its event is deleted.
- Apply rule on the site, for an incoming object `L` when `store.live` exists (when it does not, replace):
  - `L.eventId !== store.live.eventId`: replace only when `L.publishedAt > store.live.publishedAt`.
  - Same event, `store.live.seq !== null`, and `L.seq === null`: discard. Within one event the location fields never go from present to absent.
  - Same event, both `seq` values non-null, and `L.seq < store.live.seq`: discard.
  - Same event, `L.seq === store.live.seq` (or both null), and `L.publishedAt <= store.live.publishedAt`: discard.
  - Otherwise replace.

  `publishedAt` comparisons are ordinal string comparisons; the canonical format (fixed width, three fractional digits, `Z`) makes that equivalent to time order. This makes the hub and the poll safe to mix for a browser that already holds the newer object; the CDN copy is corrected by the rewrite rule in 7.4, because an ingest PUT built before a status change can land after the admin node's PUT.
- `onlineCount` is informational and never takes part in the apply rule; a write that could not read the count carries null rather than waiting for it.
- Nothing on this object is derived by the site except the page choice from `eventStatusId`.

### 1.3 Snapshot: `snapshots/{sha256}.json`

"Current event" is the event whose `is_current` flag is true. The admin sets it explicitly (`POST /admin/events/{id}/current`); at most one event is current (partial unique index); only the current event can be set live; the flag cannot be moved while the current event is live. `event` is `null` in the snapshot and `eventId` is null on the live object when no event is current.

```json
{
  "schemaVersion": 1,
  "event": {
    "id": 7,
    "year": 2026,
    "name": "Santa Flyover 2026",
    "statusId": 3,
    "scheduledAt": "2026-12-22T01:00:00.000Z",
    "wentLiveAt": "2026-12-22T01:02:11.000Z",
    "endedAt": null,
    "fundsPercent": 63,
    "flightHistory": {
      "routeId": 3,
      "name": "2025 flight",
      "points": [
        { "lat": 46.8721, "lng": -114.0012, "recordedAt": "2025-12-22T01:31:07.000Z" },
        { "lat": 46.8730, "lng": -114.0030, "recordedAt": "2025-12-22T01:31:37.000Z" }
      ]
    },
    "routeMap": {
      "path": [
        { "lat": 46.8721, "lng": -114.0012 },
        { "lat": 46.874032, "lng": -114.008311 },
        { "lat": 46.879514, "lng": -114.015027 },
        { "lat": 46.886203, "lng": -114.017446 }
      ],
      "timeline": [
        { "minutes": 0, "lat": 46.8721, "lng": -114.0012 },
        { "minutes": 5, "lat": 46.874818, "lng": -114.009274 },
        { "minutes": 10, "lat": 46.881297, "lng": -114.015672 },
        { "minutes": 12, "lat": 46.886203, "lng": -114.017446 }
      ],
      "durationMinutes": 12,
      "timed": true
    },
    "routeMapConfig": {
      "display": { "timeLabelIntervalMinutes": 10, "routeWidth": "thick" },
      "controls": { "terrain": false }
    },
    "latestMessage": {
      "id": 12,
      "body": "Santa is airborne over the valley.",
      "createdAt": "2026-12-22T01:02:30.000Z"
    },
    "trackerBbox": { "west": -114.30, "south": 46.75, "east": -113.80, "north": 47.05 },
    "trackerMap": {
      "id": 3, "name": "Missoula valley", "bbox": { "west": -114.75, "south": 46.35, "east": -113.30, "north": 47.25 },
      "minZoom": 0, "maxZoom": 15, "terrainMaxZoom": 13,
      "tilesUrl": "https://<cdn-domain>/basemap/tiles.pmtiles", "terrainUrl": "https://<cdn-domain>/basemap/terrain.pmtiles"
    }
  },
  "sponsors": [
    {
      "id": 4,
      "name": "Example Bakery",
      "websiteUrl": "https://example.com",
      "fbUrl": null,
      "igUrl": "https://instagram.com/example",
      "logoMediaId": "8c1d5e2a-7b3f-4c9e-9a1d-2f6e8b4c0a11",
      "latestYear": 2026,
      "yearsAsSponsor": 3,
      "lingerMs": 12000
    }
  ],
  "cookieTypes": [
    { "id": 1, "name": "Chocolate chip", "icon": { "source": "library", "id": "cookie" }, "sort": 10 },
    { "id": 3, "name": "Gingerbread", "icon": { "source": "media", "id": "3b7e9c10-2d4f-4a8b-b6c1-9e0f7d5a2c33" }, "sort": 20 }
  ],
  "content": {
    "schemaVersion": 1,
    "settings": {
      "siteName": "Western Montana Santa Flyover",
      "tagline": "Santa flies over the valley every December",
      "homeNavLabel": "Track Santa",
      "logo": { "source": "library", "id": "sleigh" },
      "favicon": { "source": "library", "id": "santa-hat" },
      "theme": { "snowDefault": true, "lightsDefault": true, "ornaments": true },
      "navExtraLinks": [],
      "footerLinks": [ { "label": "Facebook", "href": "https://facebook.com/example", "icon": { "source": "library", "id": "facebook" }, "newTab": true } ],
      "footerText": "A volunteer project. {icon:heart}",
      "contactEmail": "hello@example.org",
      "donateUrl": "https://example.org/donate",
      "analyticsEnabled": true
    },
    "pages": [
      {
        "id": 3, "slug": "about", "title": "About the flyover", "navLabel": "About", "navPosition": 10, "role": "none",
        "sections": [
          {
            "id": 9, "kind": "hero",
            "presentation": { "width": "full", "align": "center", "background": { "kind": "media", "media": { "mediaId": "8c1d5e2a-7b3f-4c9e-9a1d-2f6e8b4c0a11", "alt": null }, "overlay": 0.4 }, "spacing": "normal", "iconBefore": null, "iconAfter": null, "anchor": null },
            "data": { "title": "{event:name}", "tagline": "Since 2020", "icon": { "source": "library", "id": "helicopter" }, "links": [], "height": "tall" },
            "items": []
          },
          {
            "id": 10, "kind": "rich_text",
            "presentation": { "width": "narrow", "align": "start", "background": { "kind": "none" }, "spacing": "normal", "iconBefore": { "source": "library", "id": "candy-cane" }, "iconAfter": null, "anchor": "story" },
            "data": { "blocks": [ { "kind": "heading", "level": 2, "text": "How it started", "icon": null }, { "kind": "paragraph", "text": "A few pilots, a **sleigh**, and a valley full of kids. {icon:star}" } ] },
            "items": []
          }
        ]
      }
    ]
  },
  "media": {
    "8c1d5e2a-7b3f-4c9e-9a1d-2f6e8b4c0a11": {
      "url": "https://<cdn-domain>/media/8c1d5e2a-7b3f-4c9e-9a1d-2f6e8b4c0a11/hangar.jpg",
      "kind": "raster", "width": 2400, "height": 1600, "alt": "The helicopter in its hangar",
      "variants": { "480": "https://<cdn-domain>/media/8c1d.../w480.webp", "960": "https://<cdn-domain>/media/8c1d.../w960.webp", "1600": "https://<cdn-domain>/media/8c1d.../w1600.webp" },
      "dzi": "https://<cdn-domain>/media/8c1d5e2a-7b3f-4c9e-9a1d-2f6e8b4c0a11/dzi/poster.dzi"
    },
    "3b7e9c10-2d4f-4a8b-b6c1-9e0f7d5a2c33": {
      "url": "https://<cdn-domain>/media/3b7e9c10-2d4f-4a8b-b6c1-9e0f7d5a2c33/gingerbread.svg",
      "kind": "svg", "width": null, "height": null, "alt": "Gingerbread cookie", "variants": {}, "dzi": null
    }
  },
  "icons": {
    "candy-cane": "https://<cdn-domain>/icons/aa11...svg",
    "cookie": "https://<cdn-domain>/icons/bb22...svg"
  },
  "trackerThemes": [
    {
      "id": 1, "renderer": "google", "key": "standard", "name": "Standard",
      "styleUrl": "https://<cdn-domain>/themes/cc33...json", "spriteUrl": null,
      "thumbnailMediaId": null,
      "chrome": { "bg": "#ffffff", "fg": "#5f6368", "text": "#202124", "tile": "#e8f0fe", "tileFg": "#1a56c4", "panel": "#ffffffe6", "accent": "#1a56c4" },
      "overlay": { "routeColor": "#1a56c4", "routeOpacity": 0.9, "arrowColor": "#ffffff", "timeLabelBg": "#1c1c1e", "timeLabelFg": "#ffffff", "timeLabelOpacity": 0.8, "userColor": "#c62828" },
      "defaultLightMode": true, "defaultDarkMode": false
    },
    {
      "id": 7, "renderer": "maplibre", "key": "route-light", "name": "Route light",
      "styleUrl": "https://<cdn-domain>/themes/dd44...json", "spriteUrl": "https://<cdn-domain>/themes/7/sprites/ee55.../sprite",
      "thumbnailMediaId": "8c1d5e2a-7b3f-4c9e-9a1d-2f6e8b4c0a11",
      "chrome": { "bg": "#fbfaf7", "fg": "#5c5a55", "text": "#1e1d1a", "tile": "#e8efe6", "tileFg": "#1f5f3a", "panel": "#fbfaf7e6", "accent": "#1f5f3a" },
      "overlay": { "routeColor": "#c62828", "routeOpacity": 0.9, "arrowColor": "#ffffff", "timeLabelBg": "#1e1d1a", "timeLabelFg": "#ffffff", "timeLabelOpacity": 0.8, "userColor": "#1a56c4" },
      "defaultLightMode": true, "defaultDarkMode": false
    }
  ]
}
```

Keys appear in this order.

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | `int` | `1` |
| `event` | `object \| null` | The current event; `null` when none is current. |
| `event.id`, `event.year`, `event.name`, `event.statusId` | `int64`, `int`, `string`, `int` | As stored. |
| `event.scheduledAt` | `rfc3339 \| null` | Admin-entered. Countdown target when `statusId` is 2. |
| `event.wentLiveAt` | `rfc3339 \| null` | Stamped by the API on every entry into status 3, kept on entry into 4, and cleared on entry into 1, 2, 5, or 6, whatever the status left; admin-patchable. Liftoff timer origin. |
| `event.endedAt` | `rfc3339 \| null` | Stamped by the API on every entry into status 4 and cleared on entry into any other status, whatever the status left; admin-patchable. |
| `event.fundsPercent` | `int` | 0 to 100. Cheer meter. |
| `qrCodes` | `{ [tag: string]: { pageSlug: string \| null; forwardUrl: string \| null } }` | Every active printed code (4.5a) already resolved, the ones that open the home page included (`pageSlug` `/`): a page slug (`/` for the home page, else the `none` page's slug), or an off-site URL, never both; the site's `/q/:tag` route reads this and nothing else. Absent tags open the home page. Written by the snapshot builder from `qr_code`, `qr_attachment`, and `place`; the code and place writes marked [snapshot] in 4.5a rebuild it. |
| `event.flightHistory` | `object \| null` | The flight recording linked to the event (`event.route_id`, 1.4), embedded so the tracker's "flight history" toggle needs no second fetch: `routeId`, `name`, and `points[]` (`lat`, `lng`, `recordedAt`) in route order, thinned by keeping every `ceil(n / flight_history_max_points)`-th point from the first and always the last, so at most `flight_history_max_points` + 1 points (section 6). `null` when no recording is linked. The admin changes it with `PATCH /admin/events/{id} { routeId }`, a snapshot-affecting write, so every new or rebuilt snapshot carries the history the admin chose. |
| `event.routeMap` | `RouteMap \| null` | The same linked recording (`event.route_id`, 1.4) processed for the site's route map, so the map and its time slider need no second fetch; it is the only route the site shows (the `route_preview` section, 1.3a), and the event carries no route image. `null` when no recording is linked. Shape `{ path: { lat, lng }[]; timeline: { minutes, lat, lng }[]; durationMinutes: int; timed: bool }`, keys in this order. `path`: the recording's points simplified with Douglas-Peucker at `route_map_simplify_tolerance_m` metres (a point's distance is measured to where the segment puts its distance along the recording, so a turn back along the same line is kept), smoothed by two passes of Chaikin corner cutting (the first and last point stay put), then thinned evenly to at most `route_map_max_points` vertices, always keeping the first and last; coordinates rounded to 6 decimals. Time model: a point with a non-null `recordedAt` is an anchor when its time is not earlier than the previous anchor's (an earlier one is treated as null). With 2 or more anchors the route is timed (`timed` true): the duration is the last anchor's time minus the first's, and the time at any position is piecewise linear in cumulative distance between the surrounding anchors (points before the first anchor sit at 0, points after the last at the end). With fewer than 2 anchors the route is untimed (`timed` false): the duration is `route_map_default_duration_minutes` and time is proportional to cumulative distance. `durationMinutes`: the duration in whole minutes, rounded up, at least 5. `timeline`: the position on `path` at minutes 0, 5, 10, and so on below `durationMinutes` (the minute becomes a distance along the recording through the time model, and every `path` vertex carries the distance along the recording it came from, so the position is read off `path` at that distance and a stop holds its place), plus a final entry at `durationMinutes` (the last point of `path`), so the final step is shorter than 5 when `durationMinutes` is not a multiple of 5; coordinates rounded to 6 decimals. The build is deterministic: the same recording and settings give the same bytes. `GET /admin/events/{id}/route-map` (4.5 Events) serves the same object for any event, and `GET /admin/routes/{id}/route-map` (4.5 Routes) for any recording. |
| `event.routeMapConfig` | `RouteMapConfig \| null` | The current event's route map configuration (`event.route_map_config`): the display knobs and control switches the `route_preview` map (1.3a) uses for this event, configured once per event. The landmarks and the places are not part of it: they are the sitewide `settings.landmarks` and `settings.places` (1.3a), the same every year. `null` when the event has none, which means every built-in default. Set with `PATCH /admin/events/{id} { routeMapConfig }` (4.5 Events), a snapshot-affecting write, and copied by the clone's `copy.routeMapConfig`. Shape and rules under **Route map configuration** below. |
| `event.latestMessage` | `object \| null` | The `event_message` with the greatest `created_at` for this event (ties on `created_at` broken by greatest `id`), or `null` when the event has none. |
| `event.latestMessage.id`, `body`, `createdAt` | `int64`, `string`, `rfc3339` | As stored, in this order and nothing else. A message's time is its `createdAt`, the time it was posted. |
| `event.trackerBbox` | `Bbox` | The event's bounding box (`event.tracker_bbox`, required on every event): `{ west, south, east, north }` in degrees, keys in this order, `west < east`, `south < north`, each side at least 0.05 and at most 20 degrees. Both tracker renderers lock to it: no panning outside it, and the minimum zoom is the zoom that fits it in the viewport; the route preview takes its pan limit and minimum zoom from it and keeps its fit-to-path view (site.md 8). A new event takes `settings.tracker.defaultBbox` (1.3a) unless the create names a box; set with `PATCH /admin/events/{id} { trackerBbox }` (4.5 Events), a snapshot-affecting write. The tile CLI builds packages from it (platform.md 1.8). |
| `event.trackerMap` | `TrackerMap \| null` | The tile package the tracker and the route preview render with MapLibre (`event.tracker_map_id`, 4.5 Maps): `{ id, name, bbox, minZoom, maxZoom, terrainMaxZoom, tilesUrl, terrainUrl }`, keys in this order. `bbox` is the package's box and contains `trackerBbox`; `tilesUrl` is the absolute CDN URL of the vector archive (`maps/{packageKey}/tiles.pmtiles`, or `basemap/tiles.pmtiles` for the seeded map); `terrainUrl` likewise for the terrain archive, `null` together with `terrainMaxZoom` when the package has none. Only a `ready` map appears here. `null` when the event has no map: every viewer gets Google Maps, locked to `trackerBbox`. The last key of `event`. Set with `PATCH /admin/events/{id} { trackerMapId }`, a snapshot-affecting write. |
| `sponsors[]` | `object[]` | Sponsors having a `sponsor_year` row with `event_year = event.year`, `active = true`, `anonymous = false`, `can_advertise = true`. Order: rows with `pinned_position` set first, `pinned_position` asc; then the rest by `amount_donated` desc (nulls last), `name` asc, `id` asc. This is the display order everywhere on the site (grid, carousel, live overlay); nothing reshuffles it. Empty when `event` is null. |
| `sponsors[].websiteUrl`, `fbUrl`, `igUrl` | `string \| null` | As stored. |
| `sponsors[].logoMediaId` | `string \| null` | The sponsor's logo as a media asset id, resolved through `media`; `null` when no logo. |
| `sponsors[].latestYear` | `int` | Greatest `event_year` among the sponsor's rows. |
| `sponsors[].yearsAsSponsor` | `int` | Count of distinct `event_year` rows for the sponsor. |
| `sponsors[].lingerMs` | `int` | `linger_ms_override` when the year row has one; otherwise `max(sponsor_linger_min_ms, round(amount_donated * sponsor_linger_ms_per_dollar))`, or `sponsor_linger_min_ms` alone when `amount_donated` is null. Whether a value was overridden or pinned is not exposed. |
| `cookieTypes[]` | `object[]` | Rows with `active = true`, ordered `sort` asc, `id` asc. |
| `cookieTypes[].id`, `name`, `icon`, `sort` | `int64`, `string`, `Icon \| null`, `int` | As stored; `icon` is the value type in 1.3a. |
| `content` | `object` | The published content document (1.3a), byte for byte the `document` of the newest `content_version` row. Never null after first boot. |
| `media` | `object` | Map of media asset id to `MediaEntry` (1.3b) for every asset referenced by `content`, by a sponsor in `sponsors[]`, by a cookie type in `cookieTypes[]`, or as a thumbnail in `trackerThemes[]` (a landmark's media icon is in `content`, under `settings.landmarks`). Keys in ascending string order. |
| `icons` | `object` | Map of library icon id to absolute CDN URL for the whole built-in library (1.3b). Keys in ascending string order. |
| `trackerThemes[]` | `object[]` | The current event's enabled themes (`event_tracker_theme`, 4.5 Events), both renderers, ordered `sortOrder` asc, `id` asc; empty when `event` is null. The site resolves the starting theme per renderer in this order: the viewer's stored key when it names an entry on the active renderer, then the entry with `defaultDarkMode` when the page resolved dark and the one with `defaultLightMode` otherwise, then the first entry (site.md 8). The last top-level key. Written by the snapshot builder; the theme writes marked [snapshot] in 4.5 Themes and the event's `trackerThemeIds` rebuild it. |
| `trackerThemes[].id`, `renderer`, `key`, `name` | `int64`, `"google" \| "maplibre"`, `string`, `string` | As stored, in this order. `key` is the stable slug the viewer's stored choice names (`^[a-z][a-z0-9-]{1,39}$`, unique per renderer). |
| `trackerThemes[].styleUrl` | `string` | Absolute CDN URL of the style body, `themes/{sha256}.json` (1.1), fetched on demand: for `google` a styles array, for `maplibre` a style JSON whose sources are `basemap` (vector) and, optionally, `terrain` (raster-dem) with no URL; the site injects `pmtiles://` URLs from `event.trackerMap` and drops every layer whose `source` is `terrain` when `terrainUrl` is null. |
| `trackerThemes[].spriteUrl` | `string \| null` | The MapLibre sprite base of the theme's sprite set, `https://<cdn-domain>/themes/{id}/sprites/{spriteSha256}/sprite` (no extension; MapLibre appends `.json`, `.png`, and `@2x` to it, the four objects of 1.1), when the theme has one (`tracker_theme.sprite_sha256`); `null` otherwise, and always for `google`. |
| `trackerThemes[].thumbnailMediaId` | `string \| null` | The theme's thumbnail as a media asset id, resolved through `media` (the site reads the `480` variant); `null` when none, in which case the site shows the chrome swatches. |
| `trackerThemes[].chrome` | `Chrome` | `{ bg, fg, text, tile, tileFg, panel, accent }`, each `#rrggbb` or `#rrggbbaa`, keys in this order: the colours of everything on the tracker screen that is not the map (menu panel, buttons, flight gauge, menu tiles, text, the accent). `text` on `bg` and `tileFg` on `tile` contrast at 4.5:1 or better (4.5 Themes). |
| `trackerThemes[].overlay` | `Overlay` | `{ routeColor, routeOpacity, arrowColor, timeLabelBg, timeLabelFg, timeLabelOpacity, userColor }`, keys in this order: what the site draws over the map (the path, its arrows, the time labels, the viewer's own marker); colours as in `chrome`, opacities 0 to 1. |
| `trackerThemes[].defaultLightMode`, `defaultDarkMode` | `bool`, `bool` | The renderer's starting theme in the light and in the dark appearance. At most one theme per renderer carries each flag; one theme may carry both (4.5 Themes). |

**Route map configuration.** An event's route map is configured once, on the event, and applies to every `route_preview` section while that event is current; nothing about it lives in a section or in the site settings.

```ts
type RouteMapConfig = {                      // every key optional; no other key is allowed at any level
  display?: {
    timeLabelIntervalMinutes?: 0 | 5 | 10 | 15 | 30;   // minutes between the time labels along the path; 0 draws no time labels; absent means 15
    arrows?: boolean;                        // direction arrows along the path; absent means true
    arrowSize?: "small" | "medium" | "large" | "xlarge";   // absent means "medium"
    routeWidth?: "thin" | "normal" | "thick" | "xthick";   // the path's stroke width; absent means "normal"
    labelSize?: "small" | "medium" | "large";   // the text size of the time labels and the landmark names; absent means "medium"
  };
  controls?: {
    fullscreen?: boolean;                    // the map's fullscreen button; absent means true
    terrain?: boolean;                       // the terrain (hillshade) toggle; absent means true
  };
};
```

Every key is optional, and an absent key (or an absent object) keeps the built-in behaviour listed beside it. The API stores and publishes a key only when it is set, keys in the order above. `arrowSize` has no visible effect while `arrows` is false; the pixel sizes behind the size and width names are the site's (site.md), not the contract's. `labelSize` sizes the time labels and the landmark names together; the site applies it on top of its zoom curve for label text, so a label still grows and shrinks with the zoom and `labelSize` scales that curve. `terrain` shows the toggle that draws the event's terrain archive (`event.trackerMap.terrainUrl`, 1.3) under the path as hillshade; the site hides the toggle regardless when the event's map has no terrain archive or the event has no map. The schema is `$defs/RouteMapConfig` in `primitives.schema.json`; the API validates every write against it in full (there is no draft level), so a bad enum, a wrong type, an out of range value, or an unknown key at any level is `400 validation_failed` on the field (`routeMapConfig.display.arrowSize`). The landmarks and the places are site settings (`settings.landmarks` and `settings.places`, 1.3a), so a write that sends `landmarks` or `pois` here is `400 validation_failed` at `routeMapConfig.landmarks` or `routeMapConfig.pois` like any unknown key.

The snapshot row's `version` and `built_at` stay on the row and on `GET /admin/snapshot`; they are not part of the object, so two rebuilds with identical data produce identical bytes. Amounts donated never appear in any public object. The snapshot never contains cookie notes, person data, beacon data, telemetry, or donation amounts.

A snapshot-affecting write is any admin write to: `event` (create, update, delete, status, current, route image link, flight history link, route map configuration, the tracker box, the tracker map, the enabled themes, notify with a `message`), `event_message`, `sponsor`, `sponsor_year`, `cookie_type`, any `app_setting` key, a media asset's `alt` (it rides in `media`), a content publish (4.5 Content), and the writes to `tracker_map` and `tracker_theme` marked [snapshot] in 4.5 Maps and Themes, which rebuild only while the current event references the row (its map, an enabled theme, the previous default holder, or the replacement of a delete) and otherwise commit without a rebuild, as `POST .../notify` does without a message. Working-set writes (pages, sections, items, site settings draft) and media uploads are not snapshot-affecting; nothing reaches the site until a publish. Section 7.3 gives the transaction.

### 1.3a Content document

The content document is what an editor publishes: site settings plus pages made of sections. It lives in `content_version.document` and rides in the snapshot as `content`. Instances are data; kinds are code: the site holds one React component and one JSON Schema per section kind and per block kind, and renders whatever the document says, skipping any kind it does not know.

```ts
type ContentDocument = { schemaVersion: 1; settings: SiteSettings; pages: ContentPage[] };
type PageRole = "none" | "no_event" | "planned" | "scheduled" | "live" | "ended" | "cancelled" | "postponed";
type ContentPage = { id: number; slug: string; title: string; navLabel: string | null; icon: Icon | null; navPosition: number; role: PageRole; sections: ContentSection[] };
type ContentSection = { id: number; kind: string; presentation: Presentation; data: object; items: ContentItem[] };
type ContentItem = { id: number; data: object };
```

Pages appear in `navPosition` asc, `id` asc; sections in `position` asc, `id` asc; items likewise. Hidden pages, hidden sections, and hidden items are omitted at publish; the document carries only what renders. Exactly one page per non-`none` role is present (the seven are created by the seed; a role page is deleted only by handing its role to a `none` page, 4.5 Pages). A role page renders at `/` when its role matches `live.eventStatusId` (`no_event` when null); a `none` page renders at `/<slug>`. A role page's `navLabel` is always null; the home entry of the nav is site code, labelled by `settings.homeNavLabel`, linking to `/`. Every page entry carries `icon`, the page's own `Icon` (below) or null when it has none; any page, role pages included, can carry one, and the site shows it beside the page's entry in the corner panel. A media-sourced page icon rides in the snapshot's `media` like every other referenced asset.

**Shared primitives**, defined once in `contracts/schema/primitives.schema.json` and referenced by every kind:

```ts
type Icon = { source: "library"; id: string; display?: Display | null } | { source: "media"; id: string; display?: Display | null };
  // library: an id from the icons map; media: the id of a ready media asset of any kind
type MediaRef = { mediaId: string; alt: string | null; display?: Display | null };  // alt null means the asset's own alt
type Bbox = { west: number; south: number; east: number; north: number };   // $defs/Bbox: degrees, west < east, south < north, no other key; the side limits are the writer's (1.3 event.trackerBbox, 4.5 Maps)
type Display = {                                               // every key optional; unknown keys are rejected
  sizePx?: number;                                             // integer, 12 to 600
  fit?: "contain" | "cover";
  shape?: "none" | "circle" | "rounded" | "square";
  paddingPx?: number;                                          // integer, 0 to 48
  background?: "none" | "surface" | "muted" | "accent" | "night";
  shadow?: boolean;
  align?: "start" | "center" | "end";
};
type Link = { label: Inline; href: string; icon: Icon | null; newTab: boolean };
  // href: absolute http or https URL, a mailto: address, or a site path starting with "/" (a page slug, optionally "#anchor")
type Inline = string;                                          // constrained inline markdown, below; 1 to 5000 characters
type Presentation = {
  width: "full" | "wide" | "narrow";
  align: "start" | "center";
  background: { kind: "none" } | { kind: "token"; token: "surface" | "muted" | "accent" | "night" } | { kind: "media"; media: MediaRef; overlay: number };  // overlay 0 to 1
  spacing: "tight" | "normal" | "loose";
  iconBefore: Icon | null;
  iconAfter: Icon | null;
  anchor: string | null;                                       // ^[a-z0-9]+(-[a-z0-9]+)*$, unique within a page
  card?: boolean | null;                                       // absent or null means true: the section renders in a card; never applied to `map`
  iconSize?: "sm" | "md" | "lg" | "xl" | null;                 // size of iconBefore and iconAfter; absent or null means "sm"
  cardOpacityLight?: number | null;                            // integer, 0 to 100; the card fill's opacity in the light theme; absent or null means the sitewide value
  cardOpacityDark?: number | null;                             // integer, 0 to 100; the card fill's opacity in the dark theme; absent or null means the sitewide value
};
type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: Inline; icon: Icon | null }
  | { kind: "paragraph"; text: Inline }
  | { kind: "list"; style: "bullet" | "number" | "icon"; icon: Icon | null; items: Inline[] }   // 1 to 100 items
  | { kind: "quote"; text: Inline; attribution: Inline | null }
  | { kind: "media"; media: MediaRef; caption: Inline | null; size: "small" | "medium" | "full" }
  | { kind: "links"; links: Link[]; style: "buttons" | "list" }                                   // 1 to 20 links
  | { kind: "icon"; icon: Icon; size: "sm" | "md" | "lg" | "xl"; align: "start" | "center" }
  | { kind: "divider"; style: "line" | "snowflakes" | "lights" };
```

`card` and `iconSize` are optional: the API stores and publishes them only when set, and a reader treats an absent or null value as the default. The site never cards the `map` section whatever `card` says. The contract names the sizes; the pixel size of each one is the site's (site.md), not the contract's.

`display` is an optional, bounded display setting on any `Icon` or `MediaRef`; the API stores and publishes it only when set, and validates it on every write (an out-of-range value is `400 validation_failed`). The site applies it where it draws the icon or the image, and `sizePx`, when set, wins over preset sizes such as `iconSize`, a hero's `iconSize`, an `icon` block's `size`, or a `media` block's `size`. A key left out keeps the site's default for that place. The schema writes the lower bounds of `sizePx` and `paddingPx` as `exclusiveMinimum` (11 and -1) so draft validation, which drops `minimum`, still enforces them.

**Inline markdown.** `**bold**`, `*italic*`, `\`code\``, `[label](href)` with the same href rules as `Link`, a line break as a newline character, an icon as `{icon:<library-id>}` or `{icon:media:<mediaId>}`, and the placeholders `{event:name}`, `{event:year}`, `{event:scheduledAt}` (filled from `snapshot.event`; blank when there is no current event; `scheduledAt` formatted by the site in the viewer's timezone). Everything else is literal text. No raw HTML is stored or rendered; the site's inline parser produces React elements, never `innerHTML`.

**Section kinds.** One schema per kind at `contracts/schema/sections/<kind>.schema.json` (data) and, for kinds with items, `<kind>.item.schema.json`. `live` kinds carry configuration and read the live object and the snapshot; `content` kinds carry everything they render.

| Kind | Live | `data` | Items | Rule |
|---|---|---|---|---|
| `rich_text` | no | `{ blocks: Block[] }` (1 to 200) | none | |
| `hero` | no | `{ title: Inline; tagline: Inline \| null; icon: Icon \| null; links: Link[]; height: "short" \| "tall"; iconSize?: "sm" \| "md" \| "lg" \| "xl" \| null; showLogo?: boolean \| null }` (`links` 0 to 2; `iconSize` sizes `icon`, absent or null means `"sm"`; `showLogo` true draws the site settings `logoMedia` in place of `icon` at `iconSize`, absent or null means false) | none | the background image is `presentation.background` with `kind: "media"`, like any section |
| `media` | no | `{ layout: "single" \| "grid" \| "carousel"; columns: 2 \| 3 \| 4 }` | `{ media: MediaRef; caption: Inline \| null; link: Link \| null }` (1 to 50) | |
| `links` | no | `{ heading: Inline \| null; style: "buttons" \| "cards" \| "list" }` | `{ link: Link; description: Inline \| null }` (1 to 50) | |
| `icon_row` | no | `{ size: "sm" \| "md" \| "lg"; spacing: "tight" \| "normal" \| "loose" }` | `{ icon: Icon; label: Inline \| null }` (1 to 30) | |
| `divider` | no | `{ style: "line" \| "snowflakes" \| "lights" }` | none | |
| `funds_ring` | yes | `{ heading: Inline \| null; caption: Inline \| null; size: "small" \| "large"; showYear: boolean }` | none | reads `snapshot.event.fundsPercent`, `year`; 0 and no year when `event` is null |
| `countdown` | yes | `{ heading: Inline \| null }` | none | reads `snapshot.event.scheduledAt`; renders nothing unless `live.eventStatusId` is 2 and `now < scheduledAt` |
| `event_times` | yes | `{ fields: ("scheduledAt" \| "wentLiveAt" \| "endedAt" \| "airborneFor")[]; labels: { scheduledAt: Inline; wentLiveAt: Inline; endedAt: Inline; airborneFor: Inline } }` (`fields` 1 to 4, distinct) | none | each field renders only when its value exists; `airborneFor` is the elapsed time since `wentLiveAt` while status is 3 |
| `latest_message` | yes | `{ heading: Inline \| null; style: "card" \| "ticker" }` | none | reads `snapshot.event.latestMessage`; renders nothing when null |
| `map` | yes | `{ defaultCenter: { lat: number; lng: number }; defaultZoom: number; controls: { themePicker: boolean; terrain: boolean; snow: boolean; flightHistory: boolean; timeLabels: boolean; location: boolean; dataRow: boolean; landmarks?: boolean }; flightHistoryDefault: boolean; overlays: { liveIndicator: boolean; liftoffTimer: boolean; latestMessage: boolean; leaderboardPanel: boolean; sponsorCarousel: boolean; cookieControl: boolean; distanceChip: boolean; onlineCount?: boolean }}` (`defaultZoom` 3 to 18; `defaultCenter` and `defaultZoom` are the view inside the event's box when a fix exists outside it, the box itself being the initial view otherwise; `flightHistoryDefault` defaults false; `overlays.onlineCount` absent means true and shows the live object's `onlineCount` while it is non-null; `controls.landmarks` absent means true and shows the Viewpoints toggle in the tracker menu, which draws `settings.landmarks` and starts on; the places the tracker shows are the sitewide `settings.places.tracker`, not the section's; the themes the tracker offers and starts on are the event's `trackerThemes` (1.3), not the section's, and `themes` or `defaultTheme` here is `400 validation_failed` at the key like any unknown key) | none | allowed only on the page with role `live`; reads the live object, `snapshot.event.flightHistory`, `snapshot.event.trackerBbox`, `snapshot.event.trackerMap`, `snapshot.trackerThemes`, and `settings.places.tracker`; the full-viewport live screen of site.md section 8, on MapLibre when the event has a map and an enabled MapLibre theme and the browser passes the WebGL 2 probe, on Google Maps otherwise |
| `leaderboard` | yes | `{ heading: Inline \| null; variant: "panel" \| "full"; emptyText: Inline }` | none | reads `live.cookieTally` joined with `snapshot.cookieTypes` |
| `sponsor_carousel` | yes | `{ heading: Inline \| null; logoWidth: 480 \| 960 }` | none | reads `snapshot.sponsors` and `lingerMs` |
| `sponsor_grid` | yes | `{ heading: Inline \| null; columns: 2 \| 3 \| 4; showYears: boolean; emptyText: Inline }` | none | reads `snapshot.sponsors` |
| `route_preview` | yes | `{ heading: Inline \| null; disclaimer: Inline \| null; emptyText: Inline }` | none | the route map, always: draws `event.routeMap` (1.3) as `path` over the event's map (`event.trackerMap`, with the enabled MapLibre theme carrying the default flag for the page's appearance) or over Google Maps when the event has no map, no enabled MapLibre theme, or the browser cannot run MapLibre (site.md 8), with a time slider in 5 minute steps over `timeline`, and `disclaimer` shown above it; the view fits the path and `event.trackerBbox` is its pan limit; renders `emptyText` when the event has no recording (`event.routeMap` null, or no current event). It never shows a poster or any image: the poster belongs to the panel's poster studio and to distribution off the site. The map takes its display knobs (among them `labelSize`, the text size of the time labels and the landmark names) and control switches from the current event's `event.routeMapConfig` (1.3, **Route map configuration**), its landmarks from the sitewide `settings.landmarks`, and its places from the sitewide `settings.places.routeMap`; the section carries none of them, and any key beyond these three (`style` included) is `400 validation_failed` at the key |
| `cookie_control` | yes | `{ heading: Inline \| null; copy: Inline \| null; signedOutCopy: Inline; closedCopy: Inline }` | none | the leave-a-cookie control; `signedOutCopy` when signed out; `closedCopy` when `live.eventStatusId` is not 3 |
| `alerts_signup` | yes | `{ heading: Inline \| null; copy: Inline \| null; signedOutCopy: Inline }` | none | the subscription manager of 4.4 when signed in; `signedOutCopy` and a sign-in link otherwise |
| `contact_form` | yes | `{ heading: Inline \| null; copy: Inline \| null; successText: Inline }` | none | posts `POST /contact` |

**Site settings** (`contracts/schema/site-settings.schema.json`):

```ts
type SiteSettings = {
  siteName: Inline;                          // required
  tagline: Inline | null;
  homeNavLabel: Inline;                      // required; the nav entry for "/"
  logo: Icon | null;
  favicon: Icon | null;
  theme: {                                   // seasonal layers, the background ornaments, and the card fill opacity only; colours, fonts, and light/dark are the site's own (site.md 7.7)
    snowDefault: boolean;
    lightsDefault: boolean;
    ornaments: boolean;
    cardOpacityLight?: number | null;        // integer, 0 to 100; the card fill's opacity in the light theme; absent or null means 100
    cardOpacityDark?: number | null;         // integer, 0 to 100; the card fill's opacity in the dark theme; absent or null means 100
  };
  navExtraLinks: Link[];                     // 0 to 5, appended after the pages
  footerLinks: Link[];                       // 0 to 10
  footerText: Inline | null;
  contactEmail: string | null;               // shown on the site; the API's notification inbox is configuration
  donateUrl: string | null;                  // absolute https URL
  analyticsEnabled: boolean;
  logoMedia?: MediaRef | null;               // the site logo image; absent or null means the site keeps its built-in mark
  headerShowsSiteName?: boolean | null;      // absent or null means true: the header shows siteName next to the logo
  headerLinks?: Link[];                      // 0 to 3; prominent links in the site header; absent means none
  landmarks?: Landmark[];                    // 0 to 50; the viewpoints (good spots to watch Santa fly over) the route map and the live tracker draw; absent means none
  places?: {                                 // the places both maps draw; absent means each map's default; no other key is allowed
    tracker?: { kinds: PlaceKind[] };        // the live tracker's Google-supplied place kinds; distinct, 0 to 9; absent means the map style's own places
    routeMap?: { kinds: string[] };          // the route preview's basemap tile place kinds; at most 100; absent means none
  };
  tracker?: {                                // the tracker's defaults; absent means the built-in Missoula valley box; no other key is allowed
    defaultBbox: Bbox;                       // the box a new event takes (1.3 event.trackerBbox); each side 0.05 to 20 degrees
  };
};

type PlaceKind = "attraction" | "business" | "government" | "medical" | "park" | "place_of_worship" | "school" | "sports_complex" | "transit";

type Landmark = {                            // $defs/Landmark in primitives.schema.json; no other key is allowed
  name: string;                              // 1 to 80 characters
  lat: number;                               // [-90, 90]
  lng: number;                               // [-180, 180]
  icon?: Icon;                               // drawn in place of the dot
  description?: string;                      // 1 to 300 characters; opened on tap together with the name
};
```

`headerLinks` holds the prominent links in the site header, up to three, each the `Link` primitive exactly as `footerLinks` uses it (`label`, `href`, `icon`, `newTab`). The site draws them as icon buttons with the label beside the icon on wide screens. The key is optional and validated like `footerLinks` (draft enforces the shape and the three entry ceiling, publish adds the full `Link` rules); the published document carries it only when set, and a reader treats an absent value as empty. The starter content links the flyover's Facebook page (`https://www.facebook.com/WesternMontanaSantaFlyover`) with the library `facebook` icon in a new tab.

`landmarks` is one sitewide list of admin-curated viewpoints (good spots to watch Santa fly over; people see the word Viewpoints everywhere, the key keeps its name), so the `route_preview` map and the live tracker (the `map` section) draw the same places every year. Both draw the dot or badge wherever the layer shows (the tracker from zoom 10) and the name from zoom 12; below that the name is a tooltip on hover or tap, and the overview stays readable: `name` is 1 to 80 characters, `lat` is in [-90, 90], `lng` is in [-180, 180]; the optional `icon` is the shared `Icon`, drawn in place of the dot; the optional `description` is 1 to 300 characters, opened on tap together with the name, and a landmark without one shows only its label. The key is optional and validated like `headerLinks` (draft enforces the shape, the coordinate maximums, and the fifty entry ceiling; publish adds the required keys and the minimums), and publish checks a landmark's icon like every icon: a library id must be in the library and a media id must name a `ready` asset, reported at `/settings/landmarks/<i>/icon/id`. The published document and the snapshot's `content.settings` carry the key only when set, a reader treats an absent value as none, and the snapshot's `media` carries every landmark media icon. The starter content has no landmarks.

`places` is the sitewide choice of the places both maps draw, one list per map: `tracker` for the live tracker (the `map` section) and `routeMap` for the `route_preview` map. The two lists are kept apart because the Google tracker and the OpenStreetMap basemap classify places differently. An absent `places`, `tracker`, or `routeMap` means that map's default: the tracker draws the places its map style draws and the route preview draws none. A present `kinds` shows only those kinds, and an empty list shows none. `tracker.kinds` holds `PlaceKind` values, distinct, 0 to 9, each the Google Maps feature type `poi.<kind>` except `transit`, which is `transit`. `routeMap.kinds` (at most 100) holds basemap tile place kinds, each a lowercase token of 1 to 50 characters matching `^[a-z0-9_]+$`; the panel offers human categories for the route map and stores the kinds. `kinds` is required inside each part, and no other key is allowed in `places` or either part. The key is optional and validated like `headerLinks` (draft enforces the shape and the ceilings; publish adds the required `kinds`); the published document and the snapshot's `content.settings` carry it only when set. The starter content has no places.

`tracker.defaultBbox` is the sitewide default bounding box of the tracker: the box `POST /admin/events` gives a new event that names none (4.5 Events). It is a `Bbox` whose sides are at least 0.05 and at most 20 degrees, validated at both levels (`400 validation_failed` at `/settings/tracker/defaultBbox`); `defaultBbox` is required inside `tracker` and no other key is allowed there. Changing it later changes nothing on existing events. The key is optional: the API uses the published document's value, and the built-in Missoula valley box (west -114.75, south 46.35, east -113.30, north 47.25) when the published document has no `tracker` key. The migration that adds the key seeds it with that box into the settings draft, and it reaches the published document on the next publish like every other setting. The starter content has no `tracker` key.

**Card opacity.** The card's fill can be translucent, per theme, sitewide (`settings.theme.cardOpacityLight` and `cardOpacityDark`) and per section (`presentation.cardOpacityLight` and `cardOpacityDark`). All four are optional integers from 0 (a clear fill) to 100 (an opaque fill); the published document carries them only when set. For the theme in use the site resolves the value in this order: the section's value, then the sitewide value, then 100. The value is the alpha of the card's fill only: the panel colour or the `token` background. A `media` background image is the fill and is unaffected. The border, the shadow, and the content (text, icons, images, controls) stay opaque; only the fill's alpha changes. A section with `card` false has no card, so its opacity values have no effect. The range holds at both validation levels: a write with a value outside 0 to 100 is `400 validation_failed` at the field's path.

`logoMedia` and `headerShowsSiteName` are optional: the published document carries them only when they are not null, and a reader treats an absent or null value as the default. `logoMedia` is a `MediaRef` like any other: publish requires a ready asset, and the snapshot's `media` map carries it. `logo` stays as it is. The hero's `showLogo: true` draws the `logoMedia` image in place of the hero `icon`, sized by the hero's `iconSize`; the pixel size of each size name is the site's (site.md), not the contract's.

**Validation, two levels.** The panel and the API run the same schemas. *Draft* validation, applied to every working-set write, is the kind's schema with `required`, `minLength`, `minItems`, and `minimum` removed at every level: types, enums, and unknown properties are enforced, incompleteness is not, and references are not checked; the card opacity fields keep their 0 to 100 range at this level too. *Publish* validation, applied by `POST /admin/content/publish` and reported by `GET /admin/content/status`, is the full schema plus: every `MediaRef` and media-sourced `Icon` names a media asset with `state = ready`; every library icon id exists; every `Link.href` and inline link matches the href rule; a site path href names an existing, non-hidden page slug; `anchor` values are unique within a page; `map` sections sit only on the `live` page; `settings` satisfies its schema. Problems are reported as `{ path, message }` with `path` a JSON pointer inside the section's `data` or `presentation`, the item's `data`, or the settings.

**Extensibility rules.** A new section or block kind is one schema file, one registry entry, and one component on each side; nothing else changes. New optional fields are added to a schema with a default and need no migration, no republish, and no panel change (forms are generated from the schemas). The primitives are the only shared vocabulary; a kind never invents its own shape for an icon, a link, a media reference, or text. `schemaVersion` on the document changes only when a published document could no longer be read by the previous site; the site treats an unknown value like an unknown snapshot version (1.9).

### 1.3b Media map and icon map

```ts
type MediaEntry = {
  url: string;                               // the uploaded object, absolute CDN URL
  kind: "raster" | "svg" | "gif";
  width: number | null; height: number | null;   // pixels; null for svg
  alt: string;                               // the asset's alt text, may be empty
  variants: { [width: string]: string };     // "480", "960", "1600": absolute CDN URLs of the WebP variants that exist; {} for svg and gif
  dzi: string | null;                        // absolute CDN URL of the Deep Zoom descriptor when a tile pyramid exists, else null
  dark: { url: string; variants: { [width: string]: string } } | null;   // the dark mode version, same rules as url and variants; null when none
  invertInDark: boolean;                     // true: the site inverts the asset's colors in dark mode
  small: {                                   // the small screen version; null when none
    url: string; variants: { [width: string]: string };                   // same rules as url and variants
    dark: { url: string; variants: { [width: string]: string } } | null;  // the small version's own dark version
    invertInDark: boolean;                                                // the small version's own switch
  } | null;
  smallMediaId: string | null;               // the small version's id when small is not null, else null
  credit: string | null;                     // the author or source named under the asset, 1 to 200 characters; null when none
};
```

**Dark mode.** Any asset can carry a dark mode version (another ready asset, `MediaAsset.darkMediaId`) and an "invert in dark mode" switch (`invertInDark`), both off by default. Wherever the site draws an entry in dark mode it draws `dark` in its place when `dark` is not null (with `srcset` from `dark.variants` the same way), otherwise it inverts the image when `invertInDark` is true, otherwise it draws the entry as it is. The dark version's `url` and `variants` are embedded in the entry, so the dark version needs no entry of its own; it is referenced for orphan collection (7.6) while it is a ready asset's dark version. A dark version that is not `ready` is left out (`dark: null`).

**Small screens.** Any asset can carry a small screen version (another ready asset, `MediaAsset.smallMediaId`), off by default. Wherever the site draws an entry under its 760 px cut it draws `small` in its place when `small` is not null (with `srcset` from `small.variants` the same way), otherwise it draws the entry as it is. The small version carries its own dark resolution: in dark mode under the cut the site draws `small.dark` when it is not null, otherwise it inverts the small version when `small.invertInDark` is true, otherwise it draws `small` as it is, so small composes with dark from the one entry with no second lookup. The small version's `url`, `variants`, and dark resolution are embedded in the entry, so the small version needs no entry of its own; it is referenced for orphan collection (7.6) while it is a ready asset's small version. A small version that is not `ready` is left out (`small: null`, `smallMediaId: null`).

**Credit.** Any asset can carry a credit (`MediaAsset.credit`), the author or source of the item, such as the site a photo was taken from; null by default. Wherever the site draws an entry whose `credit` is not null it names the credit under the image as plain text. The credit belongs to the entry itself: a dark or small version drawn in its place shows the entry's credit, not its own.

A variant exists only when the source is a raster image wider than that width; a 700 px upload has `variants: { "480": ... }`. The site renders a `MediaRef` as `<img>` with `srcset` from the variants plus the original at its own width and `sizes` from the section's width; it never constructs a media URL and never inlines SVG. Nothing in v2 overwrites or invalidates a media object.

A tracker theme's thumbnail (`trackerThemes[].thumbnailMediaId`, 1.3) rides in `media` the way a sponsor logo does: the snapshot builder adds the enabled themes' thumbnails to the map, and the site draws the entry's `480` variant on the theme picker. The reference counts for orphan collection (7.6), for `MediaUsage.themes`, and for the media delete impact, so a thumbnail is never stamped unreferenced or deleted under its theme.

**Tile pyramid.** A raster asset whose longest side is 2048 px or more also gets a Deep Zoom pyramid at confirm: `media/{mediaId}/dzi/poster.dzi` (the XML descriptor: tile size 254, overlap 1, format `png`) and `media/{mediaId}/dzi/poster_files/{level}/{col}_{row}.png` down to level 0, lossless PNG (the tiles are the poster's own pixels; the top level is the original at 1:1 and the viewer never zooms past it), every object immutable. A descriptor with `Format="jpg"` belongs to an asset confirmed before the PNG pyramid; the viewer reads the format from the descriptor. `dzi` is the descriptor's absolute CDN URL; the tiles resolve from the descriptor's own directory, as the Deep Zoom format defines. The pyramid lives with the asset: a new poster is a new asset with a new id and new URLs, so a viewer never sees a stale tile; deleting the asset deletes the pyramid with the rest of `media/{mediaId}/`. Smaller rasters have `dzi: null` and a viewer falls back to the original image.

The icon library is a directory of SVG files in the API repository, `icons/<id>.svg`, each with a name and tags in `icons/library.json`. `icons` in the snapshot maps every id to `https://<cdn-domain>/icons/{sha256}.svg`. The library is written to the bucket by the migrating node under the migration lock whenever its hash differs from `icon_library_state.library_sha256`, followed by a snapshot rebuild, so a deploy that adds icons needs no operator action. Uploaded icons are media assets of any kind and render through `<img>` from the media entry.

### 1.4 Flight recording: `routes/{sha256}.json`

A route object is a recording of a flight (or a hand-made point list). It serves two things: Red-Nose replay, exports, and tests read it from this URL; and the tracker's "flight history" toggle draws the recording linked to the current event as a projected route, read from the copy embedded in the snapshot as `event.flightHistory` (1.3), never from this object. The tracker never draws where Santa has been; it shows where he is. The same embedded recording, simplified and smoothed with a 5 minute timeline, is `event.routeMap` (1.3), which `route_preview` draws: the route the public sees on the route page. The object, its endpoints (4.5 Routes), and `event.route_id` are unchanged.

```json
{
  "schemaVersion": 1,
  "name": "2025 flight",
  "points": [
    { "lat": 46.8721, "lng": -114.0012, "recordedAt": "2025-12-22T01:31:07.000Z" },
    { "lat": 46.8730, "lng": -114.0030, "recordedAt": null }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | `int` | `1`; written by the API, absent from the upload body |
| `name` | `string` | required, 1 to 200 |
| `points[]` | `object[]` | required, 2 to 50,000 items (about 3.5 MB minified, under the 5 MB body limit); array order is the route order |
| `points[].lat`, `points[].lng` | `number` | required, finite, in range |
| `points[].recordedAt` | `rfc3339 \| null` | required key; the time label for the point, `null` when unknown |

No other keys anywhere. The stored object is the canonical re-serialization (1.6), not the uploaded bytes. The upload body is `{ name, points }`; the object adds `schemaVersion` first. Upload limit 5 MB; the byte limit is checked first (`413`), then the item count (`400`).

### 1.5 Images

Every image on the site is a media asset or a library icon resolved through `snapshot.media` and `snapshot.icons` (1.3b). The site never constructs image URLs. Uploaded SVGs (a media-sourced icon, a media asset of kind `svg`) render only through `<img>` elements, never inline. Library icons are different: they ship in the site's own bundle as inline SVG components on one drawing rule (24 px grid, 1.5 px stroke and soft tints in `currentColor`, plus fixed red, gold, green, snow, and cocoa fills exposed as `--icon-*` CSS variables with fallbacks), so the strokes take the theme's colour and the fills read the same inline or through `<img>`; `snapshot.icons` remains the source for the admin panel, the API's validation, and any consumer without the bundle. A library id the bundle does not know falls back to `<img>` from `snapshot.icons`. A reference that resolves to nothing (an id missing from the map) renders nothing and logs once.

### 1.6 Canonical JSON and hashing

Every JSON object the API or the migration tool writes to the bucket is produced by one serializer configuration:

- System.Text.Json; `PropertyNamingPolicy = CamelCase`; `WriteIndented = false`; nulls written (`DefaultIgnoreCondition = Never`); the default encoder; properties in the order documented in this section (the DTO declares them in that order); `cookieTally` keys written in ascending numeric order; doubles in shortest round-trippable form; timestamps through the converter in 0.2 (three fractional digits, `Z`); no trailing newline; UTF-8 without BOM.
- `sha256` is computed over exactly those bytes, and exactly those bytes are uploaded.
- The migration tool is a project in the API solution that references the API's DTO types and serializer options, so a route object it writes is byte-identical to what the API would write for the same data.
- No other component ever re-serializes a CDN object for hashing; the site and Red-Nose only parse.
- Two snapshot rebuilds with identical data yield the same key and URL; `version` still increments and the `snapshot` row is rewritten. A route upload whose canonical bytes hash to an existing route's key returns that route (section 4.5).

### 1.7 CDN and bucket configuration

- **Bucket access**: private. Block Public Access fully on; the bucket policy grants `s3:GetObject` only to the CloudFront service principal for this distribution (origin access control, platform.md 1.3). Direct S3 URLs answer `403`. Beacon logs go to Postgres; nothing in the bucket is sensitive, but nothing bypasses the CDN either.
- **Bucket CORS**: one rule for the admin panel's presigned uploads only (media and theme sprite files alike, the same method and headers): origins the admin origins, methods `PUT`, allowed headers `Content-Type`, `x-amz-tagging`, exposed header `ETag`, max age 3600. Every read goes through the distribution and CORS headers for reads come from it (below), never from S3.
- **Lifecycle rules**: expire objects tagged `state=pending` after 1 day and objects tagged `state=orphaned` after 7 days (4.5 Media); abort incomplete multipart uploads after 1 day on every key, tagged or not (`AbortIncompleteMultipartUpload`, the map package uploads of 4.5 Maps). Nothing else expires.
- **Distribution**: allowed methods `GET`, `HEAD` only; no headers, query strings, or cookies in the cache key; cache policy honouring origin `Cache-Control`, min TTL 0, default TTL 1 s, max TTL 31,536,000 s; compression on (gzip and brotli) for `application/json` and `image/svg+xml`; Origin Shield on in the bucket's region; HTTP/2 and HTTP/3 on; error caching minimum TTL 1 s for 403, 404, 500, 502, 503, 504; a response headers policy with CORS `Access-Control-Allow-Origin: *`, allowed methods `GET, HEAD`, allowed headers `*`, max age 3600, override on, plus `X-Content-Type-Options: nosniff`. One cached copy of every object per edge; the live object is cached once per second worldwide.
- **Browser fetch**: default cache mode and `credentials: "omit"` everywhere. The browser revalidates `live/location.json` (`max-age=0`) and CloudFront answers `304` when unchanged. The site never appends query strings to CDN URLs.
- **Uploads**: the admin panel PUTs media bytes, and a theme's four sprite files, straight to the bucket's S3 endpoint with a presigned URL (15 minutes) that fixes the key, the `Content-Type`, and the `x-amz-tagging: state=pending` header; the instance role signs. The tile CLI (`tools/tiles`, platform.md 1.8) writes `maps/{packageKey}/` from an operator's machine through a multipart upload the API starts (`POST /admin/maps`), signs part by part (`POST /admin/maps/{id}/parts`, 64 MB parts, 15 minutes per URL), and completes (`POST /admin/maps/{id}/complete`); the API then verifies the objects (`POST /admin/maps/{id}/confirm`). Nothing else writes to the bucket from outside the fleet.

### 1.8 Who writes the live object, and when

Every write of the live object is one S3 `PutObject` of the whole object and one hub publish of the same bytes. The publish is attempted whether or not the PUT succeeded. On a PUT failure the CDN lags until the next successful PUT while the hub carries the current point; the apply rule (1.2) discards the older polled object. Exactly these triggers write it, and only the node named:

| Trigger | Node | Source of the fields |
|---|---|---|
| A stored location with `published = true` | The node that stored it | The location transaction (7.2) reads the event row it locked and the `snapshot` row, so the object built inside the transaction carries the status and `snapshotUrl` of that moment |
| A committed snapshot-affecting write (including every settings write and every status change) | The node that committed it | Refreshed from SQL after commit |
| The cookie tally moved while the event has status 3 | The leader, once per change, on its reconcile tick (7.4) | Refreshed from SQL on the tick |
| A version change observed on the reconcile tick, by a node that wrote the object for a stored location since the previous version change it observed | That node, once | Refreshed from SQL on the tick (7.4) |
| `POST /admin/live/republish` | The node that took the request | Refreshed from SQL |
| First boot of an environment (no `snapshot` row) | The node that built snapshot version 1 | Refreshed from SQL |

Any other node that observes a version change on the reconcile tick refreshes memory only; it never writes the object and never publishes. The origin is therefore written by the ingest node (every fix, while live, plus one rewrite when it sees a version change) and by the admin node (once per admin write). The site's apply rule (1.2) resolves the same-second overlap for a browser; the ingest node's rewrite corrects the CDN copy when its PUT built before a status change lands after the admin node's PUT.

Writes are coalesced per node: if a write is in flight, the next one waits and then writes whatever is current in memory. On the ingest path a CDN write failure is logged and the beacon's response is still `2xx` (the row is stored; the next update retries the object). On the admin path the PUT is retried three times one second apart; the admin response is sent after commit and does not wait for the live-object write. After every live-object attempt the writing node updates the single `live_state` row (section 5): success sets `last_write_at`, `last_write_seq`, `last_write_version`, `last_write_node` and clears `last_write_error`; a final failure sets `last_write_error`. `GET /admin/live` returns that row fleet-wide, and the panel's dashboard poll surfaces `lastWriteError`. Publishes are best-effort (section 2.6).

### 1.9 The site's data loop

One store, one loop. Nothing else on the site fetches anything.

```ts
type Store = {
  live: LiveObject | null;
  snapshot: Snapshot | null;
  snapshotUrl: string | null;        // the URL store.snapshot was fetched from
  hub: "connecting" | "connected" | "reconnecting" | "disconnected";
                                     // "connected" is set on the `joined` ack for `<service>:location`,
                                     // not when start() resolves; start() resolving leaves it "connecting"
  lastHubLocationAt: number | null;  // performance.now() of the last hub `location` event
  lastSeqChangeAt: number | null;    // performance.now() when an applied object carried a `seq` different
                                     // from the previous one; set on the first apply too
  schemaMismatch: boolean;           // true once an unknown schemaVersion was seen
};
```

Startup:

1. `GET <cdn>/live/location.json`. On failure retry after 1 s, 2 s, 3 s, then every 5 s; render a loading state until the first success.
2. Apply it (below), which fetches `snapshotUrl`.
3. Start the hub connection (section 2.2) and the poll timer.

Apply a live object `L` (from either path):

- If `L.schemaVersion !== 1`: set `schemaMismatch`, show the reload prompt, apply nothing further. The same check applies to a fetched snapshot: `schemaVersion !== 1` sets `schemaMismatch`, shows the reload prompt, and the object is not stored; so does `snapshot.content.schemaVersion !== 1`.
- Discard per the rule in 1.2 (an older event, a lower `seq`, a null `seq` after a non-null one, or an older `publishedAt` on equal `seq`); otherwise `store.live = L`, and when `L.seq` differs from the previous `seq` (or this is the first apply) set `lastSeqChangeAt = performance.now()`.
- If `L.snapshotUrl !== store.snapshotUrl`: fetch it; on success `store.snapshot = S; store.snapshotUrl = L.snapshotUrl`. On failure retry with the same backoff; keep rendering the old snapshot meanwhile.

Poll timer:

- Quiet is defined only while `live.eventStatusId === 3`: `hub !== "connected"`, or `lastHubLocationAt === null`, or `now - lastHubLocationAt > 2 * live.pollIntervalMs`. Outside status 3 the hub is never quiet.
- Cadence is `live.pollIntervalMs` when not quiet; `max(1000, live.pollIntervalMs / 2)` when quiet. Tightened polling applies only while live. Quiet drives the cadence only; what the site shows the visitor about its connection comes from the hub state and the last successful poll (site.md 5.2), never from how often fixes arrive.
- Each tick fetches `live/location.json` and applies it. The timer is re-armed after each fetch completes (no overlapping fetches). A `403`, `404`, `5xx`, or network failure on a poll keeps the current store and waits for the next tick.
- When the document is hidden the site keeps the hub connection and stops polling; on becoming visible it polls immediately and resumes.

Hub `location` event: apply its `data` as a live object and set `lastHubLocationAt`.

Page choice at `/`: `live.eventStatusId` picks the role per the table in 0.5 (`null` is `no_event`) and the site renders the page in `snapshot.content.pages` with that role. The switch happens the moment the live object is applied; until the snapshot named by the new `snapshotUrl` arrives the site keeps rendering the page it has for the new role from the snapshot it holds (the pages rarely change between snapshots; only the event fields do). While `(store.snapshot?.event?.statusId ?? null) !== live.eventStatusId` (the snapshot named by the new `snapshotUrl` is still in flight) the time-shaped elements (`countdown`, liftoff timer, end time) render blank; they fill on the snapshot's arrival. When both are null there are no time-shaped elements.

Live-screen states while status 3: `seq === null` renders the map at its default view and a "waiting for the first fix" marker state. `seq !== null && performance.now() - lastSeqChangeAt > 30000` renders the signal-lost indicator on the marker; the marker stays where it is.

### 1.10 Field map per surface

Content kinds read only their own `data` and `items` plus `snapshot.media` and `snapshot.icons`. Live kinds read as 1.3a lists. The site-coded surfaces:

| Surface | Reads |
|---|---|
| Shell (nav, footer, favicon, snow and lights defaults, the light/dark/system toggle) | `snapshot.content.settings`, `snapshot.content.pages[]` (`navLabel`, `navPosition`, `slug`); the colour scheme is the visitor's own (`localStorage["wmsfo.theme"]`, else the OS) and never comes from the snapshot |
| Page at `/` | the page whose `role` matches `live.eventStatusId` |
| Page at `/<slug>` | the `none` page with that slug; unknown slug renders the not-found page |
| Every inline text | `snapshot.event.name`, `year`, `scheduledAt` for the placeholders |
| Live screen (`map` section) | `live.lat/lng/headingDeg/speedMps/altitudeM/accuracyM/receivedAt/recordedAt/publishedAt`, `snapshot.event.flightHistory`, `snapshot.event.wentLiveAt`, `live.cookieTally` with `snapshot.cookieTypes`, `snapshot.sponsors` with `lingerMs`, `snapshot.event.latestMessage`, `store.hub` and quiet state |
| Alerts landing pages `/alerts/verify`, `/alerts/unsubscribe` | `token` from the query string, then `POST /subscriptions/verify` or `POST /subscriptions/unsubscribe` (section 4.3) |
| `alerts_signup` (signed in) | `GET /me`, `GET /me/subscriptions` (section 4.4) |
| `cookie_control` (signed in, status 3) | `snapshot.cookieTypes`, `GET /me/cookies`, `POST /cookies` |
| `contact_form` | `POST /contact` |
| `/preview` | `GET /preview/document?token=` (4.3) in place of `snapshot.content`, `media`, `icons` |

Leaderboard rendering: for each `snapshot.cookieTypes[]` entry, count is `live.cookieTally[String(id)] ?? 0`; sort by count descending, then `sort`, then `id`; the type's `icon` resolves through `icons` or `media`.

### 1.11 The admin panel's data loop

The admin panel does not use the hub. It reads the API and, on its dashboard, one CDN object.

| View | Fetches on entry | Polls while visible | After a write |
|---|---|---|---|
| Dashboard | `GET /admin/events`, `GET /admin/live`, `GET <cdn>/live/location.json`, `GET /admin/snapshot`, `GET /admin/beacons` | every 5 s: `GET /admin/live`, `GET <cdn>/live/location.json`, `GET /admin/beacons` | refetch all |
| Beacons | `GET /admin/beacons` | every 5 s: `GET /admin/beacons` | refetch |
| Pages, page editor, media library, site settings, publish | their list or detail endpoint; the page editor also `GET /admin/content/kinds` and `GET /admin/icons` once per session | none | the write response is the fresh row; the publish view refetches `GET /admin/content/status` after every working-set write |
| Every other view | its list endpoint | none | refetch the list; the write response is the fresh row |

Polling stops while the document is hidden and resumes with an immediate fetch on visible. Every API fetch carries the current ID token (section 3.1). The CDN fetch of `live/location.json` is a plain GET with `credentials: "omit"`, `cache: "no-store"`, and no custom headers, per 1.7.

Published-state card. The dashboard compares the CDN object with the API: `cdn.eventStatusId` against the current event's `statusId` from `GET /admin/events`; `cdn.snapshotUrl` against `GET /admin/snapshot` `url`; and the freshness of the CDN copy against `GET /admin/live` `lastWriteAt`: the age of `cdn.publishedAt` at the instant the CDN poll landed minus the age of `lastWriteAt` at the instant the API poll landed (the two polls run on independent timers; pairing each server stamp with its own sample instant cancels the browser clock offset and the skew between the polls), a mismatch when that lag exceeds 3 s, which covers the CDN's `s-maxage=1` and the writer's PUT-then-row ordering (1.8). `cdn.seq` is not compared for equality: while a beacon streams, the live object is rewritten several times a second and two separately timed samples agree on `seq` only by chance. A mismatch that persists across two consecutive polls renders red with the text "CDN behind" and a Republish button that calls `POST /admin/live/republish`. `lastWriteError` from `GET /admin/live`, when non-null, renders red with the same button.

Out-of-range colouring on the beacons view, from `Beacon.telemetry`, the row, and `staleAfterS` on the beacons response (constants in `contracts/admin-thresholds.json`, section 13):

| Condition | Threshold |
|---|---|
| Battery low | `health.batteryPercent < 20` (only when the beacon reports it) |
| No recent fix | `health.lastFixAgeS > 30` (only when reported), or `lastLocationAt` older than 30 s while an event is live |
| Socket down | `hubConnected === false`, or `hubConnected === null` and `health.socketState !== "connected"` |
| Stale | `staleSince !== null` |
| Heartbeat old | `lastHeartbeatAt` older than `staleAfterS` |

Everything else a beacon sends rides in its free-form `debug` object (4.2) and is rendered as a JSON tree, never interpreted.

Before sending `POST /admin/events/{id}/status` with `statusId: 3`, the panel shows a confirmation naming the active beacon (or "none"), its heartbeat age, and its stale flag from the beacons list it already holds, and disables the action while no active beacon is healthy; the API enforces the same rule with `409 no_healthy_beacon` (4.5 Events). Before `POST /admin/beacons/{id}/rotate`, `/revoke`, or `/deactivate` on a beacon whose `isActive` is true while any event in `GET /admin/events` has `statusId` 3, the panel shows a confirmation stating that location fan-out stops until another beacon is activated (rotate: or this phone is re-enrolled with the new key). The API does not block on any of it; the admin decides.

---

## 2. Hub

The hub is the gateway's SignalR endpoint `wss://<gateway-domain>/hub`. WebSockets only, negotiation skipped, one client method `ChannelEvent`. The gateway delivers at most once with no replay; every hub event is a hint and the CDN object is the truth the site reconciles against.

Channel names are `<service>:<topic>`. `<service>` is the manifest service name (`wmsfo-api` in prod, `wmsfo-api-dev` in dev). The API reads it from `WMSFO_SERVICE_NAME`; the site reads it from `VITE_HUB_CHANNEL_PREFIX`; Red-Nose reads `ingestChannel` from its enrollment response.

### 2.1 Channels

All channels are private at the gateway level because `realtimeAuthPath` is set; the API's auth callback (2.4) decides per topic, and every client, the site included, handles `channelEvicted` (2.3).

| Channel | Who joins | Join method | Credential | `identity` returned | Events |
|---|---|---|---|---|---|
| `<service>:location` | Public site | `JoinChannel` | none (null) | none | `location` (published by the API) |
| `<service>:event` | Nobody in this version | `JoinChannel` | none | none | reserved; nothing published |
| `<service>:cookies` | Nobody in this version | `JoinChannel` | none | none | reserved; nothing published |
| `<service>:ingest` | Any enrolled beacon (Red-Nose, the simulator beacon, the legacy beacon, or anything else holding a key) | `JoinPrivateChannel(channel, key)` | beacon key | beacon id and key version as `"<id>:<version>"` | nothing published; carries the client message `location` |

Any other topic is denied. The admin panel does not use the hub.

### 2.2 Connecting

Browser (site), `@microsoft/signalr`:

```ts
const connection = new signalR.HubConnectionBuilder()
  .withUrl(HUB_URL, { skipNegotiation: true, transport: signalR.HttpTransportType.WebSockets })
  .withAutomaticReconnect([1000, 2000, 3000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000])
  .build();
connection.keepAliveIntervalInMilliseconds = 15000;
connection.serverTimeoutInMilliseconds = 30000;
```

`withAutomaticReconnect` with a finite array stops retrying after the array is exhausted; the site wraps `start()` in its own loop (1 s, 2 s, 3 s, then every 5 s forever) and treats `onclose` as "start again".

Red-Nose (Kotlin, official Java client):

```kotlin
val connection = HubConnectionBuilder.create(hubUrl)
    .withTransport(TransportEnum.WEBSOCKETS)
    .shouldSkipNegotiate(true)
    .build()
connection.keepAliveInterval = 15000
connection.serverTimeout = 30000
```

The Java client has no automatic reconnect; the service owns the loop (section 9).

Keep-alive alignment: the hub uses the SignalR server defaults (keep-alive ping every 15 s, client timeout 30 s); both clients keep the client defaults above; the load balancer idle timeout stays at or above 60 s.

### 2.3 Client lifecycle

1. Register `on("ChannelEvent", envelope => ...)` once and route on `envelope.channel` and `envelope.event`; register `onreconnected` and `onclose`. Handlers exist before the connection starts, so no envelope is dropped.
2. `start()`.
3. Join: site `invoke("JoinChannel", PREFIX + ":location")`; Red-Nose `invoke("JoinPrivateChannel", ingestChannel, beaconKey)`.
4. Expect the caller-only ack `{ channel, event: "joined", data: { channel } }`. The site uses its arrival to set `hub = "connected"` and turn on the live indicator; it is not an application event.
5. On `onreconnected`: join again (membership dies with the old connection id), then refetch truth: the site fetches `live/location.json` immediately; Red-Nose sends the current fix.
6. `channelEvicted` arrives as `{ channel: <evicted channel>, event: "channelEvicted", data: { channel, reason } }`. On `data.reason === "auth_expired"`: join that channel again (site: `JoinChannel` with no credential; Red-Nose: `JoinPrivateChannel` with the same key), then refetch truth. The gateway's allow for a join lasts about 15 minutes and is never renewed in the background; its sweep, about once a minute, evicts the connection from the channel once the allow has lapsed, and the client's re-join runs the auth callback again. Every client sees this regularly and treats it as routine.
7. On `data.reason === "service_removed"`: keep the connection, retry the join every 5 s.
8. A join that throws because it was denied waits 10 s before the first retry (the gateway caches the deny for about 10 s against the same credential and caps attempts per connection and channel per 10 s window); malformed and budget errors retry with the 1, 2, 3, 5 s backoff. The site keeps polling regardless; a permanently failing join only means the site runs on the CDN at the quiet cadence.
9. `onclose`: mark the hub disconnected (the site switches to the quiet cadence while live), then run the start loop again.

Every client holds exactly one connection and joins each of its channels once. The site ignores every envelope other than `location` on `<service>:location`, `joined`, and `channelEvicted`.

### 2.4 Auth callback (gateway to API)

Manifest `realtimeAuthPath` is `/realtime/authorize`. The gateway POSTs, with a 2 s timeout:

```
POST /realtime/authorize
Content-Type: application/json

{ "channel": "wmsfo-api:ingest", "credential": "wbk_...", "connectionId": "abc123" }
```

`credential` is null when the client used one-argument `JoinChannel`.

Rules, evaluated in this order:

| Condition | Response |
|---|---|
| The request carries `X-Forwarded-For`, `X-Forwarded-Host`, or `X-Forwarded-Proto` (it came through the public proxy, not from the gateway process) | `404`, empty body |
| Body malformed, or `channel` malformed | `200 { "allow": false }` |
| Prefix is not `WMSFO_SERVICE_NAME` | `200 { "allow": false }` |
| Topic `location`, `event`, or `cookies` | `200 { "allow": true }`; credential ignored (null or any string); `identity` omitted; zero I/O |
| Topic `ingest` and `credential` matches the key regex (3.2) and a `beacon` row has `key_hash = sha256(credential)` with `revoked_at is null` and `hub_allowed` true (a beacon with the hub switched off in the panel is denied and sends over HTTP, 9.2; the message path answers `403` for it as well, 2.5) | `200 { "allow": true, "identity": "<beaconId>:<keyVersion>" }` (`beacon.id` and `beacon.key_version`, decimal, colon-separated); stamp `beacon.last_seen_at = now()` |
| Topic `ingest` otherwise | `200 { "allow": false }` |
| Any other topic | `200 { "allow": false }` |

Unknown fields in the callback body are ignored (0.2). The handler answers within 2 seconds; the only I/O is one indexed lookup plus the `last_seen_at` stamp on the ingest branch. The public-topic branch does no I/O, is exempt from the rate limiter, and logs at Debug only, because every site connection re-joins roughly every 15 minutes (100,000 connections produce about 110 callbacks per second in steady state plus join bursts at page-load peaks). The credential is never logged.

### 2.5 Message path (gateway to API)

Manifest `realtimeMessagePath` is `/realtime/message`. Red-Nose sends `invoke("SendToChannel", ingestChannel, "location", payload)`; the gateway POSTs, with a 5 s timeout:

```
POST /realtime/message
Content-Type: application/json

{ "channel": "wmsfo-api:ingest", "event": "location", "data": { ...payload }, "connectionId": "abc123", "identity": "5:2" }
```

Handling, in order:

1. The request carries any `X-Forwarded-*` header: `404`, empty body.
2. `channel` is not exactly `<WMSFO_SERVICE_NAME>:ingest`: `403 forbidden`. This is what stops a public-channel member from sending anything through `SendToChannel("<service>:location", ...)`; the gateway forwards such sends because the message path is set service-wide. This branch is the first check after step 1 and does no I/O; its only bound is the gateway's 10 messages per second per connection. A gateway feature that forwards `SendToChannel` only for channels joined with a credential is on the gateway backlog; it removes this path entirely when it lands.
3. Parse `identity` as `<beaconId>:<keyVersion>`. `identity` null or malformed, the beacon unknown, `revoked_at` set, or `key_version` different from the row: `403 forbidden`. Re-checked on every message so a revoked or rotated key stops at the next message, before the gateway's eviction sweep. Stamp `last_seen_at` only when the check passes.
4. `event === "location"`: validate and store `data` exactly as `POST /locations` (4.2), same fan-out. `200` with the `POST /locations` response body (`{ "seq", "published", "receivedAt", "serverTime", "outcome" }`); `400 validation_failed`; `409 no_live_event`. The rate-limit `dropped` outcome (4.2) is the same body.
5. Any other `event` (including `heartbeat`): `400 validation_failed` (field `event`). Heartbeats travel over HTTP only (4.2).

Unknown fields in the callback body are ignored (0.2). The gateway ignores the response body and looks only at the status; a `2xx` resolves Red-Nose's invoke, and any non-2xx surfaces to Red-Nose as a thrown hub error with no detail, so the bodies in steps 4 and 5 never reach the phone. Red-Nose sends locations over the hub while its socket is up and over HTTP otherwise, and heartbeats over HTTP always (section 9). Rate: a beacon sends at most four locations per second over the hub (`REDNOSE_FIX_INTERVAL_MS`, 8.5), inside the gateway's 10 per second per connection, and at most one per second over HTTP (`REDNOSE_HTTP_FALLBACK_INTERVAL_MS`, 9.2).

### 2.6 Events the API publishes

Every publish is `POST <WMSFO_GATEWAY_INTERNAL_URL>/internal/publish` with header `X-Gateway-Realtime-Token: <GATEWAY_REALTIME_TOKEN>` and body `{ "channel", "event", "payload" }`. Clients receive the envelope `{ channel, event, data }`: `payload` on the publish becomes `data` on the wire.

| Channel | `event` | `payload` | When |
|---|---|---|---|
| `<service>:location` | `location` | The live object (1.2), the same bytes as the CDN write that preceded it | After every live object write, by the node that wrote it (1.8) |

Nothing else is published. Publishes are best-effort: a `429`, a non-2xx, or a network failure is logged and not retried (the CDN write already happened, and the site's poll closes the gap). The publish budget is 50 per second per instance; the API's steady state during an event is about one per second.

### 2.7 Manifest entry

```json
{
  "image": "<account-id>.dkr.ecr.<region>.amazonaws.com/wmsfo-api",
  "tag": "<sha>-prod",
  "port": 5000,
  "desiredStatus": "running",
  "envSecretRef": "<secret-name>",
  "includeInHealth": true,
  "realtimeAuthPath": "/realtime/authorize",
  "realtimeMessagePath": "/realtime/message",
  "realtimeAllowedOrigins": "https://<site-domain>",
  "realtimePresence": false
}
```

Dev (`wmsfo-api-dev`): `tag` is `<sha>-dev`; `realtimeAllowedOrigins` is `https://<preview-site-domain>,http://localhost:5173`. Only the site joins the hub, so only site origins are listed. `realtimePresence` stays false in both environments: presence events would expose beacon connection ids and identities to the public channel's audience. The manifest entry is created once from the dashboard, which also mints the publish token that the gateway injects as `GATEWAY_REALTIME_TOKEN`; CI never sends the realtime fields (the upsert is tri-state and preserves them) and only calls deploy (section 8.2).

---

## 3. Identity and credentials

### 3.1 Cognito

Two pools per environment. The people pool (`wmsfo-dev`, `wmsfo-prod`) carries the `wmsfo-site` client: self sign-up is enabled (the site's own sign-up page creates accounts through the Cognito API, below) and it holds nobody with a role. The admin pool (`wmsfo-admin-dev`, `wmsfo-admin-prod`) carries the `wmsfo-admin` client: self sign-up is off (`AllowAdminCreateUserOnly`), an operator creates every account, and it holds the `admin` and `editor` groups. The API accepts an ID token from either pool but a role counts only on a token the admin pool issued, so a self-created account can never reach `/admin/*`. Both clients are public (no client secret), authorization code grant with PKCE, scopes `openid email profile` (the `wmsfo-admin` client additionally `aws.cognito.signin.user.admin`, used by the panel's in-place TOTP enrolment). Username is the email address; Cognito verifies the email on sign-up.

| Client | Used by | Callback URLs | Sign-out URLs |
|---|---|---|---|
| `wmsfo-site` (`<site-client-id>`, people pool) | Public site | prod: `https://<site-domain>/auth/callback`; dev: `https://<preview-site-domain>/auth/callback`, `http://localhost:5173/auth/callback` | prod: `https://<site-domain>/`; dev: `https://<preview-site-domain>/`, `http://localhost:5173/` |
| `wmsfo-admin` (`<admin-client-id>`, admin pool) | Admin panel | prod: `https://<admin-domain>/auth/callback`; dev: `https://<admin-dev-domain>/auth/callback`, `http://localhost:5174/auth/callback` | prod: `https://<admin-domain>/`; dev: `https://<admin-dev-domain>/`, `http://localhost:5174/` |

Token lifetimes: ID and access tokens 60 minutes; refresh token 30 days on `wmsfo-site`, 1 day on `wmsfo-admin`.

Both pools' MFA setting is optional with TOTP enabled and SMS disabled. The admin pool's three groups: `admin` (name in `WMSFO_ADMIN_GROUP`, value `admin`), `editor` (name in `WMSFO_EDITOR_GROUP`, value `editor`), and `canvasser` (name in `WMSFO_CANVASSER_GROUP`, value `canvasser`: whoever posts stickers; it reaches only the QR codes and places routes of 4.5a and sees only those pages in the panel). Three authorization policies: `Editor` admits `admin` and `editor`, `Admin` admits `admin` only, and `Canvasser` admits `admin`, `editor`, and `canvasser` on the QR codes and places routes of 4.5a (`/admin/qr-codes*` and `/admin/places*`, except the two deletes, which are `Admin`); all three require the token to come from the admin pool; every `/admin/*` endpoint names one (4.5, 4.5a). The API enforces TOTP for both groups: on every `/admin/*` request it calls `AdminGetUser` on the admin pool for the token's `sub` (cached 5 minutes per user) and answers `403 mfa_required` unless `SOFTWARE_TOKEN_MFA` is enabled on the user. This needs `WMSFO_COGNITO_ADMIN_USER_POOL_ID` in the secret and `cognito-idp:AdminGetUser` on the admin pool for the instance role.

**Token used on every surface: the ID token.** The site and the admin panel send `Authorization: Bearer <id-token>` to the API. The API validates:

| Check | Value |
|---|---|
| Signature | JWKS at `https://cognito-idp.<region>.amazonaws.com/<pool-id>/.well-known/jwks.json` of the pool the token names, cached, refreshed on an unknown `kid` |
| `iss` | `WMSFO_COGNITO_ISSUER` (the people pool) or `WMSFO_COGNITO_ADMIN_ISSUER` (the admin pool), each `https://cognito-idp.<region>.amazonaws.com/<pool-id>`; the API picks the scheme by the token's `iss` and stamps the principal with the pool it came from |
| `aud` | One of `WMSFO_COGNITO_CLIENT_IDS` for the people pool, one of `WMSFO_COGNITO_ADMIN_CLIENT_IDS` for the admin pool |
| `token_use` | `"id"` |
| `exp` | Not expired, 60 s leeway |

Claims the API reads: `sub` (person identity, stored as `person.cognito_sub`), `email` (stored as `person.email`; used as the `created_by`, `changed_by`, `updated_by`, `hidden_by`, `uploaded_by` audit text), `cognito:groups` (array; `"admin"` present means admin, `"editor"` present means editor).

Person rows are upserted on every authenticated request:

```sql
insert into person (cognito_sub, email) values ($sub, $email)
on conflict (cognito_sub) do update set email = excluded.email, last_seen_at = now()
returning id;
```

Authorization: an `/admin/*` route under the `Admin` policy requires `cognito:groups` to contain `admin`; one under `Editor` requires `admin` or `editor`; one under `Canvasser` (4.5a) requires `admin`, `editor`, or `canvasser`; otherwise `403 forbidden`.

The admin panel uses `oidc-client-ts` against the admin pool's managed login:

```ts
const userManager = new UserManager({
  authority: COGNITO_AUTHORITY,          // https://cognito-idp.<region>.amazonaws.com/<admin-pool-id>
  client_id: CLIENT_ID,
  redirect_uri: `${window.location.origin}/auth/callback`,
  response_type: "code",
  scope: "openid email profile",
  automaticSilentRenew: true,
});
```

The ID token is re-read from the user manager before every API call. Sign-out: Cognito's discovery document has no `end_session_endpoint`, so sign-out is `await userManager.removeUser()` followed by navigation to `${COGNITO_DOMAIN}/logout?client_id=${CLIENT_ID}&logout_uri=${encodeURIComponent(SIGN_OUT_URL)}`, where `SIGN_OUT_URL` is the registered sign-out URL for the current origin. Hosted UI endpoints in use on the admin pool's `<cognito-domain>`: `/oauth2/authorize`, `/oauth2/token`, `/logout`.

**The public site never shows a Cognito page.** Its sign-up, confirmation, sign-in, and password-reset pages are its own (site.md 11), themed like the rest of the site, and talk to the people pool through the Cognito Identity Provider API with `amazon-cognito-identity-js`: `SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `InitiateAuth` with `USER_SRP_AUTH` (the password never leaves the browser in clear), `ForgotPassword`, `ConfirmForgotPassword`, and `REFRESH_TOKEN_AUTH` for renewal. The `wmsfo-site` client therefore needs `ALLOW_USER_SRP_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` (both already on) and no hosted UI, callback URL, or managed login page; its ID token is the same bearer as before. Sign-out is local (the site forgets its tokens and revokes the refresh token through `RevokeToken`). The people pool's hosted UI domain stays only because Cognito requires one on the pool; nothing links to it.

The admin panel, after sign-in, checks `cognito:groups` on the ID token, shows only the views the caller's group allows, and shows a "this account has no role" page with a sign-out button when neither group is present. Beacons never use Cognito; the simulator beacon's control page signs its operator in through the admin pool like the panel (9.5).

### 3.2 Beacon keys

| Item | Value |
|---|---|
| Format | `wbk_` followed by 43 characters of unpadded URL-safe base64 (32 random bytes from a CSPRNG). 47 characters total. Regex `^wbk_[A-Za-z0-9_-]{43}$`. |
| Header | `X-Beacon-Key: <key>` on every beacon REST call. |
| Hub | The raw key is the second argument of `JoinPrivateChannel(ingestChannel, key)`. |
| At rest | `beacon.key_hash = sha256(key)` (32 bytes, unique index) plus `beacon.key_prefix` = the first 12 characters for display. Lookup is by hash; keys are never logged. |
| Shown | Once, in the create and rotate responses. Never retrievable afterwards. |
| Roles | None. Every beacon is the same kind of thing: a key that may post locations, heartbeats, and logs. What a beacon shows on its own screen (Red-Nose's debug mode, the simulator's control page) is the beacon's business, never the API's. |

### 3.3 Enrollment

Every key mint (create or rotate) also mints one enrollment token so the phone can fetch the same key by scanning a QR code.

| Item | Value |
|---|---|
| Token format | `wet_` followed by 43 URL-safe base64 characters (32 random bytes). Regex `^wet_[A-Za-z0-9_-]{43}$`. |
| Lifetime | 15 minutes from mint. Single use. A phone enrolled later needs a rotate. |
| At rest | `beacon_enrollment_token.token_hash = sha256(token)`; `key_ciphertext` = AES-256-GCM of the plaintext key under `WMSFO_ENROLLMENT_ENCRYPTION_KEY` (12-byte nonce prepended, 16-byte tag appended). On use the row gets `consumed_at` and `key_ciphertext` is nulled; pending rows are deleted on the beacon's next rotate or revoke; the nightly chore deletes rows expired or consumed more than 24 h ago. |
| QR payload | The enrollment URL as text: `rednose://enroll?api=<url-encoded api base url>&token=<token>`. Example: `rednose://enroll?api=https%3A%2F%2F<api-domain>&token=wet_...`. The API builds it from `WMSFO_PUBLIC_API_BASE_URL`. |
| Rendering | The API returns the URL and a PNG rendering of it as a data URL (`qrPngDataUrl`) in the `Enrollment` object; the panel shows the PNG. |
| Exchange | `POST /beacons/enroll` (4.2). The response carries `beaconId`, `name`, `key`, `apiBaseUrl`, `hubUrl`, `ingestChannel`, `serverTime`. |
| Red-Nose handling | An intent filter on scheme `red-nose`, host `enroll`, so both the in-app scanner and the system camera land in the app. The app parses `api` and `token`, calls the exchange, and stores the fields in section 8.5 in Keystore-backed `EncryptedSharedPreferences`. |
| Manual path | The enrollment screen has fields for the API base URL (prefilled from the build flavour) and the key. Red-Nose verifies by calling `GET /beacons/me` and stores the same fields from that response. |

### 3.4 Revoke, rotate, activate, deactivate

- **Revoke** (`POST /admin/beacons/{id}/revoke`): sets `revoked_at`, clears `is_active`, deletes pending enrollment tokens. Effects: `X-Beacon-Key` calls answer `401 unauthenticated` immediately; hub joins are denied at the next callback; messages on an existing connection are rejected with `403` at the message path, so no update from a revoked key is stored; the gateway evicts the connection from the channel when its 15-minute allow lapses and the next sweep runs (up to about 16 minutes after the last join), and until then the message path's `403` is what stops it. Revocation is permanent; the row stays for history and export. Idempotent.
- **Rotate** (`POST /admin/beacons/{id}/rotate`): mints a new key and enrollment token, replaces `key_hash` and `key_prefix`, increments `key_version`, deletes pending tokens. The old key stops working immediately with the same effects as revoke for it: `X-Beacon-Key` calls with it answer `401`, joins with it are denied, and messages on a connection that joined with it carry the old `key_version` in `identity` and are rejected with `403` at the message path (2.5). `is_active` is unchanged. The response shows the new key once. `409 beacon_revoked` on a revoked beacon.
- **Activate** (`POST /admin/beacons/{id}/activate`): clears `is_active` on every other row, then sets this beacon's `is_active = true`, in that order in one transaction (the partial unique index is checked per statement). `409 beacon_revoked` on a revoked beacon. Takes effect on the next stored update (the location transaction reads `is_active`, 7.2).
- **Deactivate** (`POST /admin/beacons/{id}/deactivate`): clears `is_active`. Zero active beacons means nothing fans out until another is activated. Idempotent.

### 3.6 API keys

An API key lets a script or an agent (Claude Code configuring the site, a posting bot) call the admin surface without Cognito. Modeled on the portfolio's machine keys, with two additions: a key carries a capability set, and a key can expire.

| Item | Value |
|---|---|
| Format | `wak_` followed by 43 characters of unpadded URL-safe base64 (32 random bytes from a CSPRNG). 47 characters total. Regex `^wak_[A-Za-z0-9_-]{43}$`. |
| Header | `Authorization: Bearer <key>`; the `wak_` prefix tells it apart from an ID token. A request carrying `X-Beacon-Key` as well is `400 validation_failed`. |
| At rest | `api_key.key_hash = sha256(key)` (unique index) plus `api_key.key_prefix` = the first 12 characters for display. Lookup is by hash; keys are never logged. |
| Shown | Once, in the mint response. Never retrievable afterwards. |
| Capabilities | `api_key.all_capabilities = true`, or `api_key.capabilities` = a non-empty subset of the capability list below. `all_capabilities` covers capabilities added after the key was minted. |
| Expiry | `api_key.expires_at` null (never) or an rfc3339 instant at least one hour after mint. Past it the key answers `401 unauthenticated`, same as revoked. |
| Minting | `POST /admin/api-keys`, Cognito `Admin` policy only (TOTP applies). A key can never mint, list, or revoke keys. |
| Acting as | Requests carry no `email`; audit columns record `key:<name>`. No `person` row is upserted. The TOTP gate does not apply to keys. |
| Rate limit | The `/admin/*` bucket is keyed by key id instead of person id. |

Capabilities, one per endpoint group of 4.5, each named after its heading (Posters rides `events`), 21 in all: `events`, `routes`, `maps`, `themes`, `beacons`, `sponsors`, `cookie_types`, `pages`, `sections`, `site_settings`, `content`, `media`, `icons`, `settings`, `contact_messages`, `subscribers`, `people`, `diagnostics`, `audit`, `qr`, `help`. Every `/admin/*` endpoint except the API-key endpoints names its capability in the endpoint metadata; a key request whose key lacks it is `403 forbidden`. A key with a capability reaches every endpoint in that group regardless of the group's Cognito policy (a key with `events` can change status; a key with `sponsors` can pin sponsors).

### 3.5 Protecting the callback endpoints

`/realtime/authorize` and `/realtime/message` are ordinary routes on the container port, so the public proxy would forward `https://<api-domain>/realtime/message` to them. The gateway's own callback client attaches no credential. Proxied requests always carry `X-Forwarded-For` (added by the load balancer and by the proxy); the gateway's direct callbacks never do. The API therefore answers `404` with an empty body to any request on these two paths that carries `X-Forwarded-For`, `X-Forwarded-Host`, or `X-Forwarded-Proto`, and processes the rest. Before the event an operator confirms whether the gateway already refuses these two paths on its public listener; a gateway feature that attaches `X-Gateway-Realtime-Token` on its callbacks is on the gateway backlog, and when it lands the API switches to comparing that header.

---

## 4. REST API

### 4.0 Common

| Item | Value |
|---|---|
| Content type | Requests with a body send `Content-Type: application/json` unless marked multipart or text. Responses are `application/json; charset=utf-8`. |
| Body limits | 64 KB for JSON, 256 KB for section, item, and site settings bodies, 5 MB for route uploads, 2 MB for beacon logs, 8 KB for heartbeats. Media bytes never pass through the API (presigned upload, 4.5 Media): 20 MB for raster and GIF, 1 MB for SVG, checked at confirm. Over the limit: `413 payload_too_large`. |
| Auth headers | `X-Beacon-Key` (beacon), `Authorization: Bearer <id-token>` (person, admin), `Authorization: Bearer wak_…` (API key, 3.6). A request that carries `X-Beacon-Key` and `Authorization` is `400 validation_failed`. |
| Common errors | `400 validation_failed`, `401 unauthenticated`, `403 forbidden`, `404 not_found`, `405` (no body), `413 payload_too_large`, `415 unsupported_media_type`, `429 rate_limited`, `500 internal_error`, `502 upstream_failed`. Listed per endpoint only when the endpoint adds a code. |
| CORS | The API answers CORS for the exact origins in `WMSFO_CORS_ORIGINS`: methods `GET, POST, PUT, PATCH, DELETE`, headers `Authorization, Content-Type, X-Beacon-Key, X-App-Version, If-None-Match`, exposed response header `ETag`, `Access-Control-Max-Age: 600`, no credentials. Red-Nose is not a browser and needs none. |
| Client IP | Taken from `X-Forwarded-For` counting `WMSFO_TRUSTED_PROXY_HOPS` (default 2: the load balancer and the gateway proxy) entries from the right. Used for rate limiting and contact-message records only. |
| `serverTime` | Every `2xx` response to a beacon endpoint carries `serverTime` (rfc3339), stamped when the response body is serialized, after any transaction has committed. Red-Nose uses it for clock skew (section 9). |
| Rate limits | Token buckets, per node (not fleet-wide), keyed as shown. Over budget: `429` with `Retry-After` and `details.retryAfterSeconds`. The callback paths and `/api/health` are exempt. |

| Endpoint | Key | Rate | Burst |
|---|---|---|---|
| `POST /locations` | beacon id | 10/s | 20 |
| `POST /beacons/heartbeat` | beacon id | 1/s | 5 |
| `POST /beacons/logs` | beacon id | 1/min | 2 |
| `POST /beacons/enroll` | client IP | 10/min | 10 |
| `GET /beacons/me` | beacon id | 1/s | 5 |
| `POST /contact` | client IP | 5/hour | 5 |
| `POST /subscriptions/verify`, `POST /subscriptions/unsubscribe` | client IP | 30/min | 30 |
| `POST /cookies` | person id | 1/s | 3 |
| `POST /me/subscriptions`, `.../resend-verification` | person id | 5/hour | 5 |
| `GET /preview/document` | client IP | 240/min | 60 |
| `POST /admin/media/upload-url` | person id | 30/min | 30 |
| `/admin/*` | person id, or API key id | 20/s | 40 |

Shared resource shapes (all camelCase, all timestamps rfc3339). Column-to-wire mapping is mechanical snake_case to camelCase; the only non-mechanical names are `contact_message.body` (request field `message`), `beacon.key_prefix` (`keyPrefix`), and `media_asset.s3_key` and `variants` (exposed as absolute CDN URLs `url` and `variants`).

```ts
type AuditStamp = { action: string; by: string; at: string };
type ImpactGroup = { entity: string; count: number; names: string[] };   // names: up to ten, in id order
type DeleteImpact = { blocked: string | null; deletes: ImpactGroup[]; unlinks: ImpactGroup[]; warnings: string[] };   // blocked: the sentence explaining why the delete is refused (the live or current event), else null
type AuditEntry = { id: number; at: string; actor: string; action: string; entity: string; entityId: string; before: object | null; after: object | null; requestId: string | null };
type AlertItem = { id: number; subscriptionId: number; address: string; kind: "event_status" | "event_message"; eventId: number; eventName: string; statusId: number | null; messageId: number | null; subject: string; message: string | null; sentAt: string };   // messageId: the message a message alert announced, or the event message a status alert carried (null when it carried none); message: the body of that message, null when there is none or it was deleted
type Event = {
  id: number; year: number; name: string; statusId: number; isCurrent: boolean;
  scheduledAt: string | null; wentLiveAt: string | null; endedAt: string | null;
  scheduleTimeZone: string | null;   // admin only: the IANA zone id (e.g. America/Denver) scheduledAt was entered in; null means unset
  fundsPercent: number; routeId: number | null; routeUrl: string | null;
  routeMapConfig: RouteMapConfig | null;   // the event's route map configuration (1.3): display and controls, no landmarks or places (those are settings.landmarks and settings.places); null means every built-in default
  trackerBbox: Bbox;                 // the event's bounding box (1.3 event.trackerBbox), always set
  trackerMapId: number | null;       // the ready tracker map whose package contains trackerBbox (4.5 Maps); null means Google Maps for every viewer
  trackerThemeIds: number[];         // the enabled themes in sortOrder, id order (1.3 trackerThemes); at least one google theme
  statusNotifiedAt: string | null;   // when the current status was last announced to subscribers (a status change with notify, or POST .../notify); null since the last change otherwise
  createdBy: string; createdAt: string; updatedAt: string; audit: AuditStamp | null;
};
type EventMessage = { id: number; eventId: number; body: string; createdBy: string; createdAt: string; updatedAt: string; notify: boolean; sentCount: number; audit: AuditStamp | null };   // createdAt: the time the message was sent, its only time; notify: posted with notify true from the message form (false for the message a status change or an announcement posts; that alert counts on its StatusHistory row); sentCount: alert emails sent for this message so far, kept on the row
type StatusHistory = { id: number; eventId: number; fromStatusId: number | null; toStatusId: number; changedBy: string; changedAt: string; notify: boolean; message: string | null; messageId: number | null; sentCount: number };   // message: the body of the event message posted with the change (null when none was given or it was deleted); messageId: that message's id, null likewise; sentCount: alert emails sent for this change so far, kept on the row
type Route = { id: number; name: string; url: string; s3Key: string; sha256: string; pointCount: number; uploadedBy: string; createdAt: string; audit: AuditStamp | null };
type PosterSummary = { id: number; name: string; routeId: number | null; updatedAt: string };   // one row of GET /admin/posters
type Poster = {
  id: number; name: string;
  routeId: number | null;            // the flight recording the poster's map is built from (GET /admin/routes/{id}/route-map); null when unlinked
  layout: object | null;             // the panel's poster composer layout, opaque to the API, in canonical form (4.5 Posters); null means unset
  createdBy: string; createdAt: string; updatedAt: string; audit: AuditStamp | null;
};
type TrackerMap = {
  id: number; name: string;
  packageKey: string;                // sha256 of the canonical { bbox, minZoom, maxZoom, terrainMaxZoom } (1.1); the seeded map's is computed the same way
  prefix: string;                    // maps/{packageKey}, or basemap for the seeded map
  bbox: Bbox; minZoom: number; maxZoom: number; terrainMaxZoom: number | null;   // terrainMaxZoom null: no terrain archive
  tilesBytes: number | null; terrainBytes: number | null;   // recorded at confirm; null while pending
  sourceBuild: string | null;        // the basemap build date the vector tiles came from, YYYY-MM-DD
  state: "pending" | "ready"; builtAt: string | null;
  tilesUrl: string; terrainUrl: string | null;   // the absolute CDN URLs the snapshot carries (1.3 event.trackerMap)
  eventCount: number;                // events whose map it is
  createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; audit: AuditStamp | null;
};
type TrackerMapUpload = { id: number; packageKey: string; uploads: { tiles: { uploadId: string }; terrain: { uploadId: string } | null } };   // POST /admin/maps
type TrackerMapParts = { file: "tiles" | "terrain"; parts: { partNumber: number; url: string }[]; expiresAt: string };   // POST /admin/maps/{id}/parts
type Chrome = { bg: string; fg: string; text: string; tile: string; tileFg: string; panel: string; accent: string };   // #rrggbb or #rrggbbaa each (1.3)
type Overlay = { routeColor: string; routeOpacity: number; arrowColor: string; timeLabelBg: string; timeLabelFg: string; timeLabelOpacity: number; userColor: string };   // colours as Chrome, opacities 0 to 1 (1.3)
type TrackerTheme = {
  id: number; renderer: "google" | "maplibre"; key: string; name: string; sortOrder: number;
  styleUrl: string; styleSha256: string; styleBytes: number;   // the style body on the CDN (1.1 themes/{sha256}.json) and its canonical size
  spriteSha256: string | null; spriteUrl: string | null;   // the confirmed sprite set's index hash and its sprite base (1.3); both null until a sprite confirm passed
  chrome: Chrome; overlay: Overlay; thumbnailMediaId: string | null;
  defaultLightMode: boolean; defaultDarkMode: boolean;
  eventCount: number;                // events that enable it
  createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; audit: AuditStamp | null;
};
type SpriteTickets = { indexSha256: string; uploads: { file: "sprite.json" | "sprite.png" | "sprite@2x.json" | "sprite@2x.png"; uploadUrl: string; method: "PUT"; headers: { [name: string]: string }; expiresAt: string }[] };   // POST /admin/themes/{id}/sprite
type HelpLink = { label: string; to: string };   // to: a path of the admin panel ("/events") or an https:// URL
type HelpTopic = {
  key: string; page: string; label: string;   // from help/topics.json; key is dotted lower-case segments (page, page.card, page.dialog)
  title: string; body: string; links: HelpLink[];   // the text shown: the seed's until an admin edits it
  edited: boolean;                   // true while an admin's text replaces the seed's
  editedBy: string | null; editedAt: string | null;   // the last edit's actor (email or key:<name>) and time; null while not edited
  defaultChanged: boolean;           // edited, and the seed's text changed after the edit (a reset would show the new text)
  updatedAt: string; audit: AuditStamp | null;
};
type Beacon = {
  id: number; name: string; notes: string; keyPrefix: string; isActive: boolean;
  revokedAt: string | null; lastSeenAt: string | null; lastLocationAt: string | null; lastHeartbeatAt: string | null;
  staleSince: string | null; telemetry: Heartbeat | null; hubConnected: boolean | null; healthy: boolean;
  minIntervalMs: number | null;                 // per-beacon override of location_min_interval_ms; null means the setting
  hubAllowed: boolean;                          // false: the authorize callback denies this beacon's join and it sends over HTTP (2.4)
  fixesStored: number; fixesCarried: number; fixesRateLimited: number;
  createdBy: string; createdAt: string; updatedAt: string;
  audit: AuditStamp | null;
};
  // healthy: not revoked and not stale (4.5 Events, the go-live rule); computed by the API from the same rows the chore reads
type Enrollment = { token: string; url: string; qrPngDataUrl: string; expiresAt: string };
type BeaconLog = { id: number; receivedAt: string; appVersion: string | null; sizeBytes: number };
type Sponsor = {
  id: number; name: string; contactPerson: string | null; email: string | null; phone: string | null; address: string | null;
  websiteUrl: string | null; fbUrl: string | null; igUrl: string | null;
  logoMediaId: string | null; logo: MediaAsset | null; years: SponsorYear[]; createdAt: string; updatedAt: string;
  audit: AuditStamp | null;
};
type SponsorYear = { eventYear: number; amountDonated: number | null; active: boolean; canAdvertise: boolean; anonymous: boolean; pinnedPosition: number | null; lingerMsOverride: number | null; lingerMs: number; registeredAt: string };
                    // lingerMs is the value the snapshot would carry (1.3), computed by the API for the panel to show
type ApiKeyCapability = "events" | "routes" | "maps" | "themes" | "beacons" | "sponsors" | "cookie_types" | "pages" | "sections" | "site_settings" | "content" | "media" | "icons" | "settings" | "contact_messages" | "subscribers" | "people" | "diagnostics" | "audit" | "qr" | "help";
type ApiKey = { id: number; name: string; keyPrefix: string; allCapabilities: boolean; capabilities: ApiKeyCapability[]; expiresAt: string | null; createdBy: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; audit: AuditStamp | null };
type ApiKeyMinted = ApiKey & { key: string };   // the only response that ever carries the full key
type CookieType = { id: number; name: string; icon: Icon | null; sort: number; active: boolean; cookieCount: number; createdAt: string; updatedAt: string; audit: AuditStamp | null };
  // cookieCount: cookies of this type across every event; deleting the type deletes that many cookies (4.5 Cookie types)
type Subscription = { id: number; channel: "email"; address: string; verifiedAt: string | null; unsubscribedAt: string | null; createdAt: string };
type SubscriberAdmin = Subscription & { personId: number; personEmail: string; audit: AuditStamp | null };
type Person = { id: number; email: string; createdAt: string; lastSeenAt: string; audit: AuditStamp | null };
type ContactMessage = { id: number; name: string; email: string; body: string; clientIp: string; createdAt: string; audit: AuditStamp | null };
type Setting = { key: string; value: unknown; updatedBy: string | null; updatedAt: string | null; audit: AuditStamp | null };
type SnapshotInfo = { version: number; url: string; s3Key: string; builtAt: string };
type LocationRow = { seq: number; beaconId: number; published: boolean; recordedAt: string; receivedAt: string; lat: number; lng: number; speedMps: number | null; speedSource: "beacon" | "derived" | null; altitudeM: number | null; headingDeg: number | null; accuracyM: number | null };
type Heartbeat = { /* the body of POST /beacons/heartbeat, section 4.2 */ };
type Page<T> = { items: T[]; nextCursor: string | null };

// Content (1.3a), media (1.3b), icons
type Problem = { path: string; message: string };                       // JSON pointer within the object validated
type PageAdmin = { id: number; slug: string; title: string; navLabel: string | null; icon: Icon | null; navPosition: number; isHidden: boolean; role: PageRole; sectionCount: number; problemCount: number; createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; audit: AuditStamp | null };
type SectionItemAdmin = { id: number; sectionId: number; position: number; isHidden: boolean; data: object; problems: Problem[]; updatedBy: string; updatedAt: string; audit: AuditStamp | null };
type SectionAdmin = { id: number; pageId: number; kind: string; position: number; isHidden: boolean; data: object; presentation: Presentation; items: SectionItemAdmin[]; problems: Problem[]; updatedBy: string; updatedAt: string; audit: AuditStamp | null };
type PageDetail = PageAdmin & { sections: SectionAdmin[] };
type SiteSettingsDraft = { data: Partial<SiteSettings>; problems: Problem[]; updatedBy: string | null; updatedAt: string | null };
type KindInfo = { kind: string; title: string; description: string; live: boolean; hasItems: boolean; allowedRoles: PageRole[] | null; schema: object; itemSchema: object | null; defaults: object; itemDefaults: object | null };
type IconInfo = { id: string; name: string; tags: string[]; url: string };
type MediaAsset = {
  id: string; filename: string; contentType: string; kind: "raster" | "svg" | "gif"; state: "pending" | "ready" | "orphaned";
  sizeBytes: number | null; width: number | null; height: number | null; sha256: string | null; alt: string; title: string;
  url: string; variants: { [width: string]: string }; dziUrl: string | null; darkMediaId: string | null; invertInDark: boolean; smallMediaId: string | null;
  credit: string | null;
  uploadedBy: string; createdAt: string; confirmedAt: string | null;
  unreferencedSince: string | null; orphanedAt: string | null;
  audit: AuditStamp | null;
};
  // dziUrl: absolute CDN URL of the Deep Zoom descriptor when the asset has a tile pyramid (1.3b), else null
  // darkMediaId: the asset drawn in this one's place in dark mode (1.3b), else null; invertInDark: false by default
  // smallMediaId: the asset drawn in this one's place on small screens (1.3b), else null
  // credit: the author or source named under the asset (1.3b), 1 to 200 characters, else null
type UploadTicket = { media: MediaAsset; uploadUrl: string; method: "PUT"; headers: { [name: string]: string }; expiresAt: string };
type MediaUsage = { draftPages: { id: number; slug: string; title: string }[]; versionCount: number; sponsors: { id: number; name: string }[]; cookieTypes: { id: number; name: string }[]; themes: { id: number; name: string }[]; siteSettings: boolean; darkVersionOf: { id: string; filename: string }[] };   // themes: the tracker themes whose thumbnail it is
type ContentVersionInfo = { id: number; sha256: string; label: string | null; publishedBy: string; publishedAt: string; pageCount: number; sectionCount: number; audit: AuditStamp | null };
type ProblemRef = Problem & { pageId: number | null; sectionId: number | null; itemId: number | null };   // all null: site settings
type ContentStatus = { published: ContentVersionInfo | null; draftSha256: string; hasUnpublishedChanges: boolean; problems: ProblemRef[]; draftUpdatedAt: string | null };
type ContentBundle = { content: ContentDocument; media: { [id: string]: MediaEntry }; icons: { [id: string]: string } };
type PreviewToken = { token: string; url: string; expiresAt: string; audit: AuditStamp | null };
```

List endpoints that page use `?limit=` (default 50, max 500) and `?cursor=` (opaque, from `nextCursor`). Lists without `nextCursor` in their response are unpaged.

### 4.1 Health

**`GET /api/health`**. No auth. The gateway's health prober and its blue-green candidate check issue `GET {base}/api/health`; this is why the path carries the `/api` prefix. `200 { "status": "ok" }` when migrations have completed, the node's cache has loaded, and `select 1` answers within 2 s; otherwise `503` with the error shape and `code: "unavailable"`. No other data, `Cache-Control: no-store`. Reachable through the proxy. A node still applying migrations under the advisory lock answers `503`. During a blue-green replacement the gateway keeps the old container serving until the new one answers `200`; on a first create there is no old container and requests reaching the node answer `503` until migrations finish (clients retry).

### 4.2 Beacon endpoints

**`POST /beacons/enroll`**. No auth header; the token is the credential.

```json
{ "token": "wet_..." }
```

`200`:

```json
{
  "beaconId": 5, "name": "Helicopter phone",
  "key": "wbk_...", "apiBaseUrl": "https://<api-domain>", "hubUrl": "wss://<gateway-domain>/hub",
  "ingestChannel": "wmsfo-api:ingest",
  "serverTime": "2026-12-01T18:00:00.000Z"
}
```

Errors: `400 validation_failed` (format), `404 enrollment_token_invalid` (unknown, used, expired, or the beacon is revoked). Idempotency: none; the token is consumed on the first success in the same transaction. Not retryable after success.

**`GET /beacons/me`**. `X-Beacon-Key`. `200 { "beaconId", "name", "isActive", "apiBaseUrl", "hubUrl", "ingestChannel", "liveEventId", "serverTime" }` (`liveEventId` is `int64 | null`). Stamps `last_seen_at`. Errors: `401 unauthenticated` (unknown or revoked key).

**`POST /locations`**. `X-Beacon-Key`.

```json
{ "lat": 46.87, "lng": -114.0, "recordedAt": "2026-12-22T01:31:07Z",
  "speedMps": 31.2, "altitudeM": 1210, "headingDeg": 84, "accuracyM": 6 }
```

| Field | Type | Rule |
|---|---|---|
| `lat` | `number` | required, -90 to 90 |
| `lng` | `number` | required, -180 to 180 |
| `recordedAt` | `rfc3339` | required, parseable; no plausibility check |
| `speedMps` | `number \| null` | optional, 0 to 500 |
| `altitudeM` | `number \| null` | optional, -500 to 20000 |
| `headingDeg` | `number \| null` | optional, 0 to 360 |
| `accuracyM` | `number \| null` | optional, 0 to 100000 |

Handling: resolve the beacon (`401` if unknown or revoked); apply the per-beacon min-interval rate limit and the min-distance decision in the location transaction (7.2). The response is the `outcome`: `stored` (a `location` row was written), `carried` (no row; `seq` advanced anyway and the live object is written from the incoming fields, either because the min-distance filter decided to carry, or because the position already exists somewhere in the event and the unique `(event_id, lat, lng)` index sent the insert to `do nothing`), or `dropped` (the fix arrived inside the beacon's effective min interval on this node; no transaction, no live object, no publish; `seq` is the last seq this node accepted from that beacon or 0). A position is stored at most once per event, so a replayed flight loops without growing the recording. The `location_min_interval_ms` filter is per node: a beacon's socket is pinned to one node and HTTP may spread across the fleet, so the fleet-wide bound is at most `<nodes>` times the setting; the gateway's 10 per second per connection stays the outer bound on the hub. The per-endpoint rate limit table row for `POST /locations` notes the per-beacon interval (10 per second, minus the drops for the interval).

`201`:

```json
{ "seq": 1832, "published": true, "receivedAt": "...", "serverTime": "...", "outcome": "stored" }
```

Errors: `400 validation_failed`, `401 unauthenticated`, `409 no_live_event`, `429 rate_limited`. Idempotency: none. A retry after a lost response creates a second row with a higher `seq`; harmless. Beacons ignore the `outcome` key.

**`POST /beacons/heartbeat`**. `X-Beacon-Key`. HTTP only, every 15 s, whether or not the socket is up; its answer is the only source of `liveEventId`, `isActive`, and the clock skew on the beacon.

```json
{
  "sentAt": "2026-12-22T01:31:07.000Z",
  "health": { "batteryPercent": 87, "lastFixAgeS": 1, "socketState": "connected" },
  "debug":  { "anything": "the beacon wants to show", "nested": { "as": ["deep", "as", "it", "likes"] } }
}
```

| Field | Type | Rule |
|---|---|---|
| `sentAt` | `rfc3339` | required |
| `health` | `object \| null` | optional; the only leaves the API interprets, each optional and nullable: `batteryPercent` (`int`, 0 to 100), `lastFixAgeS` (`number`, 0 or more), `socketState` (a beacon socket state from 0.5). Unknown keys inside `health` are `400 validation_failed`. A beacon that has none of these sends `null` or omits the object. |
| `debug` | `object \| null` | optional; any JSON object, stored verbatim and rendered by the panel as a themed JSON tree; never interpreted, never published. Nesting at most 8 levels; the whole body at most 32 KB. |

No other top-level keys. Handling: stamp `last_heartbeat_at = now()`, `last_seen_at`, `telemetry = body`; clear `stale_since`. Both a heartbeat and a stored location (7.2) clear `stale_since`. Never touches the live object or the site. The panel's colouring (1.11) reads `health` only.

`200 { "receivedAt": "...", "liveEventId": 7, "isActive": true, "serverTime": "..." }` (`liveEventId` is `int64 | null`; `isActive` is the row's flag; a beacon shows both on its own status surface, section 9.3). Errors: `400`, `401`, `413`, `429`.

**`POST /beacons/logs`**. `X-Beacon-Key`, any beacon; `Content-Type: text/plain; charset=utf-8`; body up to 2 MB; optional header `X-App-Version` (64 characters max). Stored in `beacon_log`. `201 { "id": 17, "sizeBytes": 183422, "receivedAt": "...", "serverTime": "..." }`. Errors: `401`, `413`, `415`, `429`.

### 4.3 Public endpoints (no auth)

**`POST /contact`**.

```json
{ "name": "Jane Doe", "email": "jane@example.com", "message": "Hello" }
```

Rules: `name` 1 to 100, `email` a valid address 3 to 254, `message` 1 to 2000. Stores `contact_message` (with the client IP) and writes outbox row `contact.received`; the leader chore emails it to `WMSFO_CONTACT_NOTIFY_EMAIL`. The request never waits on SES. `201 { "id": 12, "createdAt": "..." }`. Errors: `400`, `429`. Idempotency: none.

**`POST /subscriptions/verify`**. Body `{ "token": "wsv_..." }`. Called by the site page `/alerts/verify`, which reads `token` from its query string (the email link is a site link, never an API link, so a mail scanner following it changes nothing). Looks the row up by `sha256(token)`. Row already verified: `200 { "verifiedAt": "..." }` with the existing `verifiedAt`, regardless of `verify_expires_at`. Row unverified and unexpired: sets `verified_at`, `200 { "verifiedAt": "..." }`. Row unverified and expired, or no row: `404 not_found`. The hash stays on the row until the next mint or the row is deleted.

**`POST /subscriptions/unsubscribe`**. The token comes from either place: the query string `?token=wsu_...` or a JSON body `{ "token": "wsu_..." }`. The query form exists for RFC 8058: the `List-Unsubscribe` header names `https://<api-domain>/subscriptions/unsubscribe?token=wsu_...` and mail clients POST the form body `List-Unsubscribe=One-Click` to it; the API accepts `application/x-www-form-urlencoded` there and ignores the form body. The site page `/alerts/unsubscribe` reads `token` from its query string and sends the JSON form. Sets `unsubscribed_at`. `204`. Idempotent. Unknown token: `404 not_found`.

**`GET /preview/document?token=wpv_...`**. The one public read, used only by the site's `/preview` route inside the admin panel's preview frame (4.5 Content). Answers `200 ContentBundle`: the working set as it would publish (hidden rows omitted), the media map for the media it references plus the media the snapshot's media map adds beyond the content (sponsor logos, cookie type media icons; 1.3b), and the icon map, with `Cache-Control: no-store` and a strong `ETag`: the quoted lowercase sha256 hex of the exact response body. A request whose `If-None-Match` carries that `ETag` answers `304 Not Modified` with the same `ETag` and no body, so a caller polling an unchanged draft downloads nothing; any draft change changes the body and so the `ETag`. Unknown or expired token: `404 preview_token_invalid`. Rate limited per client IP (4.0).

**`POST /qr-codes/{tag}/scans`**. One printed-code visit (4.5a Public). Body `{ "referrer": "https://..." }`, optional. Always `204`. Sent by the site's `/q/:tag` route with `navigator.sendBeacon` before it navigates.

### 4.4 Registered person endpoints (`Authorization: Bearer <id-token>`)

**`GET /me`**. `200 { "person": Person, "isAdmin": false }`.

**`GET /me/subscriptions`**. `200 { "items": Subscription[] }`.

**`POST /me/subscriptions`**. `{ "channel": "email", "address": "jane@example.com" }`. `address` is trimmed and lowercased before validation, storage, and every comparison. Creates the subscriber row for this person (or re-activates it for this person when the address exists unsubscribed and belongs to this person: clears `unsubscribed_at`, keeps `verified_at`). When the row is not verified: mints a `wsv_` verify token (hashed at rest, 24 h) and writes outbox `subscription.verify` carrying the plaintext token (7.7); `201 Subscription` with `verifiedAt` null. When re-activating a verified row: no token, no outbox row; `201 Subscription` with the existing `verifiedAt`. Errors: `400 validation_failed` (`channel` not `email`, bad address), `409 address_taken` (address belongs to another person), `409 already_subscribed` (verified and not unsubscribed for this person). A re-POST for the same person and address in pending state returns `200` with the existing row and sends nothing. Verification is required even when the address equals the Cognito email.

**`POST /me/subscriptions/{id}/resend-verification`**. Mints a fresh verify token and writes outbox `subscription.verify` carrying the plaintext token (7.7). `202 Subscription`. Errors: `404`, `409 already_verified`.

**`DELETE /me/subscriptions/{id}`**. Sets `unsubscribed_at`. `204`. Errors: `404`. Idempotent.

**`GET /me/alerts`**. `200 { "items": AlertItem[] }`: the alert emails actually sent to this person's subscriptions (`alert_delivery` rows with `sent_at` set, joined to their outbox row and event), newest first, at most 100. Each item names the subscription address, the kind (`event_status` or `event_message`), the event, the status or message it announced (a status alert whose payload carries `messageId` reports it in `messageId` too), the subject line as sent, `message` (the body of the event message `messageId` names, read at request time, for status and message alerts alike; null when the payload names none or the row was deleted), and `sentAt`. Verification and unsubscribe mails are not alerts and never appear.

**`GET /me/cookies`**. Cookies this person left on the current event.

```json
{ "eventId": 7, "eventStatusId": 3, "limit": 10, "used": 3, "remaining": 7,
  "items": [ { "id": 90, "cookieTypeId": 3, "note": "yum", "leftAt": "..." } ] }
```

`eventId` and `eventStatusId` null and `items` empty when no event is current. `limit` is the current `cookie_limit_per_person`; `used` counts every cookie this person left on the event; `remaining` is `max(0, limit - used)`, an `int`.

**`POST /cookies`**. `{ "items": [ { "cookieTypeId": 3, "count": 2 }, { "cookieTypeId": 5, "count": 1 } ], "note": "yum" }`: the whole pick in one request. `items` 1 to 50 entries, each `cookieTypeId` listed once with `count` 1 to 1000; `note` optional, 0 to 140 characters, `null` when absent, the same note on every cookie of the pick. Transaction: `select ... for update` on the person row (serializes this person's inserts); load the live event (`status_id = 3`) else `409 no_live_event`; every listed type must exist and be active else `404 not_found` with `details.cookieTypeIds` naming the missing ones; count this person's cookies on the event and refuse the whole pick with `409 cookie_limit_reached` (`details.remaining`) when the total would pass `cookie_limit_per_person` read inside the transaction; one multi-row insert; commit; increment this node's tally counter per cookie. `201 { "eventId": 7, "left": 3, "remaining": 6, "cookies": [ { "id": 90, "cookieTypeId": 3, "leftAt": "..." }, ... ] }` (`remaining` is `max(0, limit - used)` after the insert, an `int`). All or nothing: a refused pick stores no cookie. Idempotency: none.

### 4.5 Admin endpoints (`Authorization: Bearer <id-token>` with group `admin` or `editor`)

Each group of endpoints names its policy (3.1): **Editor** admits both groups, **Admin** admits `admin` only. Editor endpoints: Sponsors, Pages, Sections and items, Site settings, Content, Media, Icons, Posters, `GET /admin/help`, `GET /admin/events/{id}/route-map`, and `GET /admin/routes/{id}/route-map`. Everything else is Admin. Every group except API keys is also reachable with an API key carrying that group's capability (3.6). All admin writes record the caller's `email` claim, or `key:<name>` for a key, in the audit column named per table. Writes marked **[snapshot]** run the transaction in 7.3 and answer `502 snapshot_write_failed` if the snapshot upload fails; after commit the node writes the live object (1.8). The response is sent immediately after commit. The live-object write and publish run after the response and never delay it; their outcome is visible only through `GET /admin/live`.

#### Events (Admin)

| Method and path | Body | Success | Endpoint-specific errors |
|---|---|---|---|
| `GET /admin/events` | | `200 { "items": Event[] }` ordered `year` desc | |
| `POST /admin/events` **[snapshot]** | `{ "year": 2026, "name": "...", "scheduledAt": null, "fundsPercent": 0, "routeId": null, "inheritRoute": true, "scheduleTimeZone": null, "trackerBbox": null }` (`year`, `name`, `inheritRoute` required; `scheduledAt` defaults null; `fundsPercent` defaults 0; `routeId` defaults null; `scheduleTimeZone` defaults null and is an IANA zone id such as `America/Denver`, `400 validation_failed` on an unknown id; `trackerBbox` a `Bbox` with sides 0.05 to 20 degrees, or null or absent for the default, `400 validation_failed` at `trackerBbox` otherwise; `year` 2000 to 2100 unique; `name` 1 to 200; `fundsPercent` 0 to 100) | `201 Event` with `statusId` 1, `isCurrent` false. `inheritRoute: true` requires `routeId` null (`400` otherwise) and copies the `route_id` of the event with the greatest `year` that has one (none: no route); `inheritRoute: false` uses `routeId` as given. The tracker fields follow one rule for everything the body does not give: the box is the published `settings.tracker.defaultBbox` (1.3a), or the built-in Missoula valley box when the published document has no `tracker` key; the map and the enabled theme set are copied from the event with the greatest `year`, the map only when its package contains the new box (else null); when no event exists every theme is enabled and the map is the seeded valley map when it contains the box. | `400`, `404 not_found` (routeId), `409 year_taken` |
| `GET /admin/events/{id}` | | `200 Event` | |
| `GET /admin/events/{id}/route-map` (Editor) | | `200 { "routeMap": RouteMap \| null }`: the event's linked recording built exactly as `event.routeMap` (1.3) with the current settings, for any event, current or not, so the panel's poster generator renders any event's map; `null` when no recording is linked. Not snapshot-affecting | `404` |
| `PATCH /admin/events/{id}` **[snapshot]** | Any of `name`, `year`, `scheduledAt`, `wentLiveAt`, `endedAt` (each: an RFC 3339 timestamp sets it, null clears it, absent leaves it unchanged; `400 validation_failed` on anything else), `fundsPercent`, `routeId`, `scheduleTimeZone` (an IANA zone id sets it, null clears it, absent leaves it unchanged; `400 validation_failed` on an unknown id), `routeMapConfig` (a `RouteMapConfig` object sets it whole, null clears it, absent leaves it unchanged; the snapshot's `event.routeMapConfig` carries it while the event is current; rules under **Route map configuration** in 1.3), `trackerBbox` (a `Bbox` with sides 0.05 to 20 degrees sets it; the box is required, so null is `400`; when the event has a map the new box must stay inside the map's package, `400 validation_failed` at `trackerBbox` otherwise), `trackerMapId` (a map id sets it, null clears it, absent leaves it unchanged; the map must be `ready` and its package must contain the event's box, after this write's `trackerBbox` when both are given, `400 validation_failed` at `trackerMapId` otherwise; an unknown id is `404`), `trackerThemeIds` (an array of theme ids replaces the enabled set whole; distinct, at least one `google` theme, `400 validation_failed` at `trackerThemeIds` otherwise; an unknown id is `404`). Any other field is `400` (0.2), `routeImageMediaId` included: the event has no route image, and a poster is its own document (Posters below), never an event field. | `200 Event` | `404` (event, route, map, or theme), `409 year_taken`, `409 scheduled_at_required` (`scheduledAt: null` while `statusId` is 2), `400 validation_failed` (an unknown field; a `routeMapConfig` that is not an object or null, or breaks its schema, at the field's path, `landmarks` included; the tracker rules at `trackerBbox`, `trackerMapId`, `trackerThemeIds`) |
| `DELETE /admin/events/{id}` **[snapshot]** | | `204`; deletes its messages, cookies, status history, locations, and pending alert outbox rows | `404`, `409 event_live` (status 3), `409 event_current` (`isCurrent`; make another event current first) |
| `POST /admin/events/{id}/current` **[snapshot]** | none | `200 Event` (`isCurrent` true; the previous current event's flag cleared in the same transaction). Idempotent: on the already-current event, `200 Event` with no snapshot rebuild and no live-object write, in every status. | `409 current_event_live` (another event is current and live) |
| `POST /admin/events/{id}/status` **[snapshot]** | `{ "statusId": 3, "notify": true, "message": null }` (`statusId` and `notify` required; `message` optional, trimmed, 1 to 1000 characters, posted as an event message and carried in the alert instead of the stock paragraph; honoured with `notify` false too; without a `message` the template's stock paragraph for the new status is posted as the event message, so a status change always posts one) | `200 Event` | `400` (`statusId` outside 1 to 6), `409 event_status_unchanged` (same status), `409 event_not_current` (3 requested and `isCurrent` false), `409 another_event_live` (3 requested while another event has status 3), `409 scheduled_at_required` (2 requested and `scheduledAt` null), `409 no_healthy_beacon` (3 requested and no beacon is active, or the active beacon is revoked or stale; `details.beacon` carries the active beacon's `id`, `name`, `lastSeenAt`, `staleSince`, or null when none is active) |
| `GET /admin/events/{id}/status-history` | | `200 { "items": StatusHistory[] }` newest first, each with whether subscribers were notified and how many emails went out | |
| `POST /admin/events/{id}/notify` (**[snapshot]** when `message` is given) | `{ "message": null }` (`message` optional, trimmed, 1 to 1000, posted as an event message and carried in the alert instead of the stock paragraph) | `200 Event`: announces the event's current status to subscribers now (outbox `event.status_notified`, the same fan-out and template as a status change with `notify: true`), sets `statusNotifiedAt`, and appends a StatusHistory row with `fromStatusId` equal to `toStatusId` and `notify: true`; with a `message` it inserts the `event_message` row (`notify` false, created by the actor) before the history row, the history row references it, and the snapshot is rebuilt so it is the event's `latestMessage`. The audit row's `after` is the Event plus `messageId` (null without a message) | `404` |
| `POST /admin/events/{id}/clone` | `{ "year": 2027, "name": "Santa Flyover 2027", "copy": { "sponsors": true, "route": true, "routeMapConfig": true, "tracker": true } }` (`year` and `name` required as for create; every `copy` flag optional, default false) | `201 Event`: a new event in status 1, not current, `fundsPercent` 0, no scheduled time; `sponsors` copies every `sponsor_year` row of the source event's year to the new year (all fields but `registeredAt`, skipping sponsors that already have the new year) together with the year's pinned order; `route` links the source's `routeId`; `routeMapConfig` copies the source's `routeMapConfig` (null when it has none); `tracker` copies the source's `trackerMapId` and its enabled theme set. The box copies from the source whatever the flag, because every event has one. Without `tracker` the map and the theme set follow the create rule above (copied from the event with the greatest `year`). Not snapshot-affecting (the new event is not current) | `404`, `409 year_taken`, `400 validation_failed` |
| `GET /admin/events/{id}/messages` | | `200 { "items": EventMessage[] }` newest first | |
| `POST /admin/events/{id}/messages` **[snapshot]** | `{ "body": "...", "notify": true }` (`body` 1 to 1000; `notify` required; any other field, `eventTime` included, is `400`) | `201 EventMessage` (`sentCount` 0); with `notify` true it writes outbox `event.message_posted` and sets the message's `notify` true and its outbox row in the same transaction, and the alert-send chore counts each email sent on the message's `sentCount` | `400 validation_failed`, `404` |
| `PATCH /admin/events/{id}/messages/{messageId}` **[snapshot]** | `{ "body": "..." }` (`body` 1 to 1000; any other field is `400`) | `200 EventMessage` (no outbox row; `notify` and `sentCount` unchanged) | `400 validation_failed`, `404` |
| `DELETE /admin/events/{id}/messages/{messageId}` **[snapshot]** | | `204` | `404` |
| `POST /admin/events/{id}/cookies` | `{ "items": [ { "cookieTypeId": 3, "count": 25 } ] }` (1 to 50 entries, each type listed once, `count` 1 to 100) | `201 { "eventId": 7, "seeded": 25, "cookieTally": { "1": 412, "3": 437 } }`: seeds the cookies on the live event; `cookieTally` is the event's whole tally after the insert, keys ascending, zero-count types absent, as on the live object (1.2). Not snapshot-affecting, no outbox row | `400 validation_failed` (on the field), `404 not_found` (event; or a listed type missing or inactive, with `details.cookieTypeIds`), `409 event_not_live` (status is not 3) |
| `GET /admin/events/{id}/locations?cursor=&limit=&beaconId=&publishedOnly=false` | | `200 Page<LocationRow>` ordered `seq` asc; with `Accept: text/csv` streams every matching row (paging ignored) with the header `seq,beaconId,published,recordedAt,receivedAt,lat,lng,speedMps,speedSource,altitudeM,headingDeg,accuracyM` | |
| `DELETE /admin/events/{id}/locations?beaconId=` | | `204`; deletes the event's location rows, one beacon's when `beaconId` is given; `next_seq` is not reset; without `beaconId` `event.latest_fix` is nulled, with `beaconId` it is nulled only when its `beaconId` matches; the audit action is `event.locations_cleared` with `before = { count, byBeacon: [ { beaconId, name, count } ] }`. The leader's next tick rewrites the live object from SQL, so the site sees the marker update in due course (contracts 1.2 lets a site keep the location it holds until reload; fine). | `404`, `409 event_live` |
| `GET /admin/events/{id}/locations/impact` | | `200 DeleteImpact` (api.md 5b): one group `locations` per beacon with the count and the beacon's name; blocked with `This event is live. End it first.` while live | `404` |

**Seeded cookies.** An admin can add cookies to the live event's tally so it never sits at zero; cookies stay a hidden feature on the panel. A seeded cookie is a `cookie` row with `person_id` null and `seeded_by` the actor exactly as the audit log writes it (`person:<email>` or `key:<name>`), `note` null, `left_at` the insert time (sql.md 8.9a). The write locks the event row, inserts in one statement, and commits; the node then adds the cookies to its in-memory tally as `POST /cookies` does, so the live object carries them within a tick and the leader's tally rewrite covers the fleet (7.4). Seeded cookies count wherever a cookie counts: `cookieTally` (1.2), `final_cookie_tally` on entry into status 4, `CookieType.cookieCount` and the cookie type delete, and the events delete impact and cascade. They never count toward or appear as any person's: the per-person limit of `POST /cookies`, `GET /me/cookies`, and `cookieCount` on `GET /admin/people` see only the person's own rows, the events delete impact names only people's emails, and `DELETE /admin/people/{id}` leaves them. The audit row is action `cookies_seeded` on entity `event` with `before` null and `after = { "items": [ { "cookieTypeId": 3, "count": 25 } ], "seeded": 25 }`.

Status change transaction: lock the event row; check the rules above; for `statusId` 3 also read the active beacon (`is_active`) and refuse with `409 no_healthy_beacon` unless it exists, has `revoked_at` null, `stale_since` null, and `last_seen_at` not null (a healthy beacon is one the API has heard from within `beacon_stale_after_s`; the socket is not required, HTTP heartbeats count); update `status_id`; set the two stamps by the status entered, whatever the status left, per the table below (earlier stamps are overwritten; `scheduled_at` is admin-entered and a status change never touches it; the admin can correct either stamp with `PATCH`; the audit `after` and the rebuilt snapshot carry the result); on every entry into 4 also set `final_cookie_tally` to the current counts (`jsonb_object_agg` per type) and on every exit from 4 set it to null; insert the `event_message` row (`created_by` the actor, its own `notify` false) with the change's `notify` true or false, its body the `message` when given and otherwise the template's stock paragraph for the new status (7.8, rendered from the event's name, `scheduled_at`, and `schedule_time_zone`, the same text the email would carry); insert outbox `event.status_changed { eventId, fromStatusId, toStatusId, notify, messageId }` (`messageId` the new row's id); insert `event_status_history` with `message_id` the same; record the audit row, whose `after` is the Event plus `messageId` (no separate message audit row); rebuild the snapshot, which carries the new message as `latestMessage`; commit. Deleting the message later sets the history row's `message_id` null (the foreign key's `on delete set null`), and an alert not yet sent then renders the stock paragraph. After commit the node writes the live object with the new `eventStatusId` and `snapshotUrl` and publishes it. Any status may follow any other status; the admin decides, and `notify` decides whether subscribers are emailed (only entries into 2 and 3 produce emails, section 7.7).

Stamps by the status entered (the status left does not matter):

| Status entered | `went_live_at` | `ended_at` |
|---|---|---|
| 1 planned, 2 scheduled, 5 cancelled, 6 postponed | null | null |
| 3 live | `now()` | null |
| 4 ended | kept | `now()` |

#### Routes (Admin)

Flight recordings (1.4). Not shown on the site; used by Red-Nose replay, exports, and tests.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/routes` | | `200 { "items": Route[] }` newest first | |
| `GET /admin/routes/{id}` | | `200 Route` | |
| `GET /admin/routes/{id}/route-map` (Editor) | | `200 { "routeMap": RouteMap \| null }`: this recording built exactly as `event.routeMap` (1.3) with the current `route_map_*` settings, whether or not any event links it, so the panel's poster composer renders any recording's map; `null` only when the recording's object cannot be read. Not snapshot-affecting | `404` |
| `POST /admin/routes` | `{ "name": "2026 draft", "points": [ { "lat", "lng", "recordedAt" } ] }` per 1.4 | `201 Route`. Canonicalizes and hashes (1.6), looks `route` up by `s3_key` before the PUT (when a row exists: `200` that row and nothing is written), PUTs `routes/{sha256}.json`, inserts the row. When the insert after the PUT fails on `s3_key unique` (concurrent identical upload): `200` the existing row. | `400`, `413`, `502 route_write_failed` |
| `POST /admin/routes/from-event/{eventId}` | `{ "name": "2026 flight" }` (`name` 1 to 200) | `201 Route` built from the event's `published = true` locations in `seq` order (`lat`, `lng`, `recordedAt = recorded_at`), then stored exactly like an upload (canonicalize, hash, existing-row check, PUT, insert). Point count must be 2 to 50,000. | `404` (event), `400 validation_failed` (fewer than 2 points), `413` (over 50,000), `502 route_write_failed` |
| `DELETE /admin/routes/{id}` | | `204`; deletes the object; events and posters that used it lose their recording (`routeId` null, each listed under `unlinks`: a group `event` and a group `poster`) | `404` |

Attaching a route to an event is `PATCH /admin/events/{id}` with `routeId`; to a poster, `PATCH /admin/posters/{id}` with `routeId`.

#### Posters (Editor)

A poster is the admin panel's own document: the panel makes many (different QR codes, different sponsor logos) for the poster studio and for distribution off the site. Nothing attaches a poster, or an image made from one, to an event, and the site never shows one. The group rides the `events` capability (3.6). Nothing here is snapshot-affecting; posters are never public.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/posters` | | `200 { "items": PosterSummary[] }` newest first (by `id` desc); no `layout` | |
| `POST /admin/posters` | `{ "name": "Main street", "routeId": null, "layout": null }` (`name` required, 1 to 200, trimmed; `routeId` optional, a route id or null; `layout` optional, per the layout rule below) | `201 Poster` | `400 validation_failed`, `404` (route) |
| `GET /admin/posters/{id}` | | `200 Poster`, `layout` included | `404` |
| `PATCH /admin/posters/{id}` | Any of `name` (1 to 200), `routeId` (a route id sets it, null clears it, absent leaves it unchanged), `layout` (a JSON object sets it, null clears it, absent leaves it unchanged) | `200 Poster` | `404` (poster or route), `400 validation_failed` (a `layout` that is not an object or null, or whose canonical form exceeds 32 KB; a `routeId` that is not an integer or null) |
| `DELETE /admin/posters/{id}` | | `204` | `404` |
| `GET /admin/posters/{id}/impact` | | `200 DeleteImpact`: nothing depends on a poster, so `deletes` holds the one group `poster` (count 1, the poster's name) and `unlinks` and `warnings` are empty | `404` |

**Poster layout.** `layout` is the admin panel's poster composer document. The panel owns its shape; the API never looks inside it. The API requires a JSON object (an array or a scalar is `400 validation_failed` on `layout`) whose canonical form is at most 32 KB (32768 bytes), stores it in `poster.layout`, and answers it on `GET /admin/posters/{id}` and every write that returns a `Poster`, in canonical form: object properties in ascending ordinal order at every depth, no whitespace, numbers as written. It is never public: it is not in the snapshot, the live object, or any site document. Every write is audited (entity `poster`).

#### Maps (Admin)

A map is one built tile package: a bounding box, a vector archive, an optional terrain archive, a zoom range, sizes, and build dates, stored under `maps/{packageKey}/` (1.1). The package is built and uploaded from an operator's machine by the tile CLI (platform.md 1.8); the panel lists, renames, and deletes maps and never uploads one. An event picks one `ready` map whose package contains its box (Events above); the snapshot carries the current event's as `event.trackerMap` (1.3). The group rides the `maps` capability (3.6).

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/maps` | | `200 { "items": TrackerMap[] }` by `name`, `id`, pending rows included, each with `eventCount` | |
| `POST /admin/maps` | `{ "name": "Missoula valley", "bbox": { "west": -114.75, "south": 46.35, "east": -113.30, "north": 47.25 }, "minZoom": 0, "maxZoom": 15, "terrainMaxZoom": 13, "sourceBuild": "2026-10-01" }` (`name` 1 to 200; `bbox` a `Bbox` with sides at most 20 degrees; `minZoom` 0 to 15; `maxZoom` 8 to 15 and at least `minZoom`; `terrainMaxZoom` 8 to 13, or null or absent for a package without terrain; `sourceBuild` a `YYYY-MM-DD` date or null) | `201 TrackerMapUpload`. The API computes `packageKey` (1.1), inserts a `pending` row with `prefix` `maps/{packageKey}`, starts one S3 multipart upload per declared archive (`tiles`, and `terrain` when `terrainMaxZoom` is given), and answers the row id, the key, and the upload ids. A `pending` row with the same key is reused: `200` the same shape with the open upload ids (or new ones for an archive whose upload is gone), so the CLI resumes after a failure. Not snapshot-affecting. | `400 validation_failed`, `409 package_exists` (a `ready` map has the key) |
| `POST /admin/maps/{id}/parts` | `{ "file": "tiles", "partNumbers": [1, 2, 3] }` (`file` `tiles` or `terrain`, an archive the row declares; `partNumbers` 1 to 100 distinct integers from 1 to 10,000) | `200 TrackerMapParts`: one presigned `UploadPart` URL per number for that archive's open upload, 15 minutes each; the CLI sends 64 MB parts, the last one shorter. Not audited as a change of the row beyond the `parts` action. | `404`, `409 package_exists` (the map is `ready`), `400 validation_failed` (at `file` or `partNumbers`) |
| `POST /admin/maps/{id}/complete` | `{ "file": "tiles", "parts": [ { "partNumber": 1, "etag": "..." } ] }` (every part in order, 1 to 10,000) | `200 TrackerMap` (still `pending`): completes that archive's multipart upload with the listed parts | `404`, `409 package_exists` (the map is `ready`), `400 validation_failed` at `parts` (S3 refuses the completion: a missing part or a wrong etag) |
| `POST /admin/maps/{id}/confirm` | none | `200 TrackerMap` with `state: "ready"`, `builtAt` now, `tilesBytes` and `terrainBytes` from the objects' lengths. The API reads the first 127 bytes of each declared archive with a range GET and checks the PMTiles v3 magic and header, that the archive's bounds contain the declared `bbox`, and that its zoom range is the row's (`minZoom` and `maxZoom` for `tiles`, `terrainMaxZoom` for `terrain`); then writes `maps/{packageKey}/manifest.json` (the `TrackerMap` fields) and updates the row. Idempotent on a `ready` row (`200`, nothing written). Not snapshot-affecting: no event can reference a pending map. | `404` (row), `404 upload_not_found` (an archive missing; `details.file`), `409 package_invalid` (`details.field` names `tiles` or `terrain` and `details.reason` the failed check; the row stays `pending` and the CLI re-uploads) |
| `PATCH /admin/maps/{id}` **[snapshot]** while the current event uses the map | `{ "name": "..." }` (1 to 200; any other field is `400`) | `200 TrackerMap` | `404`, `400 validation_failed` |
| `GET /admin/maps/{id}/impact` | | `200 DeleteImpact` (api.md 5b): `unlinks` holds one group `event` with the events whose map it is; `warnings` says their viewers get Google Maps at the next snapshot, naming the current event when it is among them, and that the live viewers move at the next snapshot when that event is live; `blocked` null | `404` |
| `DELETE /admin/maps/{id}` **[snapshot]** while the current event uses the map or the replacement | optional `{ "replacementId": 4 }` (another `ready` map, or null or absent) | `204`. One transaction: every referencing event takes the replacement when one is given (its package must contain each such event's box) and `trackerMapId` null otherwise; the row is deleted; then every object under the row's prefix is deleted and any open multipart upload under it aborted. The seeded map's prefix `basemap` is never removed from the bucket; deleting the seeded row leaves its objects. | `404` (map or `replacementId`), `400 validation_failed` at `replacementId` (not `ready`, the map itself, or its package does not contain a referencing event's box; `details.eventId` names the first such event) |

A pending map older than one day is removed by the pending map sweep (7.6) together with its open uploads; the bucket's lifecycle rule aborts the uploads on its own after a day as well (1.7).

#### Themes (Admin)

A theme is one tracker look for one renderer, `google` or `maplibre`: a style body authored outside the panel and imported as a file, the chrome and overlay colours, a thumbnail, and the two default flags. The style lives on the CDN at `themes/{sha256}.json` (1.1); the row carries what the snapshot needs inline (1.3 `trackerThemes`). Each event enables any subset with at least one `google` theme (Events above). The group rides the `themes` capability (3.6). The panel labels the page "Tracker themes".

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/themes` | | `200 { "items": TrackerTheme[] }` by `renderer`, `sortOrder`, `id`, each with `eventCount` | |
| `POST /admin/themes` | `{ "renderer": "maplibre", "key": "candy-cane", "name": "Candy cane", "sortOrder": 10, "style": { ... }, "chrome": { ... }, "overlay": { ... }, "thumbnailMediaId": null }` as JSON, or `multipart/form-data` with the same fields and `style` as a file part (`renderer` required; `key` `^[a-z][a-z0-9-]{1,39}$`, unique per renderer; `name` 1 to 60; `sortOrder` an integer, default 0; `style` per **Style rules** below; `chrome` and `overlay` per **Chrome and overlay** below; `thumbnailMediaId` a `ready` raster media asset id, or null or absent) | `201 TrackerTheme`. The API canonicalizes `style` (1.6), hashes it, PUTs `themes/{sha256}.json` with the immutable header (an existing key is not rewritten), and inserts the row with `styleSha256` and `styleBytes`. Not snapshot-affecting: no event enables it yet. | `400 validation_failed` (at the field: `key` when another theme of the renderer has it, `style` with the reason in `details`, `chrome.text`, `chrome.tileFg`, and so on), `404` (media), `409 media_not_ready`, `502 upstream_failed` (the style PUT) |
| `PATCH /admin/themes/{id}` **[snapshot]** while the current event enables the theme | subset of `key`, `name`, `sortOrder`, `style`, `chrome`, `overlay`, `thumbnailMediaId` (a `ready` raster asset sets it, null clears it, absent leaves it unchanged); `renderer` is immutable (`400`) | `200 TrackerTheme`. A new `style` writes a new `themes/{sha256}.json` and the old object stays (immutable keys, like snapshots). A `key` change rewrites nothing else: a viewer whose stored key no longer matches falls to the default. | `404` (theme or media), `409 media_not_ready`, `400 validation_failed` |
| `POST /admin/themes/{id}/sprite` | `{ "indexSha256": "ee55..." }` (the lowercase hex SHA-256 of the canonical bytes of the `sprite.json` the panel is about to upload, 1.6) | `201 SpriteTickets`: four presigned `PUT`s (15 minutes), one per sprite file, keys `themes/{id}/sprites/{indexSha256}/sprite.json`, `sprite.png`, `sprite@2x.json`, `sprite@2x.png`, each with its `Content-Type` (`application/json; charset=utf-8` or `image/png`) and `x-amz-tagging: state=pending` signed exactly as a media ticket (Media below); the panel must send exactly `headers`. MapLibre themes only. A set the theme already carries (`spriteSha256` equal) answers `200` with the same tickets. | `404`, `400 validation_failed` at `renderer` (a `google` theme) or `indexSha256` (not 64 lowercase hex characters) |
| `POST /admin/themes/{id}/sprite/confirm` **[snapshot]** while the current event enables the theme | `{ "indexSha256": "ee55..." }` (the prefix to confirm) | `200 TrackerTheme` with `spriteSha256` set. The API `HEAD`s the four objects under `themes/{id}/sprites/{indexSha256}/`, reads each, checks that each JSON parses to an object of at most 1 MB, that the canonical bytes of `sprite.json` hash to `indexSha256`, and that each PNG starts with the PNG signature and is at most 8 MB, removes the pending tags, and sets `sprite_sha256`; the previous set's objects stay (immutable keys, like a replaced style). Idempotent on a confirmed set. | `404` (theme), `404 upload_not_found` (a file missing; `details.file`), `400 validation_failed` at `file` (`details.file` names it; the four objects are deleted and the row is unchanged) or at `indexSha256` (the index does not hash to it) |
| `POST /admin/themes/{id}/default` **[snapshot]** while the current event enables the theme or the flag's previous holder | `{ "light": true, "dark": false }` (each optional boolean; an absent flag is left as it is) | `200 TrackerTheme`. Setting a flag true clears that flag on the renderer's previous holder in the same transaction (two statements, sql.md 4.2); setting it false clears it on this theme. | `404`, `400 validation_failed` |
| `GET /admin/themes/{id}/impact` | | `200 DeleteImpact` (api.md 5b): `unlinks` holds one group `event` with the events that enable the theme; `warnings` names the default flag the renderer loses, when the theme carries one; `blocked` is "This is the only Google theme enabled on <event name>. Enable another there first." when a `google` theme is the only enabled Google theme on any event (the first such event by `year` desc), null otherwise | `404` |
| `DELETE /admin/themes/{id}` **[snapshot]** while the current event enables the theme or the replacement | optional `{ "replacementId": 9 }` (another theme of the same renderer, or null or absent) | `204`. One transaction: every referencing event enables the replacement in place of the deleted theme when one is given (the join rows simply go otherwise), the deleted theme's default flags move to the replacement (they clear otherwise), the row is deleted, then the objects under `themes/{id}/` are deleted; the style object stays (content-addressed, possibly shared). A `google` replacement lifts the `blocked` case. | `404` (theme or `replacementId`), `400 validation_failed` at `replacementId` (the theme itself, or a theme of the other renderer), `409 last_google_theme` (the impact's `blocked` case, without a `google` replacement) |

**Style rules.** `style` is validated for shape, not semantics, and refused with `400 validation_failed` at `style` with the reason in `details`; full MapLibre style-spec validation and a rendered preview happen in the panel before upload. Size caps on the canonical form: `google` 64 KB, `maplibre` 512 KB. `google`: a JSON array of objects whose keys are only `featureType`, `elementType`, and `stylers`. `maplibre`: an object with `version` 8; `sources` holding exactly `basemap` (`type: "vector"`) and, optionally, `terrain` (`type: "raster-dem"`), neither with `url` or `tiles`; every layer with a `source` (every type but `background`) names one of the two; `glyphs` and `sprite`, when present, are replaced by the API with the CDN glyph template (`basemap/glyphs/{fontstack}/{range}.pbf`, 1.1) and the theme's sprite base (1.3 `spriteUrl`; removed while the theme has no confirmed sprite set); no string anywhere starts with `http`. A layer that draws places carries `"metadata": { "wmsfo:places": true }`; the site applies `settings.places.tracker` to those layers and hides them when the list is empty. The stored body is the canonical JSON of the result.

**Chrome and overlay.** Every colour is `#rrggbb` or `#rrggbbaa`; every opacity is 0 to 1; no key is optional and no other key is allowed in either object (`400 validation_failed` at the key's path). `chrome.text` on `chrome.bg` and `chrome.tileFg` on `chrome.tile` must contrast at 4.5:1 or better by WCAG relative luminance with alpha composited over the other colour; a failure is `400 validation_failed` at `chrome.text` or `chrome.tileFg`.

Every write in both groups records an `audit_log` row (entity `tracker_map` or `tracker_theme`, Audit below); the lists and details carry the audit stamp.

#### Beacons (Admin)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/beacons` | | `200 { "items": Beacon[], "staleAfterS": 45 }` by name (telemetry included; `staleAfterS` is the current `beacon_stale_after_s`; `hubConnected` is true when the gateway's presence list for `<service>:ingest` (its `members[].identity`) contains `<id>:<keyVersion>` for the beacon, false when it does not, null when the presence call failed; `healthy` is `revokedAt` null and `staleSince` null and `lastSeenAt` not null) | |
| `GET /admin/beacons/{id}` | | `200 Beacon` (`hubConnected` resolved the same way) | |
| `POST /admin/beacons` | `{ "name": "...", "notes": "" }` (`name` 1 to 100, `notes` 0 to 2000) | `201 { "beacon": Beacon, "key": "wbk_...", "enrollment": Enrollment }` | `400` |
| `PATCH /admin/beacons/{id}` | `name`, `notes`, `minIntervalMs` (int 0 to 60000 or null to clear the override), `hubAllowed` (bool: whether the beacon may join the hub; false denies its join at the authorize callback and it sends over HTTP) | `200 Beacon` | `404` |
| `POST /admin/beacons/{id}/activate` | none | `200 Beacon` | `409 beacon_revoked` |
| `POST /admin/beacons/{id}/deactivate` | none | `200 Beacon` | |
| `POST /admin/beacons/{id}/rotate` | none | `200 { "beacon": Beacon, "key": "wbk_...", "enrollment": Enrollment }` | `409 beacon_revoked` |
| `POST /admin/beacons/{id}/revoke` | none | `200 Beacon` | |
| `GET /admin/beacons/{id}/logs` | | `200 { "items": BeaconLog[] }` newest first | |
| `GET /admin/beacons/{id}/logs/{logId}` | | `200 text/plain` body | `404` |

#### Sponsors (Editor)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/sponsors` | | `200 { "items": Sponsor[] }` by name | |
| `GET /admin/sponsors/{id}` | | `200 Sponsor` | |
| `POST /admin/sponsors` **[snapshot]** | `name` (1 to 200) plus any of `contactPerson`, `email`, `phone`, `address`, `websiteUrl`, `fbUrl`, `igUrl` (URLs absolute http or https, 2048 max) | `201 Sponsor` | |
| `PATCH /admin/sponsors/{id}` **[snapshot]** | same fields plus `logoMediaId` (a ready media asset id; an empty string clears it; null or absent leaves it unchanged) | `200 Sponsor` | `404` (sponsor or media), `409 media_not_ready` |
| `DELETE /admin/sponsors/{id}` **[snapshot]** | | `204`; deletes years and the row; the logo asset stays in the library | `404` |
| `PUT /admin/sponsors/{id}/years/{eventYear}` **[snapshot]** | `{ "amountDonated": 500.00, "active": true, "canAdvertise": true, "anonymous": false, "pinnedPosition": null, "lingerMsOverride": null }` (`amountDonated` 0 to 1,000,000,000 with at most 2 decimals, or null; the three booleans required; `pinnedPosition` null or an integer 1 to 1000, default null; `lingerMsOverride` null or an integer 0 to 600,000, default null; `eventYear` 2000 to 2100) | `200 Sponsor` (upsert on `(sponsor_id, event_year)`, idempotent) | `404`, `409 pinned_position_taken` (another sponsor holds that position for that year) |
| `DELETE /admin/sponsors/{id}/years/{eventYear}` **[snapshot]** | | `204` (idempotent) | `404` (sponsor) |
| `POST /admin/sponsors/{id}/years/{eventYear}/copy-from/{sourceYear}` **[snapshot]** | none | `201 SponsorYear`: the sponsor's `sourceYear` row copied to `eventYear` (`amountDonated`, `active`, `canAdvertise`, `anonymous`; `registeredAt` is now); the caller edits it afterwards like any year | `404` (sponsor, or no row for `sourceYear`), `409 year_exists` (the sponsor already has `eventYear`) |
| `POST /admin/sponsors/import` **[snapshot]** | `{ "fromYear": 2025, "toYear": 2026, "sponsorIds": [4, 9] }` (`sponsorIds` 1 to 1000 distinct ids, each with a `fromYear` row) | `200 { "created": 2, "skipped": 0 }`: one copy per sponsor in one transaction; a sponsor that already has `toYear` is skipped and counted | `400 validation_failed` (a listed sponsor has no `fromYear` row) |
| `GET /admin/sponsors/order/{eventYear}` | | `200 { "items": SponsorOrderRow[] }` in snapshot order (1.3): `{ sponsorId, name, pinnedPosition, amountDonated, lingerMs, lingerMsOverride, inSnapshot }` for every sponsor with a row for that year; `inSnapshot` is the 1.3 filter | |
| `PUT /admin/sponsors/order/{eventYear}` **[snapshot]** | `{ "pinnedSponsorIds": [4, 9, 2] }` (0 to 1000 distinct sponsor ids, each with a `sponsor_year` row for that year) | `200 { "items": SponsorOrderRow[] }`. One transaction: the listed sponsors get `pinned_position` 1..n in list order; every other row for that year gets null. An empty list unpins everything. | `400 validation_failed` (an id without a row for that year, or a duplicate; `details.fields.pinnedSponsorIds`) |

A logo is any media asset (raster, gif, or svg) uploaded through the Media endpoints and chosen on the sponsor; there is no separate logo upload. Pinning and overrides are per year: the panel's order screen for a year is the whole story of that year's display order and timing.

#### API keys (Admin, Cognito only)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/api-keys` | | `200 { "items": ApiKey[] }` newest first, revoked and expired included | |
| `POST /admin/api-keys` | `{ "name": "claude-code", "allCapabilities": false, "capabilities": ["pages", "sections", "content", "media"], "expiresAt": "2027-01-31T00:00:00Z" }` (`name` 1 to 100, unique among unrevoked keys; `allCapabilities` required; `capabilities` required, empty when `allCapabilities` is true and a non-empty subset of the list in 3.6 otherwise; `expiresAt` null or at least one hour ahead) | `201 ApiKeyMinted`; `key` appears here and nowhere else | `400`, `409 name_taken` |
| `POST /admin/api-keys/{id}/revoke` | none | `200 ApiKey` (`revokedAt` set; idempotent) | `404` |

An API key request on these three endpoints is `403 forbidden` whatever its capabilities.

#### Cookie types (Admin)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/cookie-types` | | `200 { "items": CookieType[] }` by `sort`, `id` | |
| `POST /admin/cookie-types` **[snapshot]** | `{ "name": "...", "sort": 10, "active": true, "icon": null }` (`name` 1 to 100; `sort` -1000 to 1000; `icon` an `Icon` or null; all four required) | `201 CookieType` | `409 event_live`, `404` (media icon), `409 media_not_ready`, `400` (unknown library id) |
| `PATCH /admin/cookie-types/{id}` **[snapshot]** | subset of `name`, `sort`, `active`, `icon` | `200 CookieType` | `404`, `409 event_live`, `409 media_not_ready`, `400` |
| `DELETE /admin/cookie-types/{id}` **[snapshot]** | | `204`; its cookies are deleted with it (the tallies drop by their count; the impact says how many and warns while live) | `404`, `409 event_live` (cookie type writes are locked while an event is live) |

Every write in this group returns `409 event_live` while any event has `status_id = 3`. Deleting a type deletes its cookies with it (the event tallies drop by their count); `active: false` removes a type from the snapshot without deleting it. Artwork is an icon: a library id or any `ready` media asset.

#### Pages (Editor)

Pages, sections, items, and the site settings draft are the working set. Writes here validate at the draft level (1.3a), never rebuild the snapshot, and reach the site only through a publish. `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, 1 to 60 characters, and is not one of `auth`, `preview`, `api`, `admin`, `assets`.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/pages` | | `200 { "items": PageAdmin[] }` ordered `role` pages first (in status order, `no_event` first), then `none` pages by `navPosition`, `id` | |
| `POST /admin/pages` | `{ "slug": "about", "title": "About", "navLabel": "About", "icon": { "source": "library", "id": "star" }, "navPosition": 10, "isHidden": false }` (`slug`, `title` required; `title` 1 to 200; `navLabel` null or 1 to 40; `icon` an `Icon` (1.3a) or null, absent means null; `navPosition` defaults to one past the greatest; role is always `none`) | `201 PageAdmin` | `400 slug_reserved`, `409 slug_taken`, `400 validation_failed` (`icon` not an `Icon`, on `icon`; a library id not in the library, on `icon.id`), `404` (media icon asset), `409 media_not_ready` |
| `GET /admin/pages/{id}` | | `200 PageDetail` (sections with items in order, each with its publish-level `problems`) | `404` |
| `PATCH /admin/pages/{id}` | subset of `slug`, `title`, `navLabel`, `icon` (an `Icon` sets it, `null` clears it, absent leaves it), `navPosition`, `isHidden` | `200 PageAdmin`. On a role page `navLabel` must stay null and `isHidden` false (`400`); role pages take icons like any page. | `404` (the page or a media icon asset), `400 slug_reserved`, `409 slug_taken`, `400 validation_failed` (`icon` not an `Icon`, on `icon`; a library id not in the library, on `icon.id`), `409 media_not_ready` |
| `DELETE /admin/pages/{id}?roleTo=` | | `204`; cascades sections and items; a role page is deleted only when `?roleTo=<page id>` names a page with role `none`, which takes the role in the same transaction (the impact warns which role); a `none` page ignores `roleTo` | `404` (the page, or the `roleTo` page), `400 validation_failed` (`roleTo` not an integer), `400 role_needs_page` (the page holds a role and `roleTo` is missing or names a page whose role is not `none`) |
| `PUT /admin/pages/order` | `{ "ids": [3, 5, 4] }` (every `none` page exactly once) | `200 { "items": PageAdmin[] }`; `navPosition` becomes the index times 10 | `400` |

The seven role pages are created by the seed (sql.md 6) with slugs `no-event`, `planned`, `scheduled`, `live`, `ended`, `cancelled`, `postponed`; a role page's role moves only when the page is deleted with `roleTo`, so every role always has exactly one page. Reaching `/<slug>` of a role page on the site redirects to `/`.

#### Sections and items (Editor)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/content/kinds` | | `200 { "items": KindInfo[] }` in palette order; `schema` and `itemSchema` are the publish-level JSON Schemas with the primitives inlined under `$defs`; `defaults` is a draft-valid starting `data` | |
| `POST /admin/pages/{id}/sections` | `{ "kind": "rich_text", "position": 2, "data": {...}, "presentation": {...} }` (`kind` required; `position` defaults to the end; `data` defaults to the kind's `defaults`; `presentation` defaults to `{ width: "wide", align: "start", background: { kind: "none" }, spacing: "normal", iconBefore: null, iconAfter: null, anchor: null }`) | `201 SectionAdmin`; later sections shift down | `404`, `400 unknown_kind`, `409 kind_not_allowed` (`allowedRoles` excludes the page's role) |
| `PATCH /admin/sections/{id}` | subset of `data`, `presentation`, `isHidden` (`kind` is immutable) | `200 SectionAdmin` | `404`, `400 validation_failed` (draft level) |
| `DELETE /admin/sections/{id}` | | `204`; items cascade; later sections close the gap | `404` |
| `POST /admin/sections/{id}/duplicate` | none | `201 SectionAdmin`: a copy with its items directly after the source | `404` |
| `POST /admin/sections/{id}/move` | `{ "pageId": 4, "position": 0 }` | `200 SectionAdmin` | `404`, `409 kind_not_allowed` |
| `PUT /admin/pages/{id}/sections/order` | `{ "ids": [...] }` (every section of the page exactly once) | `200 PageDetail` | `400`, `404` |
| `POST /admin/sections/{id}/items` | `{ "data": {...}, "position": 0 }` | `201 SectionItemAdmin` | `404`, `400` (kind has no items, or draft validation) |
| `PATCH /admin/items/{id}` | subset of `data`, `isHidden` | `200 SectionItemAdmin` | `404`, `400` |
| `DELETE /admin/items/{id}` | | `204` | `404` |
| `PUT /admin/sections/{id}/items/order` | `{ "ids": [...] }` | `200 SectionAdmin` | `400`, `404` |

`position` values are compacted to 0, 1, 2, ... after every write that changes order.

#### Site settings (Editor)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/site-settings` | | `200 SiteSettingsDraft` | |
| `PUT /admin/site-settings` | `{ "data": Partial<SiteSettings> }` (whole document, draft level) | `200 SiteSettingsDraft` | `400` |

#### Content: status, publish, versions, preview (Editor)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/content/status` | | `200 ContentStatus`: the newest version, the working set's hash, whether they differ, and every publish-level problem in the working set | |
| `GET /admin/content/draft` | | `200 ContentBundle` for the working set (what a publish would produce); the media map holds the media the document references plus sponsor logos and cookie type media icons, as in `GET /preview/document` | |
| `POST /admin/content/publish` **[snapshot]** | `{ "label": "December copy" }` (`label` null or 1 to 200 after trimming; blank is null) | `201 ContentVersionInfo`. Builds the document from the working set (hidden rows omitted, 1.3a order), validates at the publish level, inserts `content_version` with the referenced media ids, deletes versions beyond the newest 50, rebuilds the snapshot, commits, writes the live object. | `422 content_invalid` (`details.problems: ProblemRef[]`), `409 content_unchanged` (hash equals the newest version's), `502 snapshot_write_failed` |
| `GET /admin/content/versions` | | `200 { "items": ContentVersionInfo[] }` newest first | |
| `GET /admin/content/versions/{id}` | | `200 ContentVersionInfo & { "document": ContentDocument }` | `404` |
| `POST /admin/content/versions/{id}/restore` | none | `200 ContentStatus`. Replaces the working set (pages, sections, items, site settings draft) with the version's document; rows get new ids; role pages keep their roles; a place or a printed code that opens a page keeps opening the restored page with the same slug (a slug the version does not have leaves the link null, as deleting the page would). Nothing is published. | `404` |
| `POST /admin/content/preview-token` | optional `{ ttlMinutes?: integer }`, 15 to 1440, 15 when the body or the field is absent | `201 PreviewToken`: `token` is `wpv_` plus 43 base64url characters, hashed at rest, valid `ttlMinutes` minutes (`expiresAt`), reusable until expiry; `url` is `<site-base-url>/preview?token=<token>` | |

Preview: the panel loads `url` plus `&page=<slug>` in an iframe; the site's `/preview` route fetches `GET /preview/document?token=` (4.3), substitutes the bundle for `snapshot.content`, `media`, and `icons`, and renders the named page (a role page by its slug, whatever the current status) with the real live object and snapshot for the live sections. Changing a section in the panel and reloading the frame shows the change; nothing is published.

#### Media (Editor)

The pipeline is presign, upload, confirm. Media bytes never pass through the API.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/media?cursor=&limit=&kind=&state=&q=` | | `200 Page<MediaAsset>` newest first; `kind` and `state` optional filters; `q` matches `filename`, `title`, `alt` case-insensitively | |
| `POST /admin/media/upload-url` | `{ "filename": "hangar.jpg", "contentType": "image/jpeg", "sizeBytes": 1834211, "alt": "", "title": "" }` (`contentType` one of `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml`; `sizeBytes` 1 to the limit for the type; `filename` 1 to 100 after sanitizing; `alt` 0 to 500; `title` 0 to 200) | `201 UploadTicket`: a `pending` row, key `media/{id}/{filename}`, and a presigned `PUT` (15 minutes) whose signed headers are `Content-Type` and `x-amz-tagging: state=pending`; the panel must send exactly `headers` | `400`, `413` (over the type's limit) |
| `POST /admin/media/{id}/confirm` | none | `200 MediaAsset` with `state: "ready"`. The API reads the object, checks the size against the ticket and the limit, sniffs the type (must match `contentType`), validates SVG (below), decodes raster with a 40-megapixel ceiling, records `width`, `height`, `sha256`, derives `w480`, `w960`, `w1600` WebP variants for raster narrower widths than the source (never for gif or svg), cuts the Deep Zoom tile pyramid for a raster whose longest side is 2048 px or more (1.3b), PUTs them all, removes the pending tag, and updates the row. | `404` (row), `404 upload_not_found` (object missing), `409 media_not_pending`, `413`, `400 validation_failed` (sniff mismatch, SVG rules, decode failure; the object is deleted and the row removed) |
| `GET /admin/media/{id}` | | `200 MediaAsset` | `404` |
| `GET /admin/media/{id}/usage` | | `200 MediaUsage` | `404` |
| `PATCH /admin/media/{id}` **[snapshot]** | subset of `alt`, `title`, `darkMediaId` (the id of another `ready` asset, or `null` to clear), `invertInDark` (boolean), `smallMediaId` (the id of another `ready` asset, or `null` to clear), `credit` (a string of 1 to 200 characters after trimming, stored trimmed, or `null` to clear) | `200 MediaAsset` | `404` (the asset, `darkMediaId`, or `smallMediaId`), `409 media_not_ready` (`darkMediaId` or `smallMediaId` not ready), `400 validation_failed` (`darkMediaId` or `smallMediaId` is the asset itself; `credit` blank after trimming or longer than 200 characters) |
| `DELETE /admin/media/{id}` | | `204`; deletes every object under `media/{id}/` and the row, in any state; every reference is cleared first (section and item image fields, page icons, sponsor logos, tracker theme thumbnails, the site logo and favicon fall back to the library icon, and the assets whose dark or small version it is, listed as "dark version of <filename>" or "small version of <filename>"), listed under `unlinks` | `404` |

A ticket whose object never arrives expires by the bucket's lifecycle rule (tag `state=pending`, 1 day) and its row by the nightly cleanup (7.6). In use means referenced by the working set, by any retained version, by a sponsor, by a cookie type, by a tracker theme as its thumbnail (`MediaUsage.themes`), by the site settings draft, or as another asset's dark version (`MediaUsage.darkVersionOf`, shown as "dark version of <filename>").

SVG validation (library icons, uploaded SVG): the document is parsed without DTDs or external resolution and rejected with `400 validation_failed` on field `file` when the root element is not `svg`, or it contains a `script` or `foreignObject` element, any attribute whose name starts with `on`, or an `href` or `xlink:href` whose value starts with `http:`, `https:`, or `javascript:`. The stored bytes are the uploaded bytes.

Orphan collection (leader chore, 7.6): an asset that is a ready asset's dark version or small version counts as referenced; a ready asset referenced nowhere gets `unreferencedSince`; after 30 days it is tagged `state=orphaned` on every object and marked `orphaned`; the lifecycle rule deletes the objects 7 days later and the chore deletes the row after 8. A reference appearing again during those 7 days removes the tag and returns the asset to `ready`. An orphaned asset is listed by `GET /admin/media?state=orphaned` so an editor can see what is about to go.

#### Icons (Editor)

| Method and path | Success |
|---|---|
| `GET /admin/icons` | `200 { "items": IconInfo[] }`: the built-in library, ordered by `name`; `url` is the CDN URL the snapshot carries |

Uploaded icons are any ready media assets; the panel's icon picker shows the library and the media library.

#### Settings (Admin)

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/settings` | | `200 { "items": Setting[] }` (every key in section 6; defaults filled in for keys without a row, with `updatedBy` and `updatedAt` null) | |
| `PUT /admin/settings/{key}` **[snapshot]** | `{ "value": 5000 }` | `200 Setting` | `400 validation_failed` (unknown key, wrong type, or out of range) |

#### Help (Editor read, Admin write)

Every page, card, and dialog of the admin panel has a help popover whose text lives in `help_topic`, one row per entry of `help/topics.json` in the API repository (keys listed in `contracts/help-keys.json`, 13). Every boot rewrites the seed's text as the row's defaults and shows it until an admin edits the topic; an edit survives later boots, and `defaultChanged` tells the panel the seed moved on since. A key the seed drops is deleted. The group rides the `help` capability (3.6); the reads are Editor, the writes Admin. Nothing here is snapshot-affecting; help topics are never public.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/help` | | `200 { "items": HelpTopic[] }` every topic, ordered by `page` then `key` (ordinal) | |
| `PUT /admin/help/{key}` | `{ "title": "What the dashboard shows", "body": "...", "links": [ { "label": "Events", "to": "/events" } ] }` (`title` 1 to 120, `body` 1 to 2000, `links` an array of 0 to 6 with `label` 1 to 60 and `to` a path starting with one `/` or an `https://` URL; every string trimmed; an em dash or en dash in any of them is refused) | `200 HelpTopic` with `edited` true; `editedBy` the actor, `editedAt` now; audit action `update` | `400 validation_failed` on the field (`title`, `body`, `links`, `links[i].label`, `links[i].to`), `404` (unknown key) |
| `POST /admin/help/{key}/reset` | | `200 HelpTopic`: title, body, and links back to the seed's, `edited` false, `editedBy` and `editedAt` null; audit action `reset` | `404` |

#### Contact messages, subscribers, people (Admin)

| Method and path | Success |
|---|---|
| `GET /admin/contact-messages?cursor=&limit=` | `200 Page<ContactMessage>` newest first |
| `DELETE /admin/contact-messages/{id}` | `204` |
| `GET /admin/subscribers?cursor=&limit=&status=verified\|pending\|unsubscribed` | `200 Page<SubscriberAdmin>` newest first (`status` optional) |
| `GET /admin/subscribers/summary` | `200 { "verified": 812, "pending": 40, "unsubscribed": 12 }` |
| `DELETE /admin/subscribers/{id}` | `204` (hard delete; the person may subscribe again) |
| `GET /admin/people?cursor=&limit=` | `200 Page<Person & { cookieCount: number }>` (`cookieCount` over all events) |
| `DELETE /admin/people/{id}` | `204`; deletes the person's subscriber rows and cookies, then the row; the Cognito user is removed separately in the console |

Contact messages and cookie notes have no automatic retention; they stay until an admin deletes them.

#### Email quota (Admin)

| Method and path | Success |
|---|---|
| `GET /admin/email/quota` | `200 EmailQuota` |

```ts
type EmailQuota = { available: boolean; dryRun: boolean; max24HourSend: number | null; sentLast24Hours: number | null; maxSendRate: number | null; queued: number; remaining: number | null; verifiedSubscribers: number; wouldExceed: boolean; fetchedAt: string };
```

`max24HourSend`, `sentLast24Hours`, and `maxSendRate` come from the SES v2 `GetAccount` call (its `SendQuota`), read through the instance role and cached in the node's memory for 60 seconds; `max24HourSend` is null when SES reports no limit (its value of -1). `queued` counts `alert_delivery` rows with `sent_at is null`. `verifiedSubscribers` counts `subscriber` rows with `channel = 'email' and verified_at is not null and unsubscribed_at is null`, the same people an alert goes to (7.7). `remaining` is `max24HourSend - sentLast24Hours - queued`, never below 0, and null when there is no limit. `wouldExceed` is true when `remaining` is not null and `verifiedSubscribers > remaining`: one more alert to every subscriber would not fit. When the SES call fails, or the API runs with `WMSFO_SES_DRY_RUN=true` and so has no SES client, the answer is still `200` with `available: false`, the three SES numbers and `remaining` null, `wouldExceed` false, and `queued` and `verifiedSubscribers` filled in; `dryRun` repeats the setting. The window is rolling, so the numbers are a snapshot at `fetchedAt` and the panel reads them again before every send. The endpoint reads nothing else, writes nothing, and records no audit row. Groups `admin` and `editor`, like the rest of 4.5; API keys cannot call it.

#### Snapshot and live diagnostics (Admin)

| Method and path | Success |
|---|---|
| `GET /admin/snapshot` | `200 SnapshotInfo` |
| `POST /admin/snapshot/rebuild` **[snapshot]** | `200 SnapshotInfo` (rebuilds from the database even when nothing changed; version increments even when the content hash is unchanged) |
| `GET /admin/live` | `200 { "lastWriteAt": rfc3339 or null, "lastWriteSeq": int64 or null, "lastWriteVersion": int64 or null, "lastWriteError": string or null, "lastWriteNode": string or null, "node": { "instance": "<gateway instanceId or null>", "isLeader": bool, "leaderEvaluatedAt": rfc3339 or null, "cacheRefreshedAt": rfc3339, "live": LiveObject } }` (the top-level fields are the fleet-wide `live_state` row, section 5; `node` is the answering node's memory, including its in-memory live object) |
| `POST /admin/live/republish` | `200 LiveObject` (this node refreshes from SQL, writes the live object, publishes) |

### 4.5a QR codes and places

Printed stickers and the places they hang in (site.md 4 for the public route, admin.md 6.23 to 6.25 for the panel). A **code** is a permanent tag (`qr-001`, sequential) printed at `https://<site-domain>/q/<tag>`; a **place** is a node of a tree of friendly names, any depth, with a note and an optional pin; an **attachment** says which place a code hangs in from when to when; a **scan** is one visit to the printed address. Codes and places each may set what a visit opens: a site page or an off-site URL; a code resolves its own setting, else the nearest ancestor place's, else the home page. The snapshot carries every active code already resolved (1.3), so the site never asks the API what to show.

**Roles.** The admin pool's third group is `canvasser` (3.1). The `Canvasser` policy admits `admin`, `editor`, and `canvasser` to every route in this section except the two deletes, which stay `Admin`. TOTP as for every admin route. API keys reach these routes with the `qr` capability (3.6).

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/qr-codes` | | `200 { "items": QrCode[] }` by tag | |
| `POST /admin/qr-codes` | `{ "count": 10 }` (1 to 100) | `201 { "items": QrCode[] }`: the next tags minted in a new batch (`batchNo` one past the highest, `printedAt` now), unattached, active, opening the home page | `400 validation_failed` |
| `GET /admin/qr-codes/{id}` | | `200 QrCodeDetail` (the code, its attachment history with the people count of each stay, the daily counts of the last 14 days) | `404` |
| `PATCH /admin/qr-codes/{id}` **[snapshot]** | any of `opensPageId` (a page id, or null for "same as the place"), `forwardUrl` (an absolute https URL, or null), `note` (0 to 500), `active` | `200 QrCode`; `opensPageId` and `forwardUrl` cannot both be set (`400`) | `404`, `400 validation_failed` |
| `POST /admin/qr-codes/{id}/attach` **[snapshot]** | `{ "placeId": 4 }` | `200 QrCode`: closes the open attachment (`toAt = now`) and opens a new one; scans of this code from the hour before with no attachment are stamped onto the new one | `404` (code or place) |
| `POST /admin/qr-codes/{id}/detach` **[snapshot]** | none | `200 QrCode` (idempotent) | `404` |
| `DELETE /admin/qr-codes/{id}` **[snapshot]**, admin only | | `204`; its attachments and scans go with it | `404` |
| `GET /admin/places` | | `200 { "items": Place[] }` in tree order (parents before children, siblings by name), each with its resolved pin and opens | |
| `POST /admin/places` **[snapshot]** | `{ "parentId": null, "name": "Southgate Mall", "description": "Main level, both wings", "opensPageId": null, "forwardUrl": null }` (`name` 1 to 120 unique among siblings, `description` 0 to 500) | `201 Place` | `400 validation_failed`, `404` (parent), `409 place_name_taken` |
| `PATCH /admin/places/{id}` **[snapshot]** | any of `parentId` (null for the root), `name`, `description`, `opensPageId`, `forwardUrl` | `200 Place` | `404`, `400 place_cycle` (a place cannot move under itself or its descendants), `409 place_name_taken` |
| `PUT /admin/places/{id}/location` | `{ "lat": 46.916, "lng": -114.039, "accuracyM": 140, "source": "phone" }` (`source` one of `phone`, `search`, `drag`; `accuracyM` null unless `phone`) | `200 Place` | `404`, `400 validation_failed` |
| `DELETE /admin/places/{id}/location` | | `200 Place` (no pin; the parent's applies) | `404` |
| `DELETE /admin/places/{id}` **[snapshot]**, admin only | | `204`: cascades, deleting the place and every place under it as the impact preview lists; open attachments in the subtree close (their codes become unattached), every stay keeps its history row with `placeId` null | `404` |
| `GET /admin/places/map?eventId=&from=&to=` | | `200 { "items": PlacePin[] }`: one entry per pinned place with the people count under it (the subtree's scans in the window, attributed by the scan's event when `eventId` is given), plus `unpinned` (places with scans and no resolved pin) and `unattached` (scans on codes with no attachment) counts | `400 validation_failed` |

Not snapshot-affecting: the location PUT and DELETE (pins never reach the site) and everything under `/qr-codes/{tag}/scans`.

**Public.** `POST /qr-codes/{tag}/scans` (4.3): no auth, body `{ "referrer": "https://..." }` optional; the API records the scan against the code and its open attachment with the user agent, the referrer, a salted hash of the client IP, and the current event's id; flags `isBot` from the user agent (a fixed list of crawler markers) and `isRepeat` when the same IP hash and user agent scanned the same code within ten seconds; answers `204` whether or not the tag exists or is active, so the address reveals nothing. Rate limit as `POST /contact`. Counts everywhere are unflagged rows ("people").

**Resolution.** `opens` on a code or place is one of: a page (`opensPageId` naming a non-hidden `none` page or a role page's slug `/`), a forward (`forwardUrl`), or unset. A code resolves its own setting, else the nearest ancestor of its open attachment's place that sets one (the attached place first), else the home page. A place's pin resolves the same way: its own, else the nearest ancestor's, else none.

```ts
type Opens = { kind: "home" } | { kind: "page"; pageId: number; slug: string } | { kind: "url"; url: string };
type QrCode = { id: number; tag: string; batchNo: number; printedAt: string; active: boolean; note: string;
                opensPageId: number | null; forwardUrl: string | null; opens: Opens; opensSource: "code" | "place" | "home";
                attachment: { id: number; placeId: number; placePath: string[]; since: string } | null;
                scans: { people: number; flagged: number; lastScanAt: string | null };
                createdBy: string; createdAt: string; updatedAt: string; audit: AuditStamp | null };
type QrCodeDetail = QrCode & { history: { attachmentId: number; placeId: number | null; placePath: string[]; fromAt: string; toAt: string | null; people: number; earlyScans: number }[];
                               daily: { day: string; people: number }[] };
type Place = { id: number; parentId: number | null; name: string; description: string; path: string[];
               opensPageId: number | null; forwardUrl: string | null; opens: Opens; opensSource: "place" | "ancestor" | "home";
               location: { lat: number; lng: number; accuracyM: number | null; source: "phone" | "search" | "drag"; pinnedBy: string; pinnedAt: string } | null;
               pin: { lat: number; lng: number; fromPlaceId: number } | null;
               codes: { id: number; tag: string }[]; scans: { people: number };   // the subtree
               createdBy: string; createdAt: string; updatedAt: string; audit: AuditStamp | null };
type PlacePin = { placeId: number; name: string; path: string[]; lat: number; lng: number; people: number;
                  codes: { tag: string; placeName: string; people: number }[] };
```

**Delete impact.** Deletes never refuse because something depends on the row; they take the dependents with them or unlink them, and every delete has a preview so the caller sees that first. `GET /admin/<resource>/{id}/impact` answers `200 DeleteImpact` (`404` when the row is gone) for `events`, `routes`, `maps`, `themes`, `sponsors`, `cookie-types`, `pages`, `media`, `places`, `qr-codes`, `beacons`, `api-keys`, `subscribers`, `people`, `contact-messages`, and `posters`: `deletes` lists what goes with the row (an entity kind per group, its count, up to ten names), `unlinks` what stays but loses its reference to the row, and `warnings` the plain sentences the panel shows above the counts (the page holds a role, the beacon is active, a cookie tally drops while live). The preview and the delete run the same queries, so what the preview lists is what the delete does. The refusals: the live event and the current event cannot be deleted; their preview answers `blocked` with the sentence ("This event is live. End it first.", "This is the current event. Make another event current first.") and the delete answers `409 event_live` or `409 event_current`; and a `google` theme that is the only enabled Google theme on some event cannot be deleted without a `google` replacement ("This is the only Google theme enabled on <event name>. Enable another there first.", `409 last_google_theme`, 4.5 Themes). Every other resource answers `blocked` null. A map or theme delete takes an optional `replacementId` in its body, which repoints the unlinked events to another row instead of unlinking them (4.5 Maps and Themes); the preview is the same either way. The delete's audit row carries, in `before`, the DTO plus the `impact` it applied; the cascaded rows get no rows of their own.

**Audit.** Every admin write (every `POST`, `PATCH`, `PUT`, `DELETE` under `/admin/*`, whoever the caller is) records one `audit_log` row inside its own transaction: the actor (`person:<email>` for an ID token, `key:<name>` for an API key), the action, the entity kind and id, the resource as it was before and as it is after (the same shapes the endpoints answer with; `before` is null on create, `after` is null on delete), and the request id. Endpoints with their own verbs name them as the action; seeding cookies (`POST /admin/events/{id}/cookies`) records `cookies_seeded` on entity `event` with the request's items and the total in `after`. Lists and details of audited resources carry `audit: AuditStamp | null` (the newest row for that entity; null for a row older than the log).

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/audit?entity=&entityId=&action=&actor=&cursor=&limit=` | | `200 Page<AuditEntry>` newest first, `limit` 1 to 200 (default 50); every filter optional; `entity` and `entityId` together give one row's history; `action=delete` alone lists what was deleted anywhere | `400 validation_failed` |
| `GET /admin/audit/entities` | | `200 { "items": string[] }`: the entity kinds the log knows | |

Actions are `create`, `update`, `delete` for the generic writes and the endpoint's own verb otherwise: `status`, `notify`, `current`, `clone`, `activate`, `deactivate`, `revoke`, `rotate`, `order`, `copy`, `import`, `confirm`, `publish`, `restore`, `move`, `duplicate`, `enroll`, `reset`, `parts`, `complete`, `sprite`, `default`. Entities: `event`, `event_message`, `route`, `tracker_map`, `tracker_theme`, `beacon`, `sponsor`, `sponsor_year`, `sponsor_order`, `cookie_type`, `api_key`, `person`, `subscriber`, `contact_message`, `setting`, `page`, `section`, `section_item`, `site_settings`, `content_version`, `media_asset`, `qr_code`, `place`, `poster`, `help_topic`. The log is never pruned.

### 4.6 Internal gateway callbacks

`POST /realtime/authorize` and `POST /realtime/message`: contracts in 2.4 and 2.5, protection in 3.5. No credential, no rate limit, `404` empty body when proxied.

### 4.7 Error codes

| Code | Status | Where |
|---|---|---|
| `validation_failed` | 400 | any body, query, or header |
| `unauthenticated` | 401 | missing, invalid, expired, or revoked credential (an expired or revoked API key included) |
| `forbidden` | 403 | wrong role or group; an API key without the endpoint's capability; message path rules |
| `mfa_required` | 403 | `/admin/*` when the user has no TOTP enabled (3.1) |
| `not_found` | 404 | unknown id, unknown subscription token |
| `enrollment_token_invalid` | 404 | `POST /beacons/enroll` |
| `no_live_event` | 409 | `POST /locations`, `POST /cookies`, message path |
| `cookie_limit_reached` | 409 | `POST /cookies` |
| `address_taken`, `already_subscribed`, `already_verified` | 409 | subscriptions |
| `event_status_unchanged`, `event_not_current`, `another_event_live`, `scheduled_at_required`, `no_healthy_beacon` | 409 | `POST /admin/events/{id}/status`; `scheduled_at_required` also on `PATCH /admin/events/{id}` |
| `current_event_live` | 409 | `POST /admin/events/{id}/current` |
| `event_live` | 409 | cookie type writes while an event is live; deleting a live event |
| `event_not_live` | 409 | `POST /admin/events/{id}/cookies` on an event whose status is not 3 |
| `year_taken` | 409 | event create, patch, and clone |
| `package_exists` | 409 | `POST /admin/maps` when a `ready` map has the package key; `parts`, `complete`, and `confirm` on a map that is already `ready` |
| `package_invalid` | 409 | `POST /admin/maps/{id}/confirm` when an archive does not match the row (`details.field`, `details.reason`) |
| `last_google_theme` | 409 | `DELETE /admin/themes/{id}` on the only enabled Google theme of some event without a `google` replacement (the impact's `blocked` case) |
| `place_cycle` | 400 | `PATCH /admin/places/{id}` moving a place under itself |
| `place_name_taken` | 409 | place create and patch (unique among siblings) |
| `year_exists` | 409 | `POST /admin/sponsors/{id}/years/{eventYear}/copy-from/{sourceYear}` when the sponsor already has `eventYear` |
| `pinned_position_taken` | 409 | `PUT /admin/sponsors/{id}/years/{eventYear}` |
| `name_taken` | 409 | `POST /admin/api-keys` |
| `beacon_revoked` | 409 | activate and rotate on a revoked beacon |
| `slug_reserved` | 400 | page create and patch |
| `unknown_kind` | 400 | section create |
| `slug_taken` | 409 | page create and patch |
| `role_needs_page` | 400 | `DELETE /admin/pages/{id}` on a role page without `roleTo`, or with a `roleTo` page whose role is not `none` |
| `kind_not_allowed` | 409 | section create and move onto a page whose role the kind excludes |
| `content_unchanged` | 409 | `POST /admin/content/publish` |
| `content_invalid` | 422 | `POST /admin/content/publish`; `details.problems` |
| `media_not_ready` | 409 | a sponsor, cookie type, tracker theme thumbnail, dark version, or small version references a media asset that is not `ready` |
| `media_not_pending` | 409 | confirm on a non-pending asset |
| `upload_not_found` | 404 | a media, map, or sprite confirm when an object never arrived |
| `preview_token_invalid` | 404 | `GET /preview/document` |
| `payload_too_large` | 413 | body limits |
| `unsupported_media_type` | 415 | uploads |
| `rate_limited` | 429 | rate limit table |
| `internal_error` | 500 | unhandled |
| `upstream_failed` | 502 | generic S3, SES, gateway failure |
| `snapshot_write_failed`, `route_write_failed`, `media_write_failed` | 502 | S3 PUT inside an admin transaction or a media confirm |
| `unavailable` | 503 | `GET /api/health` |

---

## 5. Data model

One schema, `public`, in database `wmsfo_dev` or `wmsfo_prod` on the shared RDS instance. Two roles per environment (`sql.md` section 12): `wmsfo_migrate_<env>` owns the database and runs migrations and the migration tool; `wmsfo_app_<env>` serves every request, tick, and chore and can only select, insert, update, and delete. Both `LOGIN`, `NOSUPERUSER NOCREATEDB NOCREATEROLE`. The RDS master user creates the database and the roles and is never used by the API. Migrations are EF Core, applied on boot over the migrate connection under `pg_advisory_lock(hashtext('wmsfo_migrations'))`; a node that finds no `snapshot` row after migrating builds version 1 under the same lock and writes the live object. If the version 1 snapshot PUT fails, the node releases the lock, answers `503 unavailable`, and retries the build every 5 s until it succeeds. The live-object PUT on first boot follows the admin-path rule (three attempts one second apart, then `live_state.last_write_error`) and does not gate health.

```sql
create table event_status (
  id   smallint primary key,
  name text not null unique
);
insert into event_status (id, name) values
  (1, 'planned'), (2, 'scheduled'), (3, 'live'), (4, 'ended'), (5, 'cancelled'), (6, 'postponed');

create table route (
  id          bigint generated always as identity primary key,
  name        text not null,
  s3_key      text not null unique,
  url         text not null,
  sha256      char(64) not null,
  point_count integer not null,
  uploaded_by text not null,
  created_at  timestamptz not null default now()
);

create table event (
  id            bigint generated always as identity primary key,
  year          integer not null unique,
  name          text not null,
  status_id     smallint not null references event_status (id),
  is_current    boolean not null default false,
  scheduled_at  timestamptz,
  schedule_time_zone text,                        -- admin only: IANA zone id scheduled_at was entered in; null means unset; alert emails render in it (7.8)
  went_live_at  timestamptz,
  ended_at      timestamptz,
  funds_percent integer not null default 0 check (funds_percent between 0 and 100),
  route_id      bigint references route (id) on delete set null,    -- flight recording (1.4), never public
  final_cookie_tally jsonb,                       -- set on entry into status 4, null otherwise (1.2)
  status_notified_at timestamptz,                 -- when the current status was last announced; cleared by every status change (4.5)
  next_seq      bigint not null default 1,
  latest_fix    jsonb,                            -- the last published fix on this event, stored or carried, set in the same update that advances next_seq (1.2, 7.2); nulled by DELETE /admin/events/{id}/locations (4.5)
  route_map_config jsonb,                         -- the event's RouteMapConfig in canonical form, validated on write (1.3, 4.5); null means every built-in default
  tracker_bbox  jsonb not null default '{"west":-114.75,"south":46.35,"east":-113.30,"north":47.25}'::jsonb,   -- { west, south, east, north }, required (1.3); the default exists only for a rolled-back API that does not know the column
  tracker_map_id bigint references tracker_map (id) on delete set null,   -- the ready tile package whose bbox contains tracker_bbox (4.5 Maps); null means Google Maps for every viewer
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index event_one_live    on event (status_id) where status_id = 3;
create unique index event_one_current on event (is_current) where is_current;

create table poster (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 1 and 200),
  route_id   bigint references route (id) on delete set null,   -- the recording the poster's map is built from; a route delete unlinks it (4.5 Routes)
  layout     jsonb,                                            -- admin only: the panel's poster composer layout, an opaque object of at most 32 KB canonical (4.5 Posters); never in the snapshot
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tracker_map (
  id            bigint generated always as identity primary key,
  name          text not null check (char_length(name) between 1 and 200),
  package_key   text not null unique,         -- sha256 of the canonical { bbox, minZoom, maxZoom, terrainMaxZoom } (1.1); 409 package_exists when a ready row has it
  prefix        text not null unique,         -- maps/{package_key}; basemap for the seeded Missoula valley row, whose objects the operator placed by hand (platform.md 1.8)
  bbox          jsonb not null,               -- { west, south, east, north }, at most 20 degrees on a side
  min_zoom      smallint not null check (min_zoom between 0 and 15),
  max_zoom      smallint not null check (max_zoom between 8 and 15),
  terrain_max_zoom smallint check (terrain_max_zoom between 8 and 13),   -- null: no terrain archive
  tiles_bytes   bigint,
  terrain_bytes bigint,
  source_build  date,                         -- the basemap build date the vector tiles came from
  state         text not null check (state in ('pending', 'ready')),   -- ready once confirm verified the objects; only ready maps can be picked by an event
  built_at      timestamptz,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_by    text not null,
  updated_at    timestamptz not null default now()
);

create table tracker_theme (
  id                 bigint generated always as identity primary key,
  renderer           text not null check (renderer in ('google', 'maplibre')),
  key                text not null check (key ~ '^[a-z][a-z0-9-]{1,39}$'),   -- the stable slug the viewer's stored choice names
  name               text not null check (char_length(name) between 1 and 60),
  sort_order         integer not null default 0,
  style_sha256       text not null,            -- the style body is themes/{style_sha256}.json on the CDN (1.1)
  style_bytes        integer not null,
  sprite_sha256      text,                     -- the confirmed sprite set's index hash: the prefix themes/{id}/sprites/{sprite_sha256}/ (maplibre only); null without one
  chrome             jsonb not null,           -- { bg, fg, text, tile, tileFg, panel, accent } (1.3)
  overlay            jsonb not null,           -- { routeColor, routeOpacity, arrowColor, timeLabelBg, timeLabelFg, timeLabelOpacity, userColor } (1.3)
  thumbnail_media_id uuid references media_asset (id) on delete set null,   -- counted by the orphan chore, media usage, and the media impact (7.6)
  default_light_mode boolean not null default false,
  default_dark_mode  boolean not null default false,
  created_by         text not null,
  created_at         timestamptz not null default now(),
  updated_by         text not null,
  updated_at         timestamptz not null default now(),
  unique (renderer, key)
);
create unique index tracker_theme_one_default_light on tracker_theme (renderer) where default_light_mode;
create unique index tracker_theme_one_default_dark  on tracker_theme (renderer) where default_dark_mode;

create table event_tracker_theme (            -- the themes an event offers; at least one google theme per event (4.5 Events)
  event_id bigint not null references event (id) on delete cascade,
  theme_id bigint not null references tracker_theme (id) on delete cascade,
  primary key (event_id, theme_id)
);

create table tracker_theme_state (            -- single row: the first-boot step that writes the seeded themes' style objects is keyed on it (sql.md 8.16)
  id         smallint primary key check (id = 1),
  written_at timestamptz
);

create table help_topic (
  key                text primary key,                    -- the seed key from help/topics.json
  page               text not null,                       -- from the seed, rewritten every boot
  label              text not null,                       -- from the seed, rewritten every boot
  title              text not null,                       -- shown: default_title while edited_by is null, else the admin's
  body               text not null,
  links              jsonb not null default '[]',         -- HelpLink[]
  default_title      text not null,                       -- the seed's text, rewritten every boot
  default_body       text not null,
  default_links      jsonb not null default '[]',
  default_updated_at timestamptz not null,                -- moves only when a default changed
  edited_by          text,                                -- null while the seed's text is shown
  edited_at          timestamptz,
  updated_at         timestamptz not null default now()
);

create table event_status_history (
  id             bigint generated always as identity primary key,
  event_id       bigint not null references event (id) on delete cascade,
  from_status_id smallint references event_status (id),
  to_status_id   smallint not null references event_status (id),
  changed_by     text not null,
  changed_at     timestamptz not null default now(),
  notify         boolean not null default false,  -- the admin asked for subscribers to be told
  message_id     bigint references event_message (id) on delete set null,   -- the event message posted with the change; its body replaces the stock paragraph
  outbox_id      bigint references outbox (id) on delete set null,   -- the alert's outbox row while it exists
  sent_count     integer not null default 0        -- alert emails sent for this row, kept by the alert-send chore, survives the outbox row
);
create index event_status_history_event on event_status_history (event_id, changed_at desc);

create table event_message (
  id         bigint generated always as identity primary key,
  event_id   bigint not null references event (id) on delete cascade,
  body       text not null,
  created_by text not null,
  created_at timestamptz not null default now(),   -- the time the message was sent, its only time
  updated_at timestamptz not null default now(),
  notify     boolean not null default false,       -- posted with notify from the message form
  outbox_id  bigint references outbox (id) on delete set null,   -- its event.message_posted outbox row while it exists
  sent_count integer not null default 0            -- alert emails sent for this message, kept by the alert-send chore, survives the outbox row
);
create index event_message_event_created on event_message (event_id, created_at desc);

create table beacon (
  id                 bigint generated always as identity primary key,
  name               text not null,
  notes              text not null default '',
  key_hash           bytea not null unique,
  key_prefix         text not null,
  key_version        integer not null default 1,   -- incremented by rotate; carried in the hub identity (2.4)
  is_active          boolean not null default false,
  revoked_at         timestamptz,
  last_seen_at       timestamptz,
  last_location_at   timestamptz,
  last_heartbeat_at  timestamptz,
  stale_since        timestamptz,
  telemetry          jsonb,
  min_interval_ms    integer,                        -- overrides location_min_interval_ms; null means the setting (contracts 4.2, 7.2)
  hub_allowed        boolean not null default true,  -- false: the authorize callback denies the join (2.4) and the message path answers 403 (2.5)
  fixes_stored       bigint not null default 0,
  fixes_carried      bigint not null default 0,
  fixes_rate_limited bigint not null default 0,
  created_by         text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index beacon_one_active on beacon (is_active) where is_active;

create table beacon_enrollment_token (
  id             bigint generated always as identity primary key,
  beacon_id      bigint not null references beacon (id) on delete cascade,
  token_hash     bytea not null unique,
  key_ciphertext bytea,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);

create table beacon_log (
  id          bigint generated always as identity primary key,
  beacon_id   bigint not null references beacon (id) on delete cascade,
  received_at timestamptz not null default now(),
  app_version text,
  size_bytes  integer not null,
  body        text not null
);
create index beacon_log_beacon on beacon_log (beacon_id, received_at desc);

create table location (
  id           bigint generated always as identity primary key,
  event_id     bigint not null references event (id) on delete cascade,
  beacon_id    bigint not null references beacon (id),
  seq          bigint not null,
  recorded_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  lat          double precision not null,
  lng          double precision not null,
  speed_mps    double precision,
  speed_source text,                          -- 'beacon' when the body carried speedMps, 'derived' when the API computed it, null otherwise (contracts 7.2)
  altitude_m   double precision,
  heading_deg  double precision,
  accuracy_m   double precision,
  published    boolean not null,
  unique (event_id, seq)
);
create index location_event_published_seq on location (event_id, seq desc) where published;
create index location_event_beacon_seq    on location (event_id, beacon_id, seq desc);

create table media_asset (
  id                 uuid primary key,
  filename           text not null,
  content_type       text not null,
  kind               text not null check (kind in ('raster', 'svg', 'gif')),
  state              text not null check (state in ('pending', 'ready', 'orphaned')),
  s3_key             text not null unique,
  size_bytes         bigint,
  width              integer,
  height             integer,
  sha256             char(64),
  variants           jsonb not null default '{}',   -- { "480": "media/<id>/w480.webp", ... }
  dzi_key            text,                          -- media/<id>/dzi/poster.dzi when a tile pyramid exists (1.3b)
  alt                text not null default '',
  title              text not null default '',
  uploaded_by        text not null,
  created_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  unreferenced_since timestamptz,
  orphaned_at        timestamptz
);
create index media_asset_state_created on media_asset (state, created_at);

create table sponsor (
  id                bigint generated always as identity primary key,
  name              text not null,
  contact_person    text,
  email             text,
  phone             text,
  address           text,
  website_url       text,
  fb_url            text,
  ig_url            text,
  logo_media_id     uuid references media_asset (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table sponsor_year (
  id             bigint generated always as identity primary key,
  sponsor_id     bigint not null references sponsor (id) on delete cascade,
  event_year     integer not null,
  amount_donated numeric(12,2) check (amount_donated >= 0),
  active         boolean not null default true,
  can_advertise  boolean not null default true,
  anonymous      boolean not null default false,
  pinned_position    integer check (pinned_position between 1 and 1000),
  linger_ms_override integer check (linger_ms_override between 0 and 600000),
  registered_at  timestamptz not null default now(),
  unique (sponsor_id, event_year)
);
create unique index sponsor_year_pinned_ux on sponsor_year (event_year, pinned_position) where pinned_position is not null;
create table api_key (
  id               bigint generated always as identity primary key,
  name             text not null,
  key_prefix       text not null,
  key_hash         bytea not null unique,
  all_capabilities boolean not null default false,
  capabilities     text[] not null default '{}',
  expires_at       timestamptz,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
create unique index api_key_name_ux on api_key (name) where revoked_at is null;

create table person (
  id           bigint generated always as identity primary key,
  cognito_sub  uuid not null unique,
  email        text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table subscriber (
  id                bigint generated always as identity primary key,
  person_id         bigint not null references person (id) on delete cascade,
  channel           text not null check (channel in ('email', 'sms')),
  address           text not null,                -- stored trimmed and lowercased (4.4)
  verify_token_hash bytea,                        -- sha256 of the last minted verify token; kept after verification until the next mint
  verify_expires_at timestamptz,
  verified_at       timestamptz,
  unsubscribe_token text not null unique,
  unsubscribed_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (channel, address)
);
create index subscriber_person on subscriber (person_id);

create table cookie_type (
  id         bigint generated always as identity primary key,
  name       text not null,
  icon       jsonb,                                  -- Icon value (1.3a) or null
  sort       integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cookie (
  id             bigint generated always as identity primary key,
  event_id       bigint not null references event (id) on delete cascade,
  person_id      bigint not null references person (id) on delete cascade,
  cookie_type_id bigint not null references cookie_type (id) on delete cascade,
  note           text,
  left_at        timestamptz not null default now(),
  hidden_at      timestamptz,   -- always null: moderation was removed; the columns stay so the index and the tally query are unchanged
  hidden_by      text
);
create index cookie_event_person       on cookie (event_id, person_id);
create index cookie_event_type_visible on cookie (event_id, cookie_type_id) where hidden_at is null;

create table contact_message (
  id         bigint generated always as identity primary key,
  name       text not null,
  email      text not null,
  body       text not null,
  client_ip  text not null,
  created_at timestamptz not null default now()
);

create table app_setting (
  key        text primary key,
  value      jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table snapshot (
  id       smallint primary key check (id = 1),
  version  bigint not null,
  url      text not null,
  s3_key   text not null,
  built_at timestamptz not null
);

create table live_state (
  id                 smallint primary key check (id = 1),
  last_write_at      timestamptz,
  last_write_seq     bigint,
  last_write_version bigint,
  last_write_error   text,
  last_write_node    text
);
insert into live_state (id) values (1);

create table outbox (
  id           bigint generated always as identity primary key,
  topic        text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  published_at timestamptz,
  attempts     integer not null default 0,
  last_error   text
);
create index outbox_unpublished on outbox (id) where published_at is null;

create table alert_delivery (
  id             bigint generated always as identity primary key,
  outbox_id      bigint not null references outbox (id) on delete cascade,
  subscriber_id  bigint not null references subscriber (id) on delete cascade,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  ses_message_id text,
  attempts       integer not null default 0,
  last_error     text,
  unique (subscriber_id, outbox_id)
);
create index alert_delivery_unsent on alert_delivery (id) where sent_at is null;

create table page (
  id           bigint generated always as identity primary key,
  slug         text not null unique,
  title        text not null,
  nav_label    text,
  icon         jsonb,                     -- Icon value (1.3a) or null
  nav_position integer not null default 0,
  is_hidden    boolean not null default false,
  role         text not null default 'none'
               check (role in ('none', 'no_event', 'planned', 'scheduled', 'live', 'ended', 'cancelled', 'postponed')),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_by   text not null,
  updated_at   timestamptz not null default now()
);
create unique index page_one_per_role on page (role) where role <> 'none';

create table section (
  id           bigint generated always as identity primary key,
  page_id      bigint not null references page (id) on delete cascade,
  kind         text not null,
  position     integer not null,
  is_hidden    boolean not null default false,
  data         jsonb not null default '{}',
  presentation jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_by   text not null,
  updated_at   timestamptz not null default now()
);
create index section_page_position on section (page_id, position, id);

create table section_item (
  id         bigint generated always as identity primary key,
  section_id bigint not null references section (id) on delete cascade,
  position   integer not null,
  is_hidden  boolean not null default false,
  data       jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_at timestamptz not null default now()
);
create index section_item_section_position on section_item (section_id, position, id);

create table site_setting_draft (
  id         smallint primary key check (id = 1),
  data       jsonb not null default '{}',
  updated_by text,
  updated_at timestamptz
);
insert into site_setting_draft (id) values (1);

create table content_version (
  id           bigint generated always as identity primary key,
  document     jsonb not null,                     -- ContentDocument (1.3a), exactly what the snapshot carries
  sha256       char(64) not null,                  -- of the canonical bytes of document
  media_ids    uuid[] not null default '{}',       -- every media asset the document references
  label        text,
  published_by text not null,
  published_at timestamptz not null default now()
);

create table preview_token (
  id         bigint generated always as identity primary key,
  token_hash bytea not null unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table icon_library_state (
  id             smallint primary key check (id = 1),
  library_sha256 char(64),
  written_at     timestamptz
);
insert into icon_library_state (id) values (1);

create table audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,                    -- person:<email> or key:<name>
  action     text not null,                    -- create, update, delete, or the endpoint's verb (4.5 Audit)
  entity     text not null,                    -- the entity kind (4.5 Audit)
  entity_id  text not null,                    -- the row's id as text (uuid for media, a setting's key, the year for a sponsor order)
  before     jsonb,                            -- the resource before the write, null on create
  after      jsonb,                            -- the resource after the write, null on delete
  request_id text
);
create index audit_log_entity on audit_log (entity, entity_id, id desc);
create index audit_log_action on audit_log (action, id desc);

create table place (
  id            bigint generated always as identity primary key,
  parent_id     bigint references place (id) on delete cascade,
  name          text not null,
  description   text not null default '',
  opens_page_id bigint references page (id) on delete set null,
  forward_url   text,
  lat           double precision,
  lng           double precision,
  accuracy_m    double precision,
  pin_source    text check (pin_source in ('phone', 'search', 'drag')),
  pinned_by     text,
  pinned_at     timestamptz,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((opens_page_id is null) or (forward_url is null)),
  check ((lat is null) = (lng is null) and (lat is null) = (pin_source is null))
);
create unique index place_sibling_name on place (coalesce(parent_id, 0), lower(name));

create table qr_code (
  id            bigint generated always as identity primary key,
  tag           text not null unique,             -- qr-001, sequential
  batch_no      integer not null,
  printed_at    timestamptz not null default now(),
  active        boolean not null default true,
  note          text not null default '',
  opens_page_id bigint references page (id) on delete set null,
  forward_url   text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((opens_page_id is null) or (forward_url is null))
);

create table qr_attachment (
  id          bigint generated always as identity primary key,
  qr_code_id  bigint not null references qr_code (id) on delete cascade,
  place_id    bigint references place (id) on delete set null,
  from_at     timestamptz not null default now(),
  to_at       timestamptz,
  attached_by text not null
);
create unique index qr_attachment_open on qr_attachment (qr_code_id) where to_at is null;
create index qr_attachment_place on qr_attachment (place_id, from_at desc);

create table qr_scan (
  id            bigint generated always as identity primary key,
  qr_code_id    bigint not null references qr_code (id) on delete cascade,
  attachment_id bigint references qr_attachment (id) on delete set null,
  event_id      bigint references event (id) on delete set null,
  at            timestamptz not null default now(),
  user_agent    text,
  referrer      text,
  ip_hash       char(64) not null,                   -- sha256 of salt and client IP; the salt is WMSFO_SCAN_SALT
  is_bot        boolean not null default false,
  is_repeat     boolean not null default false
);
create index qr_scan_code_at on qr_scan (qr_code_id, at desc);
create index qr_scan_attachment on qr_scan (attachment_id, at desc);
create index qr_scan_event on qr_scan (event_id, at desc);
```

Plain `lat`/`lng` columns; no PostGIS. `seq` is per event from `event.next_seq`, assigned under the event row lock, so seq order is commit order. Soft delete exists only on `cookie` (`hidden_at`); every other delete is hard. The content working set is `page`, `section`, `section_item`, and `site_setting_draft`; `content_version` holds published documents; `media_asset` is the media library; `preview_token` and `icon_library_state` are plumbing. First boot seeds the seven role pages and the starter content and publishes version 1 before building snapshot version 1 (sql.md 6 and 8.16).

---

## 6. Settings (`app_setting`)

| Key | JSON type | Default | Range | Changed by | Read by |
|---|---|---|---|---|---|
| `poll_interval_ms` | int | 5000 | 1000 to 60000 | Admin panel | Live object `pollIntervalMs` |
| `cookie_limit_per_person` | int | 10 | 0 to 1000 | Admin panel | `POST /cookies` (inside the transaction), `GET /me/cookies` |
| `sponsor_linger_ms_per_dollar` | int | 40 | 0 to 100000 | Admin panel | Snapshot `sponsors[].lingerMs` |
| `sponsor_linger_min_ms` | int | 2000 | 0 to 600000 | Admin panel | Snapshot `sponsors[].lingerMs` |
| `beacon_stale_after_s` | int | 45 | 15 to 3600 | Admin panel | Stale-beacon chore (7.6); returned as `staleAfterS` on `GET /admin/beacons` for panel colouring (1.11) |
| `flight_history_max_points` | int | 2000 | 100 to 50000 | Admin panel | Snapshot `event.flightHistory.points` thinning (1.3): a 7,200-point flight at 2,000 keeps every 4th point, about 110 KB in the snapshot |
| `location_min_interval_ms` | int | 250 | 0 to 60000 | Admin panel | Location write path (7.2): the least time between two accepted fixes from one beacon on a node; 0 disables |
| `hub_enabled` | bool | true | true or false | Admin panel | Live object `hubEnabled` (1.2): false takes every visitor off the hub and onto the poll within one poll |
| `location_min_distance_m` | number | 0 | 0 to 10000 | Admin panel | Location write path (7.2): a fix that moved less than this from the beacon's last stored fix on the event is carried, not stored; 0 means only an exact repeat of `lat` and `lng` is carried |
| `route_map_simplify_tolerance_m` | int | 30 | 1 to 500 | Admin panel | Snapshot `event.routeMap.path` (1.3), `GET /admin/events/{id}/route-map`, and `GET /admin/routes/{id}/route-map`: the Douglas-Peucker tolerance in metres before smoothing |
| `route_map_max_points` | int | 1200 | 100 to 10000 | Admin panel | Snapshot `event.routeMap.path` (1.3), `GET /admin/events/{id}/route-map`, and `GET /admin/routes/{id}/route-map`: the vertex cap after smoothing, reached by even thinning that keeps the first and last vertex |
| `route_map_default_duration_minutes` | int | 120 | 10 to 720 | Admin panel | Snapshot `event.routeMap` (1.3), `GET /admin/events/{id}/route-map`, and `GET /admin/routes/{id}/route-map`: the duration of an untimed recording (fewer than 2 anchors), spread over the path by distance |

Only `PUT /admin/settings/{key}` changes a value. A missing row means the default. Every settings write is a snapshot-affecting write: the version bump makes every node re-read settings within a tick, and the writing node rewrites the live object so a new `poll_interval_ms` reaches the site. No other configuration lives in the database.

---

## 7. Node runtime

### 7.1 In-memory state per node

`snapshot { version, url }`, `currentEvent { id, statusId } | null`, `activeBeaconId | null`, `latestPublishedLocation | null` (the `location` row fields of the current event), `cookieTally` (map), `settings` (the five keys, refreshed on version change and at least every 5 s), `leader { isLeader, evaluatedAt }`, `lastWrittenVersion`, `wroteForLocationSinceVersionChange` (bool, 7.4). Loaded from the database on boot after migrations; nothing is written on boot unless the `snapshot` table is empty. The outcome of live-object writes lives in the `live_state` row (1.8), not in memory.

### 7.2 Location write (either door)

Before the transaction (per-node, in memory): the node keeps `lastAcceptedAt` per beacon id. Let `effective = beacon.min_interval_ms when set else location_min_interval_ms`. When `now - lastAcceptedAt < effective` the fix is dropped: no transaction, no live object, no publish; the node increments a per-beacon drop counter and flushes those counts into `beacon.fixes_rate_limited` at most once every 5 s per beacon (one update per beacon with drops). The dropped response is `201 { seq, published, receivedAt, serverTime, outcome: "dropped" }` where `seq` is the last seq this node accepted from that beacon (or 0), `published` is the beacon's flag from the auth lookup, `receivedAt` is now. The `LocationPublished` metric filter keys on outcome `stored` (api.md 16).

```
begin;
select id, status_id, next_seq from event where status_id = 3 for update;                    -- none: rollback, 409 no_live_event
select is_active, revoked_at, key_version, min_interval_ms from beacon where id = $beacon;   -- revoked or stale key_version: rollback, 401 or 403
select seq, lat, lng, recorded_at from location
  where event_id = $event and beacon_id = $beacon order by seq desc limit 1;                 -- the previous stored fix, or none (drives derived speed and the distance decision)
-- Try to store when: no previous fix; or the haversine distance from it is at least
-- location_min_distance_m (with 0 meaning lat or lng differs at all). Otherwise carry.
-- The insert uses `on conflict (event_id, lat, lng) do nothing` (A38): a position
-- already stored anywhere in the event lands as carried, whatever the filter said.
--
insert into location (event_id, beacon_id, seq, recorded_at, received_at, lat, lng,
                      speed_mps, speed_source, altitude_m, heading_deg, accuracy_m, published)
  values ($event, $beacon, $next_seq, $recordedAt, now(), ...,
          coalesce($body_speed_mps, $derived_speed_mps),
          case when $body_speed_mps is not null then 'beacon'
               when $derived_speed_mps is not null then 'derived'
               else null end,
          ...,
          $is_active)
  on conflict (event_id, lat, lng) do nothing
  returning seq, received_at;                                              -- no rows on conflict
--
-- stored branch (returning yielded a row):
update event  set next_seq = next_seq + 1,
                  latest_fix = case when $is_active then $latest_fix_json::jsonb else latest_fix end
              where id = $event;                           -- when the fix is published (the beacon is active), the same statement records it on the event row as { seq, beaconId, lat, lng, speedMps, altitudeM, headingDeg, accuracyM, recordedAt, receivedAt } so a rebuild of the live object never steps the seq back below this fix (1.2); an unpublished fix (a spare beacon) leaves latest_fix as it is
update beacon set last_seen_at = now(), last_location_at = now(), stale_since = null,
                  fixes_stored = fixes_stored + 1 where id = $beacon;
--
-- carried branch (filter carried, or the insert conflicted): no row.
update event  set next_seq = next_seq + 1,
                  latest_fix = case when $is_active then $latest_fix_json::jsonb else latest_fix end
              where id = $event;                           -- next_seq still advances; that seq goes to the live object, and a published fix records latest_fix on the event row just like the stored branch (an unpublished fix leaves it alone)
update beacon set last_seen_at = now(), last_location_at = now(), stale_since = null,
                  fixes_carried = fixes_carried + 1 where id = $beacon;   -- the beacon did deliver a fix
--
select version, url from snapshot where id = 1;                            -- carried into the live object
commit;
```

Derived speed is the haversine distance from the previous stored fix divided by the seconds between the two `recordedAt` values; null when there is no previous fix or the delta is not positive. `speed_source` is `'beacon'` when the body carried `speedMps`, `'derived'` when the API computed it, else null. The three rules on the write are the per-beacon min interval (in-memory rate limit), the optional min distance (against the beacon's last stored fix), and one row per position per event (the unique `location_event_position` index that turns a repeat of any position already stored in the event into a carry), so a replayed flight loops without growing the recording.

Then respond to the beacon with `{ seq, published, receivedAt, serverTime, outcome }` where `outcome` is `stored` or `carried`. Update in-memory `lastAcceptedAt`. Then, when `published` is true: update memory (location, snapshot version and URL, event status), build the live object with the tally from memory from the incoming fix's fields (with the new `seq` and `receivedAt = now`, so every apply rule and the signal-lost rule stay as they are), PUT `live/location.json`, publish `location` (2.6), set `wroteForLocationSinceVersionChange = true`, update `live_state` (1.8). Carried fixes publish the same way as stored ones: the site sees a rising `seq` and its store advances. The publish is attempted whether or not the PUT succeeded. The PUT and publish are not awaited by the beacon's response. A CDN write failure is logged and the response was already `2xx` (the row is stored or the fix was carried; the next update retries the object; the hub carried the point). When `published` is false nothing outside the transaction happens.

### 7.3 Snapshot-affecting transaction

```
begin;
select * from snapshot where id = 1 for update;      -- serializes snapshot builders across nodes
... apply the admin write ...
build the snapshot from this transaction's view (1.3);
canonicalize and hash (1.6); key = 'snapshots/' || sha256 || '.json';
PUT s3://<bucket>/<key> with the immutable header;   -- outside SQL; 3 s total timeout, one attempt; failure or timeout => rollback, 502 snapshot_write_failed
update snapshot set version = version + 1, url = '<cdn>/' || key, s3_key = key, built_at = now() where id = 1;
commit;
```

The S3 PUT inside an admin transaction uses a 3 s total timeout and one attempt; fixes waiting on the event row lock therefore wait at most about 3 s. After commit the node refreshes its memory from SQL (snapshot row, current event, active beacon, latest published location, tally, settings), records the new version as `lastWrittenVersion`, writes the live object (up to three PUT attempts one second apart, then `live_state.last_write_error`), and publishes it. Only this node publishes for this version. A rebuild that produces the same bytes reuses the same key; the version still increments. A content publish is this frame with the version insert as the write, so publishes and every other snapshot-affecting write serialize on the `snapshot` row.

### 7.4 Reconcile tick

Every `WMSFO_RECONCILE_TICK_MS` (default 1000) each node runs one round trip:

```sql
select version, url from snapshot where id = 1;
select id, status_id from event where is_current;
select id from beacon where is_active;
select ... from location where event_id = $current and published order by seq desc limit 1;
select cookie_type_id, count(*) from cookie where event_id = $current and hidden_at is null group by 1;   -- every tick in every status
select key, value from app_setting;   -- on version change, and at least every 5 s
```

Memory is refreshed from every row read. When `version` moved and `lastWrittenVersion` is not that version: if `wroteForLocationSinceVersionChange` is true, the node writes the live object once more from the refreshed memory, publishes it, and clears the flag; otherwise it refreshes memory only and neither writes nor publishes (1.8). When `version` did not move, the leader (7.5) compares the refreshed `cookieTally` with the tally in the object it last wrote and, while the event is live, writes and publishes the live object once when they differ, so a cookie reaches the CDN within a tick whether or not a beacon is sending locations. Every node converges within one tick, and the CDN copy is corrected within one tick when an ingest PUT built before a status change landed after the admin node's PUT.

Online count. Every live-object write, whichever trigger (a stored location, an admin commit, a tick rewrite), fills `onlineCount` (1.2) only while the current event's status is 3 and `hub_enabled` is true; otherwise it writes null and makes no gateway call. While those hold, the writing node reads `GET <WMSFO_GATEWAY_INTERNAL_URL>/internal/presence/<service>:location/count` with `X-Gateway-Realtime-Token: <GATEWAY_REALTIME_TOKEN>` (the answer is `{ channel, count }`, 1 s timeout) and caches the answer, or the failure as null, for one second, so the write path costs each node at most one count read per second however many writes it makes. The write waits at most 250 ms for a read in flight; a slower read, a timeout, a non-2xx, a network error, or a missing token writes null, and the write is never failed or retried because of the count. A slow read still fills the cache for the next write.

### 7.5 Leadership

Poll `GET <WMSFO_GATEWAY_INTERNAL_URL>/internal/leader` with `X-Gateway-Realtime-Token: <GATEWAY_REALTIME_TOKEN>` every 2 s with a 1 s timeout. Leader only when the latest answer is `2xx`, `isLeader` is true, and `evaluatedAt` is non-null and under 90 s old (the gateway re-evaluates leadership on its reconcile loop, every 30 s plus jitter, so the window covers two missed loops). Any non-2xx, timeout, network error, `evaluatedAt: null`, or staleness means follower immediately; `isLeader: true` is never carried across a missed poll. Leadership may overlap for a loop during a hand-off, so every chore is idempotent. `WMSFO_FORCE_LEADER=true` makes the node leader without a gateway (local runs only).

### 7.6 Leader chores (all idempotent)

| Chore | Cadence | Action |
|---|---|---|
| Outbox publish | 2 s | `update outbox set claimed_at = now(), attempts = attempts + 1 where id in (select id from outbox where published_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '2 minutes') order by id limit 50 for update skip locked) returning *`; process each row per 7.7; on success `update outbox set published_at = now() where id = $1`; on failure set `last_error`. A row that reaches 5 attempts stays unpublished and appears in the logs. |
| Alert send | 5 s | up to `5 * WMSFO_ALERT_SEND_PER_SEC` `alert_delivery` rows with `sent_at` null and `attempts < 5`, oldest first, sent through SES at no more than `WMSFO_ALERT_SEND_PER_SEC` per second; on success set `sent_at`, `ses_message_id`; on failure set `last_error`, `attempts += 1` |
| Stale beacon flag | 15 s | `update beacon set stale_since = now() where revoked_at is null and stale_since is null and last_seen_at is not null and greatest(coalesce(last_heartbeat_at, '-infinity'), coalesce(last_location_at, '-infinity')) < now() - make_interval(secs => <beacon_stale_after_s>)` (a heartbeat or a stored location clears the flag, 4.2 and 7.2) |
| Media orphan collection | 1 h | compute the referenced media id set (working set, every retained `content_version.media_ids`, `sponsor.logo_media_id`, media-sourced `cookie_type.icon`, `tracker_theme.thumbnail_media_id`, the site settings draft, the `dark_media_id` and `small_media_id` of every `ready` asset); set `unreferenced_since = now()` on `ready` rows outside the set that have none, clear it on rows inside the set; tag and mark `orphaned` the rows whose `unreferenced_since` is older than 30 days; untag and return to `ready` any `orphaned` row that is back in the set; delete rows `orphaned` more than 8 days ago (the lifecycle rule removed their objects after 7) |
| Pending map sweep | 09:00 UTC, after the nightly cleanup | for every `tracker_map` row `pending` with `created_at` older than 1 day: abort every open multipart upload under its prefix (`ListMultipartUploads` by prefix, `AbortMultipartUpload` each; the bucket's lifecycle rule has usually done it, 1.7), delete every object under the prefix, delete the row. A row the CLI is still uploading is never younger than its own `created_at`, so an upload that takes longer than a day fails its confirm and starts over |
| Nightly cleanup | 09:00 UTC (02:00 Mountain) | delete `beacon_enrollment_token` rows expired or consumed more than 24 h ago; `outbox` rows published more than 30 days ago, except the alert topics (`event.status_changed`, `event.status_notified`, `event.message_posted`), which stay 400 days so a person's alert history (4.4 `GET /me/alerts`) spans a season (their `alert_delivery` rows cascade with them); `subscriber` rows never verified whose `created_at` is older than 7 days; `beacon_log` rows older than 30 days; `preview_token` rows expired more than 24 h ago; `media_asset` rows still `pending` after 2 days (their objects expired by the lifecycle rule after 1) |

At `WMSFO_ALERT_SEND_PER_SEC` = 10, twenty thousand verified subscribers take about 33 minutes per alert; the SES sending quota must be at or above that rate before the event.

### 7.7 Outbox topics

| Topic | Payload | Written by | Processing |
|---|---|---|---|
| `event.status_changed` | `{ "eventId": 7, "fromStatusId": 2, "toStatusId": 3, "notify": true, "messageId": null, "historyId": 40 }` | every status change (4.5) | When `notify` is true: for every `subscriber` with `channel = 'email' and verified_at is not null and unsubscribed_at is null`, `insert into alert_delivery (outbox_id, subscriber_id) ... on conflict do nothing`. Template by `toStatusId`: `event_planned` (1), `event_scheduled` (2), `event_live` (3), `event_ended` (4), `event_cancelled` (5), `event_postponed` (6); a non-null `messageId` names the event message whose body replaces the template's stock paragraph (`{{customMessage}}`); when that row no longer exists the stock paragraph renders. When `notify` is false nothing is sent and the row is published at once. |
| `event.status_notified` | `{ "eventId": 7, "statusId": 3, "messageId": null, "historyId": 41 }` | `POST /admin/events/{id}/notify` | Exactly the processing of `event.status_changed` with `notify: true` for `statusId`. |
| `event.message_posted` | `{ "eventId": 7, "messageId": 12 }` | `POST /admin/events/{id}/messages` with `notify: true` | Same fan-out, template `event_message`; each email sent counts on the message row (`sentCount`), as a status alert counts on its history row. When the message or event row no longer exists, mark the outbox row published with `last_error = 'source_deleted'` and send nothing. |
| `subscription.verify` | `{ "subscriberId": 9, "verifyToken": "wsv_..." }` | subscribe and resend-verification | Send template `subscription_verify` to the subscriber's address with `{{verifyUrl}}` = `WMSFO_SITE_BASE_URL/alerts/verify?token=<verifyToken>`. The plaintext token exists only in this outbox row; it is useless after the 24 h expiry and the row is deleted by the nightly chore. No `alert_delivery` row. |
| `contact.received` | `{ "contactMessageId": 12 }` | `POST /contact` | Send template `contact_received` to `WMSFO_CONTACT_NOTIFY_EMAIL` with reply-to set to the sender. |

The `(subscriber_id, outbox_id)` uniqueness is what prevents double sends when leadership overlaps; the alert-send chore sends each row at most once per attempt and never re-sends a row with `sent_at` set.

### 7.8 Email

SES v2 API through the instance role in `<region>`, from `WMSFO_SES_FROM_ADDRESS`, optional configuration set `WMSFO_SES_CONFIGURATION_SET`. `<mail-domain>` is DKIM-verified and the account has production access. Hard bounces and complaints are handled by the SES account-level suppression list; the API does nothing further in v1.

The API reads the account's sending quota with `GetAccount` for `GET /admin/email/quota` (4.5) and never blocks or delays a send because of it.

Every email has an HTML part and a text part. Each template in the API repository is a body fragment, `templates/email/<name>.html` and `.txt`, placed as-is at `{{content}}` of the shared layout, `templates/email/_layout.html` and `_layout.txt`. The node composes every template with the layout once at boot and validates the required substitutions against the composed result; a missing layout, layout without `{{content}}`, bundled image, or fragment fails the boot. The layout takes `{{subject}}`, `{{preheader}}` (one hidden sentence per template that inbox previews show), `{{ornamentsUrl}}`, `{{lightsUrl}}`, `{{logoUrl}}`, `{{siteName}}`, `{{siteUrl}}`, `{{statusPill}}` (the template's status pill, empty without one), `{{footerReason}}` (why the reader got the email), `{{footerLink}}` (the footer line after the reason: the unsubscribe link on alerts, its line dropped on other templates), and `{{content}}`; the text layout takes `{{siteName}}` (its first line), `{{content}}`, `{{footerReason}}`, `{{footerLink}}`, `{{siteUrl}}`. The node fills `{{statusPill}}` and `{{footerLink}}` from the template's spec at composition, as template text. Every substituted value is HTML-escaped in the HTML part and raw in the text part; only the fragment, the pill, and the footer link are placed unescaped.

Every email carries the site's two themes in the banner layout, as the site follows the system: the light design by default, and the site's dark palette for clients that ask for dark. The head declares both schemes three ways: `<meta name="color-scheme" content="light dark">`, `<meta name="supported-color-schemes" content="light dark">`, and the style rule `:root { color-scheme: light dark; }`. The light design is inline: every element with a background (the `body`, the outer table and its cell, the ornaments row, the card, the header band, the body cell, the quoted block, the code block, the button cell, the footer band) declares it by a `bgcolor` attribute and an inline `background-color`, and every text colour is a plain inline `color`; no inline style carries `!important` and no background is a gradient. Every coloured element carries a class: `ground` (the `body`, the outer tables and cells, the ornaments row), `card`, `band` (the header band and the code block), `lights` (the light string row), `body` and `text` (the body cell), `foot` and `muted` (the footer band), `name` (the site name), `heading` (the `h1` and bold labels), `text` (body paragraphs), `muted` (the small print), `link` (every text link), `quote` (the quoted block), `star` (the gold star), `button` and `buttonText` (the button cell and its link), and `pill` with its tone class (table below). The one `<style>` block holds one `@media (prefers-color-scheme: dark)` block, with `!important` on every declaration, that first resets every element inside the ground (`.ground table, .ground td, .ground p, .ground h1, .ground span, .ground a { background-color: transparent; color: inherit; }`) and then sets the dark tokens of the site, each rule scoped under `.ground` so it outranks the reset: `.ground` `#070d1c`; `.card` and `.body` `#0f182e` with border colour `#243252`; `.band` and `.quote` `#16213c` with border colour `#243252`; `.foot` `#070d1c` with border colour `#243252`; `.text` and `.quote` text `#c9d5ec`; `.name` and `.heading` `#eef3ff`; `.muted` `#8393b5`; `.link` `#6fd3ff`; `.button` `#6fd3ff` with `.buttonText` `#070d1c`; the quote's left border `#6fd3ff` and `.star` `#f0c05a`; the pills by tone class (table below). Clients that honour the media query and the two-scheme declaration show the dark palette in dark mode, Thunderbird and Apple Mail among them; the per-element reset is what stops Thunderbird's own adaptation, which otherwise lightens the text of every element without a dark rule of its own. Clients without media query support, Gmail among them, show the light design. The ornaments and the light string are the same images in both themes, as on the site, and the logo tile stays opaque white. Faces: the head links the public Google Fonts stylesheet `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Bricolage+Grotesque:wght@700&display=swap`; every text cell's font stack starts with `'IBM Plex Sans'` before the system faces, and the `h1` stack starts with `'Bricolage Grotesque', 'IBM Plex Sans'`. Apple Mail and iOS Mail load the faces; every other client falls back to the system stack. Page background `#eef3fa`. Top to bottom inside it (24 px by 12 px padding): a full-width row at most 560 px wide holding the site's ornaments, `{{ornamentsUrl}}`, an `<img>` 560 by 110 with `alt=""`, `display:block`, and `width:100%; height:auto; max-width:560px` so it scales on narrow clients, with no padding below so the ornaments hang onto the card's top edge; then one centred card, at most 560 px wide, `#ffffff`, 1 px `#d3ddee` border, 16 px radius (the site's card radius; `border-collapse:separate`). The header band (`#f5f8fd`, 1 px `#d3ddee` bottom border, 20 px by 28 px padding) holds on the left the logo at 64 by 64 px, linked to the site, its alt the site name, with the site name beside it as text (19 px / 24 px bold `#0f1a30`) so the email reads with images off, and on the right the status pill. Directly under the band's bottom border is a 4 px row holding the site's light string, `{{lightsUrl}}`, an `<img>` 560 by 4 with `alt=""`, `display:block`, and `width:100%; height:auto; max-width:560px`. The body (28 px padding, 20 px on phones through an inline `clamp` that clients without it read as 28 px; 15 px / 23 px `#2c3850`) opens with the heading, an `h1` at 24 px / 32 px bold `#0f1a30`, followed on the event templates by a gold star (`&#9733;`, `#8a6210`). The message (`{{customMessage}}`, `{{messageBody}}`, and the contact message) is a quoted block: a one-cell table with `#f5f8fd` fill, a 3 px `#0b6bb5` left border, 6 px radius, 12 px by 16 px padding, line breaks kept. A code or temporary password sits in its own block, always as text: 24 px bold monospace, `#f5f8fd` fill, 1 px `#d3ddee` border. An email carries at most one button, a fully round (`999px` radius) table cell with `#0b6bb5` fill and bold white 15 px text, 12 px by 22 px padding, with the plain URL printed under it at 13 px `#5a6885`. The footer band (`#eef3fa`, 1 px `#d3ddee` top border, 16 px by 28 px padding, 13 px / 20 px `#5a6885`) holds the footer reason, then on alerts the unsubscribe link, then the site link (`#0b6bb5`, underlined). Table-based layout with inline styles on `role="presentation"` tables: no style beyond the color-scheme rule and the dark-mode media query, no scripts, three images in total (the ornaments, the logo, the light string), all remote; every rendered email stays under 100 KB. The text layout carries none of this and is unchanged.

The status pill is a `span` (inline block, 12 px bold, 0.08 em letter spacing, uppercase, 3 px by 10 px padding, `999px` radius) with the classes `pill` and its tone; its light colours are inline and its dark colours come from the media query:

| Template | Label | Background | Text | Tone class | Dark background | Dark text |
|---|---|---|---|---|---|---|
| `event_planned` | `Planned` | `#e6f0fa` | `#0b6bb5` | `pillAccent` | `#163452` | `#6fd3ff` |
| `event_scheduled` | `Scheduled` | `#e6f0fa` | `#0b6bb5` | `pillAccent` | `#163452` | `#6fd3ff` |
| `event_live` | `Live now` | `#e3f6ec` | `#1f7f4f` | `pillOk` | `#15372b` | `#56d29a` |
| `event_ended` | `Landed` | `#edf1f7` | `#5a6885` | `pillDim` | `#1a2540` | `#8393b5` |
| `event_cancelled` | `Cancelled` | `#fbe7e5` | `#c2362c` | `pillErr` | `#3d2326` | `#ff7a70` |
| `event_postponed` | `Postponed` | `#f8efd9` | `#8a6210` | `pillWarn` | `#3a3119` | `#f0c05a` |
| `event_message` | `Update` | `#e6f0fa` | `#0b6bb5` | `pillAccent` | `#163452` | `#6fd3ff` |
| `subscription_verify` | `Confirm` | `#e6f0fa` | `#0b6bb5` | `pillAccent` | `#163452` | `#6fd3ff` |
| `contact_received` and the account emails | none | | | | | |

The account emails of the Cognito custom message trigger (`account_*.html`) use the same layout and block styles.

The logo of an alert email (status and message) is the published site logo, resolved when the email is built: when the published settings' `logoMedia` (1.3a) names a ready raster or gif asset (png, jpeg, webp, gif; never svg), the node derives an email tile from its original, the image fitted inside a 192 by 192 px PNG with 16 px padding over an opaque white tile with rounded corners, so it reads on light and dark email clients. The tile is written to `email/{sha256}.png` (1.1), `{sha256}` being the SHA-256 of the tile's bytes, when that key is absent, and never overwritten; a node derives each asset once and keeps the URL in memory per media id and confirm stamp. `{{logoUrl}}` is `WMSFO_CDN_BASE_URL/email/{sha256}.png`. The bundled mark, `templates/email/logo.png`, is the fallback, at `email/{sha256 of that file}.png`, which the migrating node writes on boot when the key is absent: it is the logo when `logoMedia` is absent, names an svg or an asset that is not ready, or the derivation fails (logged at Warning; it never fails a send), and on every other email. `{{siteName}}` is the published `siteName` on alert emails, `Santa Tracker` when it is empty and on every other email.

The ornaments and the light string are two more bundled images on every email: `templates/email/ornaments.png` (2240 by 440 px, the site's five ornaments at the site's 55 percent opacity on a transparent ground, shown at 560 by 110 css px) and `templates/email/lights.png` (2240 by 16 px, the site's light string on a transparent ground, shown at 560 by 4 css px). Each is at `email/{sha256 of the file}.png` (1.1), which the migrating node writes on boot with the immutable cache header when the key is absent, like the bundled logo; `{{ornamentsUrl}}` and `{{lightsUrl}}` are `WMSFO_CDN_BASE_URL/email/{sha256}.png` of each file.

Golden renders of `subscription_verify` and `event_live` live under `templates/email/_golden/`: `inputs.json` holds the fixed inputs (CDN and site base URLs, the bundled logo, ornaments, and light string URLs, and per template the subject, preheader, footer reason, status pill with its tone, footer link, and values; the site name is `Santa Tracker`), and `<name>.html` and `<name>.txt` hold the exact bytes the API renders from them.

Fragment substitutions are `{{eventName}}`, `{{scheduledAt}}` (rendered in the event's `scheduleTimeZone`, `America/Denver` when unset, followed by the zone's IANA id in parentheses), `{{messageBody}}`, `{{customMessage}}` (the body of the event message a status alert's `messageId` names, read when the email is built; when the payload names none or the row was deleted the template's stock paragraph renders instead; a status change without a typed message posts that stock paragraph as its event message, so its email carries the same text once), `{{siteUrl}}`, `{{verifyUrl}}`, `{{unsubscribeUrl}}`, `{{contactName}}`, `{{contactEmail}}`, `{{contactMessage}}`.

| Template | Subject | Body must contain |
|---|---|---|
| `subscription_verify` | `Confirm your Santa tracker alerts` | `https://<site-domain>/alerts/verify?token=wsv_...` |
| `event_planned` | `Santa's flight is on the calendar` | event name, the stock paragraph or `{{customMessage}}`, link to `https://<site-domain>/`, unsubscribe link |
| `event_scheduled` | `Santa's flight is scheduled` | event name, `scheduledAt` in the event's `scheduleTimeZone` (`America/Denver` when unset) with the IANA id in parentheses, the stock paragraph or `{{customMessage}}`, unsubscribe link |
| `event_live` | `Santa just lifted off` | link to `https://<site-domain>/`, the stock paragraph or `{{customMessage}}`, unsubscribe link |
| `event_ended` | `Santa has landed` | event name, the stock paragraph or `{{customMessage}}`, unsubscribe link |
| `event_cancelled` | `Santa's flight has been cancelled` | event name, the stock paragraph or `{{customMessage}}`, unsubscribe link |
| `event_postponed` | `Santa's flight is postponed` | event name, the stock paragraph or `{{customMessage}}` (stock: `<event name> is postponed. A new time will be announced when it is known.`), unsubscribe link |
| `event_message` | `Santa update: <first 60 characters of body>` | full body, unsubscribe link |
| `contact_received` | `Contact form: <name>` | name, email, message |

Unsubscribe link in the footer band: `https://<site-domain>/alerts/unsubscribe?token=wsu_...`. Headers on every alert: `List-Unsubscribe: <https://<api-domain>/subscriptions/unsubscribe?token=wsu_...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (section 4.3). Verify tokens are `wsv_` + 43 URL-safe base64 characters, hashed at rest, 24 h; unsubscribe tokens are `wsu_` + 43 characters, stored plaintext, stable for the life of the row.

---

## 8. Configuration

### 8.1 API container env (the flat JSON `SecretString` of `<secret-name>`)

```json
{
  "ASPNETCORE_URLS": "http://0.0.0.0:5000",
  "WMSFO_ENV": "dev",
  "WMSFO_SERVICE_NAME": "wmsfo-api-dev",
  "WMSFO_DB_CONNECTION": "Host=<db-host>;Port=5432;Database=wmsfo_dev;Username=wmsfo_app_dev;Password=<password>;SSL Mode=Require;Trust Server Certificate=false",
  "WMSFO_DB_MIGRATION_CONNECTION": "Host=<db-host>;Port=5432;Database=wmsfo_dev;Username=wmsfo_migrate_dev;Password=<migrate-password>;SSL Mode=Require;Trust Server Certificate=false",
  "AWS_REGION": "<region>",
  "WMSFO_S3_BUCKET": "<bucket>",
  "WMSFO_CDN_BASE_URL": "https://<cdn-domain>",
  "WMSFO_PUBLIC_API_BASE_URL": "https://<api-domain>",
  "WMSFO_HUB_URL": "wss://<gateway-domain>/hub",
  "WMSFO_SITE_BASE_URL": "https://<preview-site-domain>",
  "WMSFO_GATEWAY_INTERNAL_URL": "http://<docker-bridge-ip>:8080",
  "WMSFO_CORS_ORIGINS": "https://<preview-site-domain>,https://<admin-dev-domain>,http://localhost:5173,http://localhost:5174",
  "WMSFO_TRUSTED_PROXY_HOPS": "2",
  "WMSFO_COGNITO_ISSUER": "https://cognito-idp.<region>.amazonaws.com/<pool-id>",
  "WMSFO_COGNITO_CLIENT_IDS": "<site-client-id>",
  "WMSFO_COGNITO_USER_POOL_ID": "<pool-id>",
  "WMSFO_COGNITO_ADMIN_ISSUER": "https://cognito-idp.<region>.amazonaws.com/<admin-pool-id>",
  "WMSFO_COGNITO_ADMIN_CLIENT_IDS": "<admin-client-id>",
  "WMSFO_COGNITO_ADMIN_USER_POOL_ID": "<admin-pool-id>",
  "WMSFO_ADMIN_GROUP": "admin",
  "WMSFO_EDITOR_GROUP": "editor",
  "WMSFO_CANVASSER_GROUP": "canvasser",
  "WMSFO_SCAN_SALT": "<random string; salts the scan IP hash>",
  "WMSFO_SES_FROM_ADDRESS": "Santa Tracker <alerts@<mail-domain>>",
  "WMSFO_SES_CONFIGURATION_SET": "",
  "WMSFO_CONTACT_NOTIFY_EMAIL": "<inbox-address>",
  "WMSFO_ALERT_SEND_PER_SEC": "10",
  "WMSFO_ENROLLMENT_ENCRYPTION_KEY": "<base64 of 32 random bytes>",
  "WMSFO_RECONCILE_TICK_MS": "1000",
  "WMSFO_LOG_LEVEL": "Information"
}
```

Prod differs in `WMSFO_ENV` (`prod`), `WMSFO_SERVICE_NAME` (`wmsfo-api`), the database and role names, `WMSFO_SITE_BASE_URL` (`https://<site-domain>`), and `WMSFO_CORS_ORIGINS` (`https://<site-domain>,https://<admin-domain>`).

`GATEWAY_REALTIME_TOKEN` is injected by the gateway and is never placed in the secret. Local-only keys, refused when `WMSFO_ENV` is `prod` and never in the secret: `WMSFO_FORCE_LEADER`, `WMSFO_OBJECT_STORE_DIR` (object store on a local directory), `WMSFO_DEV_STATIC_TOKENS` (fixed test tokens), `WMSFO_SES_DRY_RUN` (log mail instead of sending). AWS credentials come from the instance role via the instance metadata service; locally the SDK default chain applies. Logs are JSON lines on stdout and reach CloudWatch through the gateway. A change to any value propagates as a blue-green container replacement on the next deploy.

### 8.2 Manifest and CI

The manifest entry is in 2.7. CI is GitHub Actions with environments `dev` and `prod`. Branch `dev` deploys `wmsfo-api-dev`; branch `main` deploys `wmsfo-api`.

Flow per push: build the image; push `<account-id>.dkr.ecr.<region>.amazonaws.com/wmsfo-api:<sha>-dev` (or `<sha>-prod`); obtain a client-credentials token with scope `mgmt/deploy` from `GATEWAY_TOKEN_URL`; then:

```
POST https://<gateway-domain>/mgmt/services/<service>/deploy
Authorization: Bearer <token>
Content-Type: application/json

{ "tag": "<sha>-dev" }
```

Environment secrets: `AWS_ROLE_ARN` (OIDC assume role for the ECR push), `ECR_REPOSITORY`, `GATEWAY_BASE_URL`, `GATEWAY_TOKEN_URL`, `GATEWAY_CLIENT_ID`, `GATEWAY_CLIENT_SECRET`, `GATEWAY_SERVICE_NAME`. CI never upserts the manifest entry and never sends realtime fields.

### 8.3 Public site (Vercel, `VITE_` prefix)

| Variable | Value |
|---|---|
| `VITE_ENV` | `production` or `preview` |
| `VITE_CDN_BASE_URL` | `https://<cdn-domain>` |
| `VITE_HUB_URL` | `wss://<gateway-domain>/hub` |
| `VITE_HUB_CHANNEL_PREFIX` | `wmsfo-api` or `wmsfo-api-dev` |
| `VITE_API_BASE_URL` | `https://<api-domain>` |
| `VITE_COGNITO_USER_POOL_ID` | `<pool-id>` (the people pool; the region is its prefix) |
| `VITE_COGNITO_CLIENT_ID` | `<site-client-id>` |
| `VITE_GOOGLE_MAPS_KEY` | referrer-restricted browser key |
| `VITE_ANALYTICS_ID` | set on production only; empty disables analytics |
| `VITE_ANALYTICS_ORIGINS` | comma-separated exact production origins; analytics fires only when the page origin is listed; set on production only |

The site fetches `VITE_CDN_BASE_URL + "/live/location.json"` and otherwise only absolute URLs found in objects: the tracker's tiles, style bodies, and sprites come from `event.trackerMap` and `trackerThemes` (1.3), so the site has no basemap variable. Production deploys from `main`, preview from `dev`.

### 8.4 Admin panel (Vercel, `VITE_` prefix)

`VITE_ENV`, `VITE_API_BASE_URL`, `VITE_CDN_BASE_URL`, `VITE_COGNITO_AUTHORITY` (the admin pool's issuer), `VITE_COGNITO_DOMAIN` (the admin pool's managed login domain), `VITE_COGNITO_CLIENT_ID` (`<admin-client-id>`), `VITE_ROUTE_BASEMAP_URL` (optional: `https://<cdn-domain>/basemap`, the folder of the seeded map's archives and the glyph set, platform.md 1.8; the theme editor's preview pane and the bounding box editors draw on it, and without it the box editors fall back to their number fields with a one-line note; the poster studio draws over the map the layout names, 4.5 Maps, and reads only the glyphs from here). Two projects: one deployed from `main` with the prod set at `<admin-domain>`, one deployed from `dev` with the dev set at `<admin-dev-domain>`. Local work runs on `http://localhost:5174` with the dev set in `.env.local`.

### 8.5 Red-Nose (build config per flavour, `dev` and `prod`)

| Field | Value |
|---|---|
| `REDNOSE_DEFAULT_API_BASE_URL` | Prefill for manual enrollment; the enrolled value always wins. |
| `REDNOSE_HEARTBEAT_INTERVAL_MS` | 15000 |
| `REDNOSE_FIX_INTERVAL_MS` | 250 (the location request interval and the send loop's tick) |
| `REDNOSE_HTTP_FALLBACK_INTERVAL_MS` | 1000 (the least time between two HTTP sends while the socket is down) |
| `REDNOSE_BACKOFF_MS` | `1000,2000,3000,5000` (the last value repeats forever) |
| `REDNOSE_LOG_RING_BYTES` | 2,000,000 |
| `REDNOSE_PROD_API_BASE_URL` | The prod API base URL, present in both flavours; replay (9.4) is offered only when the enrolled `apiBaseUrl` differs from it. |

Runtime-stored fields (Keystore-backed `EncryptedSharedPreferences`), written by enrollment or typed by hand: `apiBaseUrl`, `hubUrl`, `ingestChannel`, `beaconId`, `name`, `key`, `gpsOnlyFallback` (bool, default false). Dev builds allow cleartext HTTP for a LAN API through the Android network security config; release builds do not.

### 8.6 Platform pieces the contracts assume

| Piece | Requirement |
|---|---|
| S3 bucket | Private; origin access control for the distribution; a CORS rule for `PUT` from the admin origins; two tag-filtered lifecycle rules (`state=pending` 1 day, `state=orphaned` 7 days), per 1.7 and platform.md 1. |
| CloudFront | Per 1.7, with origin access control on the S3 origin. |
| RDS | Databases `wmsfo_dev`, `wmsfo_prod`; roles `wmsfo_app_<env>` (requests) and `wmsfo_migrate_<env>` (migrations, migration tool) per `sql.md` 12. |
| Cognito | Per 3.1, groups `admin` and `editor`. |
| SES | `<mail-domain>` verified with DKIM; production access; sending quota at or above `WMSFO_ALERT_SEND_PER_SEC`. |
| Instance role | S3 `PutObject`, `GetObject`, `DeleteObject`, `ListBucket`, `PutObjectTagging`, `GetObjectTagging`, `DeleteObjectTagging` on `<bucket>` and `<bucket>/live/*`, `snapshots/*`, `routes/*` (flight recordings), `media/*`, `icons/*` (the presigned upload URLs are signed with these credentials, so the role's `PutObject` and `PutObjectTagging` cover the browser's PUT); `ses:SendEmail`; Secrets Manager read of `<secret-name>`; CloudWatch logs; plus `cognito-idp:AdminGetUser` on the pool (TOTP check). |
| Gateway | Manifest entry per 2.7; internal listener reachable at `<docker-bridge-ip>:8080`; load balancer idle timeout at or above 60 s. |

---

## 9. Beacon contract

Every beacon (Red-Nose on the helicopter phone, the simulator beacon, the legacy beacon, or any other holder of a `wbk_` key) follows 9.2 and 9.3. 9.1 and 9.4 describe Red-Nose's screens; the other beacons' surfaces are in their own repositories (9.5).

### 9.1 Red-Nose screens

| Screen | Visible when |
|---|---|
| Enroll (scan or manual) | No stored key |
| Status (name, socket state, live event state, last fix, last receipt, heartbeat age, skew, revoked banner) | Enrolled |
| Debug (full telemetry, fix log, socket log, failure log, upload log button, replay, provisioning state) | Enrolled; always available, the API knows nothing about it |

The foreground service starts as soon as a key is stored and on every boot while one is stored. Clearing enrollment (a button on the status screen behind a long press) stops the service and wipes the stored fields.

### 9.2 Service state and loops

The service holds one `LatestFix`, one `Telemetry` value, the last heartbeat answer, and two loops. Nothing is queued; nothing is stored on the phone beyond the current fix.

```
LatestFix { lat, lng, recordedAt, speedMps?, altitudeM?, headingDeg?, accuracyM?, seqLocal }
```

`seqLocal` increments per fix so the send loop knows whether the current fix has been delivered. `recordedAt` is the fix time from the location provider, never the send time. Absent fields are sent as JSON `null`.

Socket loop:

```
attempt = 0
forever:
  start connection; invoke JoinPrivateChannel(ingestChannel, key)
  on success: attempt = 0; socketState = connected; stop HTTP fallback; send the current fix
  on close or failure: stop the connection; socketState = reconnecting; delay = backoff[min(attempt, 3)]; attempt++;
                       wait delay, or until the connectivity callback fires; loop
  a join denied by the gateway: as failure, but the first retry waits 10 s (2.3 step 8)
on channelEvicted(auth_expired): join again immediately, then send the current fix
on channelEvicted(service_removed): join again every 5 s
```

At most one connection exists. A join that throws, including after `auth_expired`, stops the connection and takes the close-or-failure branch (`socketState = reconnecting`, backoff). A retry is never gated on the reported network state: while Android reports no network the service still probes on the 5 s tick, and the connectivity callback only shortens the wait.

The socket loop registers its `ChannelEvent` handler with the argument type the client's Gson deserializer can build (Java's `com.google.gson.JsonElement` or `Object` and a map walk); the client drops an argument it cannot build before the handler runs, and an eviction announced that way is never seen. Each eviction is logged (`socket: evicted <reason>`), each re-join outcome is logged (`socket: rejoined` or `socket: rejoin failed <error>`), and `rejoinCount` on the transport telemetry counts every `JoinPrivateChannel` re-invocation the loop issues on a still-open connection.

An unannounced loss of channel membership can also arrive as repeated hub rejections while `socketState` stays `connected` (a sweep evicts a stale allow without an envelope reaching the client, a race with the gateway callback, and so on). Three consecutive `hub_rejected` outcomes while `socketState == connected` and `lastHeartbeat.liveEventId != null` ask the socket loop to re-join the ingest channel once (the same path as `auth_expired`); without a live event every hub send is rejected by design (`409 no_live_event` behind the gateway) and nothing counts, so a beacon does not storm the authorize callback between events; if that re-join throws, the socket loop takes its close-or-failure branch (`socketState = reconnecting`, backoff), and the next attempts fall back to HTTP until the socket is `connected` again. The counter resets on any delivered send.

Send loop (runs every `REDNOSE_FIX_INTERVAL_MS` and immediately on a new fix; after a failed send the next attempt waits `backoff[min(attempt, 3)]`, and a fix arriving during the wait replaces `LatestFix` and goes out when the wait ends). Over the socket every fix goes out as soon as the previous send resolved, so the delivered rate is the provider's rate, up to four per second. Over HTTP a send starts no sooner than `REDNOSE_HTTP_FALLBACK_INTERVAL_MS` after the previous HTTP send started; fixes that arrive inside that window replace `LatestFix` and the newest one goes out when the window ends. The window is the only difference between the two doors:

```
if no LatestFix or LatestFix.seqLocal == lastDeliveredSeqLocal: return
if a send is in flight: return                                 (at most one in flight on either door)
if socketState == connected:
  invoke SendToChannel(ingestChannel, "location", payload)     (10 s timeout)
  resolved: lastDeliveredSeqLocal = fix.seqLocal; receiptLatencyMs = elapsed; attempt = 0
  rejected: failed send (below); do not fall back (the socket is up)
else:
  if less than REDNOSE_HTTP_FALLBACK_INTERVAL_MS since the last HTTP send started: wait the remainder, then decide again from the top
  POST {apiBaseUrl}/locations with X-Beacon-Key                (10 s timeout)
  2xx: lastDeliveredSeqLocal = fix.seqLocal; httpFallbackSeconds accrues; attempt = 0
  otherwise: failed send (below)
failed send: keep the current fix; next attempt after backoff[min(attempt, 3)]; attempt++
```

`SendToChannel` resolves only after the API answered `2xx`; a rejection is a failed send, the current fix is kept, and the next attempt follows the loop. A `409 no_live_event` (HTTP) or a rejected invoke (hub) is a failed send like any other. A failed send while `lastHeartbeat.liveEventId` is null is logged once per minute at Debug and does not increment `sendsFailedSinceBoot`; `sendsFailedSinceBoot` counts only failures while `liveEventId` is non-null. A fix arriving during an in-flight send replaces `LatestFix` and is sent when that attempt resolves or times out. The service never guesses whether an event is live; `liveEventId` comes only from the API's own answer.

Heartbeat loop: every `REDNOSE_HEARTBEAT_INTERVAL_MS`, `POST /beacons/heartbeat` with the full telemetry, over HTTP whatever the socket state. On a `2xx`: `clockSkewMs = serverTime - (tSend + (tReceive - tSend) / 2)` using the phone's wall clock at request send and response receipt; store `liveEventId` and `isActive`. On a `401`: mark the service state `revoked`, show the banner on the status screen, keep every loop running unchanged (nothing ever gives up; a rotate followed by re-enrollment clears it). Any other outcome (non-2xx other than `401`, timeout, network error) leaves `liveEventId`, `isActive`, and `clockSkewMs` unchanged, is logged with `code` and `requestId` when present, and the next attempt is the next `REDNOSE_HEARTBEAT_INTERVAL_MS` tick; the status screen shows the growing heartbeat age. Skew is telemetry only; it never affects what is sent.

### 9.3 Error surfacing

A hub invoke that throws carries only the gateway's generic text. The debug log records it with the local time and the fix's `seqLocal`. HTTP errors are logged with their `code` and `requestId`. The status screen shows: socket state, `liveEventId` from the last HTTP heartbeat answer (or "no live event"), `active` or `spare` from that answer's `isActive`, last delivered `seqLocal` and receipt latency, heartbeat age, skew, and the revoked banner when set.

### 9.4 Red-Nose replay mode

Input: a route object (1.4) fetched from a URL typed on the debug screen, or a file picked on the phone. The service sends the points in order as fixes with `recordedAt = now()` at a chosen rate (1 to 10 per second) to the enrolled `apiBaseUrl`, `hubUrl`, and `ingestChannel` with the enrolled key. Replay uses the same two doors and the same loops; it differs only in where fixes come from. The debug screen offers replay only when the enrolled `apiBaseUrl` differs from `REDNOSE_PROD_API_BASE_URL` (8.5); replaying into dev means enrolling the phone against dev.

### 9.5 The other beacons

Two more beacons are services on the fleet, each its own repository with its own design document, each an ordinary enrolled beacon to the API:

| Beacon | Repository | What it posts | Where its fixes come from |
|---|---|---|---|
| Simulator beacon | `simulator-beacon` (`docs/simulator-beacon.md`) | A past year's flight, replayed at a chosen speed, so a dev event set live shows a whole flight on the tracker | `GET /admin/events` and `GET /admin/events/{id}/locations` on the same API through a `wak_` key with the `events` capability (3.6); it posts through its enrolled `wbk_` key like any beacon |
| Legacy beacon | `legacy-beacon` (`docs/legacy-beacon.md`) | Whatever the legacy Heroku tracker reports, normalized to the location body of 4.2, every second, in every mode | `GET https://santatracker-api.herokuapp.com/get?id=406santa` polled once per second |

Both prefer the hub and fall back to HTTP per 9.2, heartbeat every 15 s with `health` and their own `debug` object per 4.2, and never give up. The simulator is a test beacon, never registered in prod: one service against the dev API and one control page, which signs in through the admin pool (3.1; platform.md 3.6, 4.2, and 8). The legacy beacon has no user interface.

---

## 10. Migration and cut-over

The one-off tool lives in the API solution (`tools/migrate`), references the API's DTO types and serializer options (1.6), reads the legacy database and bucket by connection strings passed on the command line, takes `--cdn-base-url` (the environment's `WMSFO_CDN_BASE_URL`) for `route.url`, writes only the new database and bucket, and is idempotent by natural key (year for events, sponsor id for sponsors, legacy row id for messages and updates). Every migrated row carries `created_by = 'migration'` where the column exists. Legacy `timestamp without time zone` columns (`sponsors.created_at`, `sponsors.updated_at`, `sponsor_years.registered_at`) are interpreted as UTC on copy. Legacy epoch-millisecond columns (`flight_history.time` bigint; `funds.created` and `messages.created` text) are parsed as milliseconds since the Unix epoch. The year of a legacy row that has no year column is the calendar year of its timestamp in `America/Denver`.

| Legacy | New |
|---|---|
| `flight_history` rows grouped by `year` (2020 to 2025) | One `event` per year: `name` from the `--event-name-format` argument (default `Santa Flyover {year}`), `status_id = 4`, `is_current = false`, `went_live_at` = earliest `time`, `ended_at` = latest `time`, `funds_percent` per the `funds` row below or 0. `location` rows in `seq` order with `seq` renumbered from 1 per event, `beacon_id` = the synthetic beacon, `published = true`, `recorded_at = received_at = time`, `lat`/`lng` from the numeric columns, the optional fields null; `event.next_seq` set to the count plus one. |
| Synthetic beacon | One `beacon` row `name = 'legacy'`, `role = 'beacon'`, a random key generated per 3.2 and discarded, with its `sha256` as `key_hash` and its first 12 characters as `key_prefix`, `is_active = false`, `revoked_at = now()`. |
| 2025 `flight_history` | Also written as `routes/{sha256}.json` (`name = '2025 flight'`, points in `seq` order with `recordedAt` from `time`), a `route` row with `uploaded_by = 'migration'`, linked as the 2025 event's `route_id`. |
| Legacy route poster (the image behind the old site's `REACT_APP_ROUTE_IMAGE_URL`) | Not migrated; the site shows the route as a map of the linked recording (`route_preview`, 1.3a) and never a poster. |
| `event_updates` (`id, message, time, created_at`) | `event_message` on the event whose year is the year of `time`, or of `created_at` when `time` is null; `body = message`, `created_at` copied; `time` only picks the event and is not stored. An update whose year has no event is logged and skipped. |
| `sponsors` | `sponsor` with ids preserved (`overriding system value`), columns straight across (`fb_url`, `ig_url` unchanged); the legacy full logo object, when present, becomes a media asset (next row) and `logo_media_id` points at it; after the copy, `select setval(pg_get_serial_sequence('sponsor', 'id'), (select max(id) from sponsor));`. The same `setval` follows the copy of every table whose legacy ids are preserved. |
| Legacy full logo objects (`sponsors.logo_s3_key`) | One `media_asset` per sponsor with a logo: the tool reads the legacy object, runs the API's confirm pipeline on the bytes (sniff, SVG validation, dimensions, variants), writes `media/{uuid}/{filename}` (filename from the legacy key's last segment, sanitized) and the variants to the new bucket with the immutable header, and inserts the row with `state = 'ready'`, `uploaded_by = 'migration'`, `alt` = the sponsor name. Legacy small logos are not copied; the variants replace them. A logo that fails validation is logged and skipped, leaving `logo_media_id` null. |
| `sponsor_years` | `sponsor_year`, same columns; rows with null `sponsor_id` are logged and skipped; null booleans take the column defaults. |
| `sponsor_settings.linger_rate_ms_per_dollar` | `app_setting sponsor_linger_ms_per_dollar` with `updated_by = 'migration'`. |
| `funds` (`percent, id, created`) | For each year of `created`, the row with the greatest `created` sets that year's `event.funds_percent`; `percent` is read through `percent::text` (the cast covers both the `bigint` and the `text` column type the legacy reference lists), parsed as an integer, clamped to 0 to 100; unparseable rows are logged and skipped. |
| `messages` (`email, name, message, created, id`) | `contact_message`: `name`, `email`, `body = message`, `client_ip = ''`, `created_at` from `created`. |
| `tracking_mode*`, `tracki_device*`, `event_mode_override`, `gps_location`, `liftoff` | Not migrated. |

The legacy site's sponsor payload (`id, name, website_url, fb_url, ig_url, logo{full, small, full_url, small_url}, latest_year, active, anonymous, can_advertise, linger, years_as_sponsor`) maps onto `snapshot.sponsors` as `id, name, websiteUrl, fbUrl, igUrl, logoMediaId, latestYear, lingerMs, yearsAsSponsor`; `active`, `anonymous`, and `can_advertise` are the filter in 1.3 rather than fields.

Cut-over order:

1. The legacy API is already stopped and removed from the manifest; the legacy site serves a static snapshot and the legacy database stays readable.
2. Create the new database and roles; deploy the new API to the new manifest entry; it migrates the schema, seeds the role pages and the starter content, publishes content version 1, writes the icon library, and builds snapshot version 1 on boot.
3. Run the migration tool against the new database and bucket.
4. `POST /admin/snapshot/rebuild`.
5. Verify `GET /api/health`, `GET /admin/snapshot`, and `<cdn>/live/location.json`.
6. Point the site and panel env vars at the new API, CDN, and pool; deploy them.
7. Create the new year's event (it inherits the 2025 recording), set it current.
8. Editors replace the starter content with the real copy and images through the panel and publish; nothing about the site's text or images lives in a repository.

---

## 11. Failure modes

| Failure | Effect | Behaviour |
|---|---|---|
| Gateway internal listener unreachable from a node | publishes fail; leader poll fails | The node stores and PUTs normally; the site runs on the poll; the node is a follower, so chores halt until any node sees the listener again. Logged at Warning with a `wmsfo_leader_lost` marker; a CloudWatch metric filter on it alarms when no node has been leader for 60 s. |
| Gateway fleet down | API unreachable on both URLs; hub down | Red-Nose keeps retrying both doors on its backoff; the site polls the CDN and renders the last object. Nothing in the API needs an operator action; the fix is the gateway's. |
| S3 PUT of `live/location.json` fails on the ingest path | CDN lags one fix | Logged; the publish is attempted whether or not the PUT succeeded, so the hub carries the current point; the next fix retries the PUT; the apply rule (1.2) discards the older polled object. |
| S3 PUT of `live/location.json` fails after an admin write | `snapshotUrl` or status not reaching the CDN | Three retries; then `live_state.last_write_error`, surfaced as `lastWriteError` on `GET /admin/live` from every node and rendered red on the dashboard's published-state card (1.11); the admin uses `POST /admin/live/republish`. The hub publish still went out. |
| S3 PUT of a snapshot or route fails | admin write fails | Rolled back; `502 snapshot_write_failed` or `route_write_failed`. |
| Media confirm fails after the upload (variant PUT, tag removal) | asset stays `pending` | `502 media_write_failed`; the panel offers Retry, which calls confirm again (idempotent while pending); an abandoned pending asset expires by lifecycle rule and cleanup. |
| A publish references an asset that is not ready | publish refused | `422 content_invalid` naming the section and path; nothing written. |
| Database unreachable | `GET /api/health` is `503`; every endpoint `500 internal_error` | The gateway keeps routing to the node: its aggregate health never fails the load balancer check and each instance proxies only to its local container. Requests that land on that instance answer `500 internal_error` and hub joins on that instance are denied until the database returns; the site keeps rendering from the CDN. A CloudWatch metric filter on `unavailable` from `/api/health` or on the `500` rate is the operator signal. |
| SES failure | alerts delayed | Per-delivery attempts up to 5, then the row is skipped and visible in the table; the outbox row is retried on its own attempt counter. |
| Backplane degraded | publishes dropped with `202` | The site's poll closes the gap within one interval. |
| Two nodes leader for a loop | chores overlap | Idempotent by `alert_delivery` uniqueness and the outbox claim. |
| Status 3 with no active beacon or a stale one | live screen with no marker | Accepted; the panel's confirmation shows the beacon state before the change; the site renders the waiting state (1.9). |

---

## 12. Sequence summaries

**A fix reaches a browser (hub path)**: Red-Nose `SendToChannel` to the gateway; gateway `POST /realtime/message` to the API; API runs the location transaction and answers `200`; gateway resolves Red-Nose's invoke; API updates memory, PUTs `live/location.json`, POSTs `/internal/publish`; gateway fans out `ChannelEvent { channel: "<service>:location", event: "location", data }` to every joined browser; the browser applies it.

**A fix reaches a browser (poll path)**: the same until the PUT; the browser's next poll fetches `live/location.json` through CloudFront (one origin read per second per origin at most).

**Admin sets an event live**: `POST /admin/events/7/status { statusId: 3, notify: true }`; the transaction in 7.3 with the history row and outbox `event.status_changed`; commit; the node writes the live object with `eventStatusId: 3` and the new `snapshotUrl` and publishes it; every browser switches to the live screen on the next hub event or poll and fetches the new snapshot; the leader chore fans out `Santa just lifted off`.

**Editor adds a sponsor during the event**: `POST /admin/media/upload-url`, the browser's PUT to S3, `POST /admin/media/{id}/confirm`, then `POST /admin/sponsors` and `PATCH .../{id} { logoMediaId }`, then `PUT .../years/2026`; each sponsor write is a snapshot rebuild and a live-object write; browsers fetch the new snapshot on the next hub event or poll.

**Editor changes the about page**: `PATCH /admin/sections/10 { data }` (draft-validated, nothing published); `POST /admin/content/preview-token` and the preview frame shows it; `POST /admin/content/publish` inserts the version, rebuilds the snapshot with the new `content`, commits, writes the live object with the new `snapshotUrl`; every browser fetches the new snapshot on its next hub event or poll and re-renders the page.

**Person leaves a cookie**: `POST /cookies` with the ID token; the API inserts and increments its own tally; every node re-reads the tally on its next tick (1 s), the ingest node's next live-object write carries it, and the leader rewrites the object within a tick when no fix is flowing (7.4).

**Beacon enrollment**: `POST /admin/beacons` returns the key and `enrollment.qrPngDataUrl`; the phone scans `rednose://enroll?api=...&token=...`; `POST /beacons/enroll` returns the key, URLs, and `ingestChannel`; the service starts, joins `<service>:ingest`, and heartbeats.

---

## 13. Shared contract artifacts

The API repository holds `contracts/`:

| Path | Content |
|---|---|
| `contracts/openapi.json` | The OpenAPI 3.1 document for every REST endpoint in section 4, generated at build time from the API's endpoint metadata and checked in; a CI check fails when the checked-in file differs from the build output. The site and the admin panel generate their client types from it. |
| `contracts/schema/live-object.schema.json`, `snapshot.schema.json`, `route.schema.json`, `location.schema.json`, `heartbeat.schema.json`, `realtime-authorize.schema.json`, `realtime-message.schema.json` | JSON Schema (draft 2020-12) for the CDN objects, the two beacon bodies, and the two callback bodies. |
| `contracts/schema/primitives.schema.json`, `content-document.schema.json`, `site-settings.schema.json`, `sections/<kind>.schema.json`, `sections/<kind>.item.schema.json` | The content model (1.3a): the shared primitives (`Icon`, `MediaRef`, `Link`, `Inline`, `Presentation`, `Block`, and the event's `RouteMapConfig`), the document, the site settings, and one publish-level schema per section kind (and per item kind). Hand-written in the API repository; the API loads them at boot for validation and serves them on `GET /admin/content/kinds`; the site and the panel generate types from them and the panel generates its forms from them. |
| `contracts/kinds.json` | The section kind registry: `kind`, `title`, `description`, `live`, `hasItems`, `allowedRoles`, `defaults`, `itemDefaults`, in palette order. |
| `contracts/starter-content.json` | The `ContentDocument` the first boot seeds and publishes as version 1 (with `mediaId` references to nothing, so it uses library icons only). |
| `contracts/fixtures/live-object.json`, `snapshot.json`, `route.json`, `location.json`, `heartbeat.json`, `content-document.json` | Canonical examples, validated against the schemas in the API's tests and consumed by the site's and Red-Nose's tests. `live-object.json` and `snapshot.json` are the canonical (1.6) serialization of the 1.2 and 1.3 examples with concrete values: full 64-character hex keys and `https://cdn.example` as the CDN base. |
| `contracts/fixtures/themes/<key>.json`, `contracts/fixtures/themes/seed.json` | The eight seeded tracker theme bodies (sql.md 6; `route-light`, `route-dark`, and the six Google keys), each the canonical (1.6) style body whose hash is the row's `styleSha256`, and `seed.json`, the eight rows' `renderer`, `key`, `name`, `sortOrder`, `styleSha256`, `styleBytes`, `chrome`, `overlay`, `defaultLightMode`, and `defaultDarkMode` in seed order: the migration's seed values, which a test holds equal to the file. Generated once from the site's retired style builder and its six theme files; a change to any of them is a migration. |
| `contracts/admin-thresholds.json` | `{ "batteryLowPercent": 20, "noFixAgeS": 30, "noLocationAgeS": 30 }`, the constants in 1.11 (`staleAfterS` is not one of them; it comes from `GET /admin/beacons`). |
| `contracts/help-keys.json` | `[ { "key", "page", "label" } ]`, one per entry of `help/topics.json` in file order, canonical JSON: the help topic keys the admin panel may ask `GET /admin/help` for (4.5 Help). |
| `contracts/icons/<id>.svg` | The icon library, byte-identical to `icons/` in the API repository (a CI check compares them), so the site can vendor it with the contracts and generate inline icon components (1.5). |
| `contracts/CONTRACTS_VERSION` | An integer bumped on every change under `contracts/`; currently 58 (`contracts/help-keys.json` added; `GET /admin/help`, `PUT /admin/help/{key}`, `POST /admin/help/{key}/reset` and the `HelpTopic` and `HelpLink` shapes in `openapi.json`, 4.5 Help; the `help` capability, 3.6). Previously 57 (`settings.places` holds the places both maps draw, the tracker's and the route preview's lists apart; `map` data without `poiFilter` and `poiKinds`; `RouteMapConfig` without `pois`, 1.3 and 1.3a). Before that 56 (`map` data gains `poiFilter` and `poiKinds`, the tracker's choice of Google-supplied place kinds, 1.3a). |

Distribution: the site, admin panel, and Red-Nose repositories each vendor a copy of `contracts/` and a `CONTRACTS_SHA` file naming the API commit it came from; a CI step in each consumer repository fetches that commit's `contracts/` and fails when the copy differs. Updating a consumer is a copy plus a `CONTRACTS_SHA` bump in one commit.

Tests the artifacts drive: Vitest on the site store, page selection, section registry (every kind in `kinds.json` has a component and renders the fixture), inline parser, and `srcset` builder using the fixtures; the panel's form generator against every kind schema; Red-Nose unit tests serializing `LatestFix` against `location.schema.json` and the heartbeat body against `heartbeat.schema.json`; the API's serializer test asserting byte equality between `fixtures/live-object.json` and the API's own output for the same data; Playwright against the preview site and the dev stack walking the status table with the admin API while Red-Nose's replay mode plays the 2025 route.

---

## 14. Decisions made here

- Bare paths, no version prefix; admin routes under `/admin/*`; the only `/api` path is `/api/health` because the gateway probes it.
- Error shape is the custom `{ code, message, details, requestId }` object, not problem+json.
- Every CDN JSON object carries `schemaVersion: 1` as its first key; an unknown value makes the site stop applying and show a reload prompt.
- The live object is the design's field set plus `publishedAt`. Apply rule: a different event replaces only on a greater `publishedAt`; within one event the site discards a lower `seq`, a null `seq` after a non-null one, and a lower or equal `publishedAt` on equal `seq`.
- The snapshot object carries no `version` or `builtAt` (they stay on the row), so identical data yields identical bytes and the same key.
- Tightened polling is `max(1000, pollIntervalMs / 2)` while live and the hub is disconnected or quiet for `2 * pollIntervalMs`; no extra settings or fields carry it.
- The site switches pages on the live object immediately and renders time-shaped elements blank until the matching snapshot arrives; the signal-lost indicator shows after 30 s without a `seq` change while live, measured with `performance.now()`.
- Only the node that stored a fix, took the admin write, or handled the republish writes the live object, plus the leader once per tally change while live. A node that sees a version change on the tick refreshes memory only, except one that wrote for a stored location since the previous version change, which rewrites the object once so the CDN copy never stays behind an admin write.
- The live object's PUT and publish are independent: the publish goes out whether or not the PUT succeeded. Admin responses are sent after commit and never wait for the live-object write.
- Live-object write outcome is fleet-wide in the single-row `live_state` table; `GET /admin/live` returns it at the top level and the node's own memory under `node`.
- `seq` is per event from `event.next_seq` under the event row lock; unique `(event_id, seq)` is the only full index on `location` besides the partial published index.
- Only the writing node publishes to the hub; nothing but `location` on `<service>:location` is ever published; `event` and `cookies` are reserved topics.
- Channel prefix is parameterized: `WMSFO_SERVICE_NAME`, `VITE_HUB_CHANNEL_PREFIX`, and `ingestChannel` in the enrollment response.
- The admin panel has a dev deployment from `dev` at `<admin-dev-domain>` and a prod deployment from `main`.
- The admin panel polls (5 s on the dashboard and beacons views) and does not use the hub; its dashboard compares the CDN object with the API and offers Republish on a persistent mismatch; it asks for confirmation before setting status 3 and before rotate, revoke, or deactivate on the active beacon while an event is live.
- The ID token is the bearer on both frontends; person rows are upserted on every authenticated call.
- Admin TOTP is enforced by the API through `AdminGetUser` (`403 mfa_required`), not by an operator procedure.
- Two database roles per environment (`sql.md` 12): migrate owns and migrates, app serves requests.
- Beacon key `wbk_` + 43 base64url chars, SHA-256 at rest with a 12-character display prefix; enrollment token `wet_`, 15 minutes, single use, carrying an AES-256-GCM copy of the key; the API returns a PNG QR rendering; rotation is the only way to get a fresh token; revoke is permanent.
- The hub identity is `"<beaconId>:<keyVersion>"` rather than the bare beacon id, and the message path rejects a stale `key_version`, so a rotate stops the old phone at its next message.
- Heartbeats are HTTP only; the hub carries locations only. The heartbeat answer carries `liveEventId` and `isActive`; a heartbeat `401` shows a revoked banner on the phone without stopping any loop. Send failures before the phone has learned a live event do not count in `sendsFailedSinceBoot`.
- Beacons have no roles: registering a beacon is registering a key, and the API never knows what runs behind it. A heartbeat is `sentAt`, an optional typed `health` core (battery, fix age, socket state) the panel colours, and an optional free `debug` object the panel renders as a JSON tree and never interprets. `POST /beacons/logs` is open to every beacon.
- An event goes live only with a healthy active beacon (not revoked, heard from within `beacon_stale_after_s`); the socket is not part of health. `409 no_healthy_beacon` otherwise.
- Cookie moderation does not exist: no hide, unhide, delete, or per-event cookie list on the API or the panel; the tally is every cookie left. Deleting a cookie type deletes its cookies with it.
- Large rasters get a Deep Zoom tile pyramid at confirm, served immutable from the CDN beside the asset; a deep-zoom viewer is OpenSeadragon over it with fullscreen, and a new image is a new asset, so nothing is ever stale.
- The public site owns its sign-up and sign-in pages and speaks to the people pool through the Cognito API (SRP); only the admin panel uses a Cognito-hosted page.
- Two more beacons are fleet services: the simulator (replays a past year through the events capability of an API key) and the legacy beacon (polls the Heroku tracker every second); both are ordinary enrolled beacons.
- `serverTime` is stamped at response serialization after commit; Red-Nose computes skew from the request midpoint.
- SignalR keep-alive 15 s and client timeout 30 s on every client; the load balancer idle timeout stays at or above 60 s.
- Anonymous `SendToChannel` on the public channel reaches the API's no-I/O `403` branch until the gateway forwards client messages only for credentialed joins (gateway backlog).
- The callback endpoints are guarded by the `X-Forwarded-*` check; a gateway-side callback token is a later gateway feature, not a v2 dependency.
- The public-topic authorize branch does no I/O, bypasses the rate limiter, and logs at Debug.
- `hubConnected` on the beacon object comes from the gateway's presence owner API (`GET /internal/presence/<service>:ingest`), one call per beacons request, null when the call fails.
- The stale-beacon flag considers both heartbeats and stored locations, never flags a beacon that has never connected, and is cleared by either.
- `went_live_at` and `ended_at` are re-stamped on every entry into status 3 and 4 respectively, overwriting earlier values; `PATCH` corrects either.
- The flight stamps follow the status entered, from any status (2026-10-03): entry into 1, 2, 5, or 6 sets `went_live_at` and `ended_at` to null; entry into 3 sets `went_live_at = now()` and `ended_at` to null; entry into 4 sets `ended_at = now()` and keeps `went_live_at`. A status change never touches `scheduled_at`.
- Entering status 2 requires `scheduledAt` to be set (`409 scheduled_at_required`), and `PATCH` cannot null it while the status is 2.
- `POST /admin/events` takes an explicit `inheritRoute` boolean; route inheritance never depends on a field being absent.
- CDN CORS for reads is a CloudFront response headers policy allowing `*`, with `Origin` out of the cache key; the bucket's only CORS rule admits the admin panel's presigned `PUT` uploads.
- The current event is an explicit `event.is_current` flag set by `POST /admin/events/{id}/current`; nothing derives it from the year.
- `POST /admin/events/{id}/current` on the already-current event is a no-op `200`.
- `latestMessage` is the message with the greatest `created_at`; ties go to the greatest `id`.
- The snapshot carries one message, `latestMessage`, and the site marks it read per browser; nothing on the API side holds a message list for the site.
- Every cookie left counts toward `cookie_limit_per_person` and toward the tally; nothing removes one short of deleting its event.
- The tally is frozen in `event.final_cookie_tally` on entry into status 4 and carried unchanged by every later live object for that event.
- Anonymous sponsor years are omitted from the snapshot entirely; admin views still show them.
- A sponsor year with `can_advertise = false` is left out of the snapshot entirely, so the sponsor appears nowhere on the site; `canAdvertise` is not a public field.
- The snapshot's sponsor fields keep `fbUrl`, `igUrl`, and `logoMediaId`, plus `latestYear`; `lingerMs` floors at `sponsor_linger_min_ms` (default 2000); logos resolve through the media map and its WebP variants, so there is no separate small logo.
- `POST /admin/routes/from-event/{eventId}` builds a route from an event's published locations; upload remains the other source.
- The route object is `{ schemaVersion, name, points[{ lat, lng, recordedAt }] }` with no other keys, 2 to 50,000 points; a re-upload with identical content returns the existing route; routes can be deleted when unreferenced. It is a flight recording for replay, export, and tests; the site never fetches it.
- The route the public sees is the map: `route_preview` draws the event's linked recording as a smoothed path over a self-hosted OSM basemap with a 5 minute time slider, from `event.routeMap` (bounded by the three `route_map_*` settings), and renders its empty text when there is no recording or no basemap; its display knobs and control switches are configured once per event as `event.routeMapConfig`, never per section or sitewide, its landmarks are the one sitewide `settings.landmarks`, which the live tracker draws too, and its places are the sitewide `settings.places.routeMap`. The tracker shows only where Santa is; its "flight history" toggle draws the recording linked to the event as a projected route, embedded in the snapshot as `event.flightHistory` (thinned to `flight_history_max_points`) so the first snapshot fetched carries it and the admin sets it per event through `routeId`.
- Sponsors carry no tiers. Display order is pinned sponsors by position, then amount donated descending; the carousel plays that order and never shuffles. `sponsor_year.pinned_position` and `linger_ms_override` are per year; `PUT /admin/sponsors/order/{eventYear}` sets the whole pinned list atomically.
- Site settings carry only the seasonal layer defaults (`snowDefault`, `lightsDefault`), the background ornaments switch (`ornaments`), and the card fill opacity per theme (`cardOpacityLight`, `cardOpacityDark`; 1.3a). Colours, type, and the light/dark/system choice are the site's own; the visitor's scheme choice is stored in the browser and never published.
- API keys (`wak_`) reach every admin group by capability, can carry every capability or a chosen subset, can expire, are minted only by a Cognito admin with TOTP, and can never touch the key endpoints.
- The S3 PUT inside an admin transaction gets one attempt with a 3 s timeout so fixes never wait longer than that on the event row lock.
- `amountDonated` is a JSON number with two decimals, parsed as decimal by the API and never computed with by clients.
- Every image is a media asset or a library icon; clients render SVG only through `<img>`.
- Status and message writes carry a required `notify` boolean; every status change writes an outbox row; emails go out only for entries into 2 and 3 with `notify` true and for messages posted with `notify` true.
- Alert sending is capped by `WMSFO_ALERT_SEND_PER_SEC` (default 10); outbox rows and deliveries stop retrying after 5 attempts; bounces and complaints rely on the SES account suppression list.
- Verify links land on `/alerts/verify` and unsubscribe links on `/alerts/unsubscribe` on the site, which call the API POSTs; the API's unsubscribe endpoint also reads the token from the query string for RFC 8058 one-click.
- Subscription verification is required even when the address equals the Cognito email; verify tokens are hashed at rest and expire in 24 h, the plaintext travels only in the `subscription.verify` outbox row, and the hash stays on the row after verification so the verify page is idempotent; unsubscribe tokens are plaintext and stable; subscriber addresses are stored lowercased.
- Nightly cleanup runs at 09:00 UTC: tokens 24 h, outbox 30 d (deliveries cascade with their outbox row), unverified subscribers 7 d, beacon logs 30 d; contact messages and cookie notes have no automatic retention.
- Deletes exist for events (no locations, not live), routes (unreferenced), subscribers, contact messages, and people (with their subscriptions and cookies).
- `beacon_stale_after_s` is a setting (default 45) and rides on the beacons list as `staleAfterS`; Red-Nose debug logs live in Postgres, never in the bucket.
- Replay sends to the enrolled API with the enrolled key and is offered only when the enrolled API is not the prod API.
- Migration derives years from `America/Denver` calendar dates, reads `funds.percent` through a text cast, advances identity sequences after copying preserved ids, and takes the event name format as an argument (default `Santa Flyover {year}`).
- One page per event status, plus a no-event page, all admin-composed; the site holds kinds, never screens.
- The content document is the newest `content_version.document` verbatim; identical content publishes to the same snapshot key; `content_unchanged` refuses a no-op publish.
- Working-set writes are draft-validated and never rebuild the snapshot; publish is the only path to the site and is strict.
- The seven role pages are seeded; a role page is deleted only by handing its role to a `none` page (`roleTo`), so every role keeps one page; ordinary pages are free; slugs are one segment with five reserved names.
- Presentation, `Icon`, `MediaRef`, `Link`, `Inline`, and `Block` are the only shared vocabulary; kinds never define their own shapes for them.
- Media uploads are presigned PUTs to a private bucket with a pending tag; confirm verifies, derives 480, 960, and 1600 WebP variants, and strips the tag; lifecycle rules expire pending and orphaned objects; orphan collection is a leader chore with a 30-day grace and a 7-day undo.
- Sponsor logos and cookie type artwork are references into the media library and the icon library; there are no per-resource upload endpoints.
- The icon library ships in the API repository and is written to the bucket once per library change under the migration lock.
- Restore loads a version into the working set and publishes nothing; rollback is restore then publish. A role page whose role the version has no page for stays in the working set, so every role keeps its page.
- Status 6 is `postponed`, with its own role page (`postponed`) and alert template (`event_postponed`); any status may follow any other and entry into 6 has no gate. Existing deployments get the postponed page from the migration that adds the status, unpublished until an editor publishes.
- Preview tokens are `wpv_`, 15 minutes, hashed at rest, served through one public endpoint that the site's `/preview` route consumes.
- Two groups, `editor` and `admin`, two policies; both need TOTP.
- Every status change can notify subscribers (one template per status, a custom message allowed), a status can be announced again later with `POST .../notify`, and the event carries `statusNotifiedAt` so the panel can say nobody was told. Emails go out only when an admin says so.
- Every admin write is audited in its own transaction (`audit_log`: actor, action, entity, before and after); audited resources carry the newest stamp; the log is never pruned and can be read back by entity or by action.
- A person can read the alerts sent to them (`GET /me/alerts`); the site shows that history on the alerts page.
- Sponsor years copy forward per sponsor or in bulk; an event clones with its sponsors, recording, and route map configuration as the admin ticks.
- Poster tiles are lossless PNG at the poster's own pixels and the viewer never zooms past 1:1; earlier JPEG pyramids stay valid through their descriptor.
- Printed QR codes are permanent numbered tags at `/q/<tag>`, printed in batches at any size; places are a tree with a note and an optional pin; an attachment is the history; scans count against the code and roll up the tree; the snapshot carries every active code resolved so the site never asks the API what to open; the only public write is the scan beacon, always `204`.
- A third admin-pool group, `canvasser`, reaches exactly the QR and places routes; deletes stay admin.
- The location ingest filter is the API's, and beacons stay blind to it. Three rules decide the outcome: the per-beacon min interval (`location_min_interval_ms` and the `beacon.min_interval_ms` override, in memory on the node; a fix inside the interval is `dropped` with no row and no publish), the optional min distance (`location_min_distance_m`, in the transaction against the beacon's last stored fix; a closer fix is carried), and one row per position per event (the unique `(event_id, lat, lng)` index, `on conflict do nothing`; a repeat of any position already in the event is carried). A carried fix still advances `event.next_seq` and moves the live object (contracts 1.2), so the site needs no change; the `LocationRow` and CSV gain `speedSource` (`beacon`, `derived`, or null) and `speedMps` on the live object is the beacon's value when present or the API-derived one.
- A position is stored at most once per event: unique `(event_id, lat, lng)` on `location`, and the ingest insert runs `on conflict do nothing`; a repeat anywhere in the event is carried, so a replayed flight loops without growing the recording and beacons and the site stay unaware.
- The hub can be switched off in two independent places, both in the API and the panel and neither in a beacon: per beacon (`hub_allowed`, denied at the authorize callback, the beacon falls to HTTP by its own contract) and for every visitor (`hub_enabled`, carried on the live object, the site runs on the poll). Beacons and the site never need a build for either.
- Clearing a recording is `DELETE /admin/events/{id}/locations?beaconId=`: 204 on success, 409 while the event is live; `next_seq` is not reset; the audit action is `event.locations_cleared` and the site keeps whatever it holds until the leader's next tick rewrites the live object.
- The panel warns before a send that would pass the SES 24 hour quota, from `GET /admin/email/quota`; the API never refuses a send for it.
- An admin seeds cookies on the live event with `POST /admin/events/{id}/cookies` (2026-10-02): rows with `person_id` null and `seeded_by` the actor (`cookie_origin_check` requires exactly one of the two); they count in every tally and never toward any person; `409 event_not_live` outside status 3; audited as `cookies_seeded`; no outbox row and no snapshot rebuild.
- One message store (2026-10-03): the text typed on a status change or an announcement is an `event_message` row (created by the actor), written with `notify` on or off; the history row references it (`message_id`, set null when the message is deleted), the snapshot shows it as `latestMessage`, and the status email carries its body as `{{customMessage}}` in place of the stock paragraph.
- A status change always posts a message (2026-10-03): without typed text the template's stock paragraph for the new status is the event message's body, with `notify` on or off, so the site, the history, and the email carry one text; an announce without text posts nothing and its email renders the stock paragraph. `AlertItem.message` carries the body of the message an alert references.
- A message's time is its `createdAt` (2026-10-04): the time it was sent, never an admin-entered date, so `EventMessage` and `event.latestMessage` carry no `eventTime`. A message posted with `notify` counts its emails on its own row (`notify`, `sentCount`, the outbox row), the way a status change counts them on its history row; the message a status change or an announcement posts keeps `notify` false and the count stays on the history row.
- Landmarks are a site setting (2026-10-04): `settings.landmarks` is one sitewide list the route preview and the live tracker both draw, the same places every year; the tracker shows them by default (`controls.landmarks` on the `map` section, absent means true); the POI categories stay per event in `event.routeMapConfig.pois`. Migration `A83GlobalLandmarks` folds the per-event landmarks into the settings draft, and the editor publishes for them to reach the site.
- The tracker's places are a map section choice (2026-10-04): `map` data carries `poiFilter` and `poiKinds`, the Google-supplied place kinds the live tracker shows while the filter is on; the route preview keeps its own per-event `routeMapConfig.pois.kinds` because the two basemaps classify places differently. Landmarks are called Viewpoints wherever a person reads them (2026-10-04); the contract keys `settings.landmarks` and `controls.landmarks` keep their names.
- The poster never reaches the site (2026-10-04): the route preview is the map only (`route_preview` data is `heading`, `disclaimer`, `emptyText`; no `style`), and the event has no route image (no `event.route_image_media_id`, no `routeImageMediaId` on the snapshot or the admin `Event`, no clone flag for it). Posters exist for the panel's poster studio and for distribution off the site. Migration `A84RoutePreviewMapOnly` strips `style` from the working set's `route_preview` sections and drops the column; published versions are immutable and the site ignores `style` in older documents.
- The places on both maps are one site setting (2026-10-05): `settings.places` holds the tracker's list (`tracker`, Google-supplied place kinds) and the route preview's list (`routeMap`, basemap tile kinds) apart, because the two maps classify places differently; neither a section nor an event carries a choice. This supersedes the two 2026-10-04 placements, the POI categories per event in `event.routeMapConfig.pois` and the tracker's `poiFilter` and `poiKinds` on the `map` section, both now superseded. Migration `A88GlobalPlaces` folds the first filtering `map` section and the current (else newest) event's `pois` into the settings draft and strips the old keys; the editor publishes for the setting to reach the site.
- Tracker maps and themes are data (2026-10-08): a map is a `tracker_map` row for a tile package the operator built with the tile CLI and uploaded through API-signed multipart URLs (4.5 Maps); a theme is a `tracker_theme` row for one renderer with its style body on the CDN, its chrome and overlay colours, a thumbnail, and the two default flags, one holder per renderer (4.5 Themes); the `map` section loses `themes` and `defaultTheme`. Every event carries a required bounding box (`event.trackerBbox`) that both renderers lock to, taken from the site setting `settings.tracker.defaultBbox` at create unless the admin draws another; an event with a `ready` map renders MapLibre and an event without one, or a browser without WebGL 2, renders Google Maps with the event's enabled Google themes, so every event enables at least one Google theme. Deletes follow 4.5 as it stands (impact preview, unlink by default, `blocked` only for the last Google theme on an event) with an optional `replacementId` on the delete body. The snapshot gains `event.trackerBbox`, `event.trackerMap`, and `trackerThemes`; `live/location.json` is unchanged. Migration `A<task>TrackerMapsThemes` seeds the current basemap as the first map, the two route flavors and the six Google themes as the first theme rows, and fills every event with the Missoula valley box.

## 15. Needs a decision

Nothing at the moment. Add here as it comes up.
