import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import {
  ModerationStore,
  loadModerationStore,
  type ModerationDataset,
} from "../src/moderation-store.js";
import { assertSchema } from "../src/schema-validator.js";

// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const now = Date.parse("2026-10-29T00:00:00.000Z");
const spec = JSON.parse(
  readFileSync(
    new URL("../../../contracts/developer.openapi.json", import.meta.url),
    "utf8",
  ),
);
// Synthetic addresses only; none identifies a real wallet.
function dataset(): ModerationDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: "2026-10-28T00:00:00.000Z",
    bans: [
      {
        address: "SyntheticPermanentBan1111111111111111111111",
        expiresAt: null,
      },
      {
        address: "SyntheticTemporaryBan1111111111111111111111",
        expiresAt: "2026-10-29T00:00:00.001Z",
      },
      {
        address: "SyntheticExpiredBan11111111111111111111111",
        expiresAt: "2026-10-29T00:00:00.000Z",
      },
    ],
  };
}
function contract(body: unknown) {
  assertSchema(
    body,
    spec.paths["/moderation/ban/address/{address}"].get.responses["200"]
      .content["application/json"].schema,
    "moderation ban check",
    spec,
  );
}
async function withApp(
  run: (app: ReturnType<typeof buildApp>) => Promise<void>,
  store: ModerationStore | undefined = new ModerationStore(
    dataset(),
    () => now,
  ),
) {
  const app = buildApp([], { moderationStore: store });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}
const url = (address: string) =>
  `/v1/moderation/ban/address/${encodeURIComponent(address)}`;

test("permanent and unexpired temporary bans read true; expired and unlisted read false", async () => {
  await withApp(async (app) => {
    for (const [address, expected] of [
      ["SyntheticPermanentBan1111111111111111111111", true],
      ["SyntheticTemporaryBan1111111111111111111111", true],
      // expiresAt is exclusive: a ban expiring exactly now is no longer active.
      ["SyntheticExpiredBan11111111111111111111111", false],
      ["SyntheticNeverBanned1111111111111111111111", false],
    ] as const) {
      const res = await app.inject({
        method: "GET",
        url: url(address),
        headers,
      });
      assert.equal(res.statusCode, 200, address);
      assert.match(String(res.headers["content-type"]), /^application\/json/);
      assert.equal(res.body, String(expected));
      contract(res.json());
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
      assert.equal(
        res.headers["x-reconstruction-observed-at"],
        "2026-10-28T00:00:00.000Z",
      );
      assert.equal(
        res.headers["x-reconstruction-compatibility"],
        "unqualified",
      );
    }
  });
});

test("temporary bans follow the injected clock instead of a load-time snapshot", async () => {
  let clock = now;
  await withApp(
    async (app) => {
      const address = url("SyntheticTemporaryBan1111111111111111111111");
      assert.equal(
        (await app.inject({ method: "GET", url: address, headers })).body,
        "true",
      );
      clock += 1;
      assert.equal(
        (await app.inject({ method: "GET", url: address, headers })).body,
        "false",
      );
    },
    new ModerationStore(dataset(), () => clock),
  );
});

test("addresses match verbatim without case folding or trimming", async () => {
  await withApp(async (app) => {
    for (const address of [
      "syntheticpermanentban1111111111111111111111",
      " SyntheticPermanentBan1111111111111111111111",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: url(address),
        headers,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, "false");
    }
  });
});

test("undeclared query parameters return an explicit local 501", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: `${url("SyntheticPermanentBan1111111111111111111111")}?includeExpired=true`,
      headers,
    });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().reason, "MODERATION_QUERY_UNSUPPORTED");
  });
});

test("the existing API-key gate runs before the ban lookup", async () => {
  await withApp(async (app) => {
    for (const credential of [undefined, "Bearer invalid"]) {
      const res = await app.inject({
        method: "GET",
        url: url("SyntheticPermanentBan1111111111111111111111"),
        headers: credential ? { authorization: credential } : {},
      });
      assert.equal(res.statusCode, 401);
      assert.notEqual(res.body, "true");
    }
  });
});

test("without an injected store the route keeps the 501 fallback and fixtures still replay", async () => {
  const fallback = buildApp();
  try {
    const res = await fallback.inject({
      method: "GET",
      url: url("SyntheticPermanentBan1111111111111111111111"),
      headers,
    });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, "COMPATIBILITY_NOT_IMPLEMENTED");
  } finally {
    await fallback.close();
  }
  const replay = buildApp([
    {
      method: "GET",
      path: "/v1/moderation/ban/address/SyntheticFixture",
      status: 200,
      body: true,
      source: "synthetic moderation fixture",
    },
  ]);
  try {
    const res = await replay.inject({
      method: "GET",
      url: "/v1/moderation/ban/address/SyntheticFixture",
      headers,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "true");
  } finally {
    await replay.close();
  }
});

test("malformed datasets are rejected at construction", () => {
  const cases: Array<[string, (data: any) => void]> = [
    [
      "schemaVersion",
      (data) => {
        data.schemaVersion = 2;
      },
    ],
    [
      "dataSource",
      (data) => {
        data.dataSource = "production";
      },
    ],
    [
      "observedAt",
      (data) => {
        data.observedAt = "2026-10-28";
      },
    ],
    [
      "extra key",
      (data) => {
        data.extra = true;
      },
    ],
    [
      "duplicate address",
      (data) => {
        data.bans.push({ address: data.bans[0].address, expiresAt: null });
      },
    ],
    [
      "empty address",
      (data) => {
        data.bans[0].address = "";
      },
    ],
    [
      "whitespace address",
      (data) => {
        data.bans[0].address = "Synthetic Ban";
      },
    ],
    [
      "oversized address",
      (data) => {
        data.bans[0].address = "a".repeat(129);
      },
    ],
    [
      "non-canonical expiry",
      (data) => {
        data.bans[1].expiresAt = "2026-10-29T00:00:00Z";
      },
    ],
    [
      "missing expiry",
      (data) => {
        delete data.bans[1].expiresAt;
      },
    ],
    [
      "sparse bans",
      (data) => {
        data.bans = [, data.bans[0]];
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const data = structuredClone(dataset()) as any;
    mutate(data);
    assert.throws(() => new ModerationStore(data), TypeError, label);
  }
});

test("startup loader reads a bounded regular UTF-8 file and rejects symlinks and invalid bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "moderation-"));
  try {
    const file = join(directory, "bans.json");
    writeFileSync(file, JSON.stringify(dataset()));
    const store = loadModerationStore(file);
    assert.equal(
      store.isBanned("SyntheticPermanentBan1111111111111111111111"),
      true,
    );
    assert.equal(store.dataSource, "synthetic");

    const link = join(directory, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadModerationStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadModerationStore(link, 0), /file type/);
    assert.throws(() => loadModerationStore(directory, 0), /file type/);
    assert.ok(loadModerationStore(file, 0));

    const corrupt = join(directory, "corrupt.json");
    writeFileSync(corrupt, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadModerationStore(corrupt), TypeError);

    assert.throws(() => loadModerationStore(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
