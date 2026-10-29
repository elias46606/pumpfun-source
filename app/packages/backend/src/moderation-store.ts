import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";

/** Local inputs, not a recovered moderation schema or production ban registry. */
export interface ModerationBan {
  address: string;
  /** null is a permanent ban; otherwise the ban is active strictly before this instant. */
  expiresAt: string | null;
}
export interface ModerationDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  bans: ModerationBan[];
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BANS = 100_000;
function invalid(field: string): never {
  throw new TypeError(`Invalid local moderation dataset: ${field}`);
}
function record(value: unknown, keys: readonly string[], field: string) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(field);
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(item, key))
  )
    invalid(field);
  return item;
}
function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 128 ||
    /[\u0000- \u007f]/u.test(value)
  )
    invalid(field);
  return value;
}
function timestamp(value: unknown, field: string): number {
  const result = text(value, field);
  const ms = Date.parse(result);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString() !== result
  )
    invalid(field);
  return ms;
}

/**
 * Exact-address ban lookup over an explicitly supplied local list. Addresses are
 * compared verbatim: base58 is case-sensitive and no chain or format is inferred.
 */
export class ModerationStore {
  readonly dataSource: ModerationDataset["dataSource"];
  readonly observedAt: string;
  readonly #expiries = new Map<string, number | null>();
  readonly #now: () => number;

  constructor(input: unknown, now: () => number = Date.now) {
    const dataset = record(
      input,
      ["schemaVersion", "dataSource", "observedAt", "bans"],
      "dataset",
    );
    if (dataset.schemaVersion !== 1) invalid("schemaVersion");
    if (
      !["synthetic", "local-materialized"].includes(
        dataset.dataSource as string,
      )
    )
      invalid("dataSource");
    timestamp(dataset.observedAt, "observedAt");
    const bans = dataset.bans;
    if (!Array.isArray(bans) || bans.length > MAX_BANS) invalid("bans");
    for (let index = 0; index < bans.length; index++) {
      if (!Object.hasOwn(bans, index)) invalid(`bans[${index}]`);
      const ban = record(
        bans[index],
        ["address", "expiresAt"],
        `bans[${index}]`,
      );
      const address = text(ban.address, `bans[${index}].address`);
      // One fact per address; a later row must not silently override an earlier one.
      if (this.#expiries.has(address))
        invalid(`bans[${index}].address duplicate`);
      this.#expiries.set(
        address,
        ban.expiresAt === null
          ? null
          : timestamp(ban.expiresAt, `bans[${index}].expiresAt`),
      );
    }
    this.dataSource = dataset.dataSource as ModerationDataset["dataSource"];
    this.observedAt = dataset.observedAt as string;
    this.#now = now;
  }

  /** True for a permanent ban or an unexpired temporary ban in this local list only. */
  isBanned(address: string): boolean {
    if (!this.#expiries.has(address)) return false;
    const expiresAt = this.#expiries.get(address)!;
    return expiresAt === null || this.#now() < expiresAt;
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadModerationStore(
  path: string,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): ModerationStore {
  // O_NOFOLLOW is undefined on Windows, so the open flag alone cannot reject a
  // symlinked path there: inspect the path itself and bind the descriptor to it.
  const linked = lstatSync(path, { bigint: true });
  if (linked.isSymbolicLink() || !linked.isFile()) invalid("file type/size");
  const fd = openSync(
    path,
    constants.O_RDONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_FILE_BYTES))
      invalid("file type/size");
    if (stat.dev !== linked.dev || stat.ino !== linked.ino)
      invalid("file identity");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_FILE_BYTES) invalid("file size");
    return new ModerationStore(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, size),
        ),
      ),
    );
  } finally {
    closeSync(fd);
  }
}
