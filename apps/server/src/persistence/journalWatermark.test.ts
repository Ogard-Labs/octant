import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { bundledBuildIdentity } from "./buildIdentity";
import { EventRegistry } from "./eventRegistry";
import { journalVerificationFingerprint } from "./journalWatermark";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

function withConnection<T>(use: (connection: SqliteConnection) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "octant-fingerprint-"));
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  try {
    return use(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function fingerprintOf(build: string, registry: EventRegistry, head = 1): string | undefined {
  return withConnection((connection) => {
    connection.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (${head});`,
    );
    return journalVerificationFingerprint(build, registry, connection);
  });
}

const Persisted = Schema.Struct({ value: Schema.String });
const registryOf = (version = 1) =>
  new EventRegistry().register("fixture.recorded", version, Persisted);

describe("journal verification fingerprint", () => {
  it("is the same for the same build, registrations and migration head", () => {
    expect(fingerprintOf("build-a", registryOf())).toBeDefined();
    expect(fingerprintOf("build-a", registryOf())).toBe(fingerprintOf("build-a", registryOf()));
  });

  it.each([
    ["a different build", () => fingerprintOf("build-b", registryOf())],
    ["a different registered version", () => fingerprintOf("build-a", registryOf(2))],
    ["a different migration head", () => fingerprintOf("build-a", registryOf(), 2)],
  ] as const)("changes with %s", (_name, other) => {
    expect(other()).not.toBe(fingerprintOf("build-a", registryOf()));
  });

  it("gives no fingerprint when the migration head cannot be read", () => {
    expect(
      withConnection((connection) =>
        journalVerificationFingerprint("build-a", registryOf(), connection),
      ),
    ).toBeUndefined();
  });
});

describe("bundled build identity", () => {
  it("is absent when running from a TypeScript source file", () => {
    expect(
      bundledBuildIdentity(pathToFileURL("/repo/apps/server/src/x.ts").href)(),
    ).toBeUndefined();
  });

  it("is absent when the bundle's effect cannot be resolved", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-bundle-"));
    try {
      writeFileSync(join(directory, "main.mjs"), "export {};");
      expect(
        bundledBuildIdentity(pathToFileURL(join(directory, "main.mjs")).href)(),
      ).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("changes when any chunk beside the running module changes", () => {
    const directory = mkdtempSync(join(import.meta.dirname, "bundle-fixture-"));
    try {
      const file = join(directory, "main.mjs");
      writeFileSync(file, "export {};");
      writeFileSync(join(directory, "schemas-abc.mjs"), "export const a = 1;");
      const first = bundledBuildIdentity(pathToFileURL(file).href)();
      writeFileSync(join(directory, "schemas-abc.mjs"), "export const a = 2;");
      expect(bundledBuildIdentity(pathToFileURL(file).href)()).not.toBe(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("changes with the bundle's bytes", () => {
    const directory = mkdtempSync(join(import.meta.dirname, "bundle-fixture-"));
    try {
      const file = join(directory, "main.mjs");
      writeFileSync(file, "export const a = 1;");
      const first = bundledBuildIdentity(pathToFileURL(file).href)();
      writeFileSync(file, "export const a = 2;");
      const second = bundledBuildIdentity(pathToFileURL(file).href)();
      expect(first).toMatch(/^[0-9a-f]{64}\+effect@/);
      expect(second).not.toBe(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
