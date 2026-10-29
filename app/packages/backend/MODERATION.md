# Opt-in local address ban check

`GET /v1/moderation/ban/address/{address}` now has an independently implemented,
opt-in read model over a supplied ban list. Without `moderationStore` /
`MODERATION_BANS_FILE`, the existing explicit fixture replay or
`501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No ban list is enabled by default.
This does not implement issuing, lifting or appealing bans, moderation tooling,
reasons, audit history, wallet ownership, sessions, a production proxy or a
native-compatible moderation service.

## Declared source

- Developer operation `get_moderation_ban_address_by_address`, scope
  `moderation.read`, declared origin `https://api.pump.fun/v1`.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  The success schema is a bare boolean: "true while the address is banned (a
  permanent ban, or a temporary ban that has not expired); false otherwise.
  Never null." Tests check real in-process responses against that schema.

The implementation uses only this public contract. No captured website code,
factory or upstream response informs it.

## Local data model

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-28T00:00:00.000Z",
  "bans": [
    { "address": "SyntheticPermanentBan1111111111111111111111", "expiresAt": null },
    { "address": "SyntheticTemporaryBan1111111111111111111111", "expiresAt": "2026-10-29T00:00:00.000Z" }
  ]
}
```

- `expiresAt: null` is a permanent ban. A timestamp must be canonical
  millisecond ISO-8601 UTC; the ban is active strictly before that instant and
  is evaluated per request against the clock, not at load time.
- Addresses are opaque, compared verbatim: no case folding, trimming, base58
  decoding or chain inference. Empty, whitespace/control-containing, over-128
  character and duplicate addresses reject the whole dataset.
- `dataSource` is `synthetic` or `local-materialized`. Unknown keys, sparse
  arrays and other schema versions are rejected.
- The startup loader reads one bounded (8 MiB) regular file, refuses symlinks,
  and decodes UTF-8 fatally. No reloads, writes or network access.

## Response and explicit local boundaries

- `200` with `true` or `false` and `Content-Type: application/json`. `false`
  means only "not actively banned in this supplied list"; it is never a
  production verdict.
- Successful responses carry `Cache-Control: no-store`,
  `X-Reconstruction-Data-Source`, `X-Reconstruction-Observed-At` and
  `X-Reconstruction-Compatibility: unqualified`.
- The operation declares no query parameters. Any query returns local
  `501 COMPATIBILITY_NOT_IMPLEMENTED` with reason
  `MODERATION_QUERY_UNSUPPORTED`. This envelope is local policy, not a captured
  production response.
- The existing native `apiKeyGate` runs first. This does not implement
  production key verification, scope authorization or rate-limit headers.

`test/moderation.test.ts` covers permanent, unexpired, exactly-expired and
unlisted addresses, the per-request clock, verbatim matching, the query
boundary, the key gate, default 501 and fixture preservation, dataset
validation and the startup loader. No feature-wide completion credit is added.
