import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { resolvePrivateListenerHostIdentity } from "./privateListenerHostIdentity";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function freshConnection(directory: string): SqliteConnection {
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => new Date().toISOString());
  return connection;
}

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-private-listener-identity-"));
  directories.push(directory);
  return directory;
}

describe("private listener host identity", () => {
  it("provisions a stable host id, display name, and signing port with owner-only key material", () => {
    const directory = makeDirectory();
    const connection = freshConnection(directory);

    const identity = resolvePrivateListenerHostIdentity({
      connection,
      dataDirectory: directory,
      fallbackDisplayName: "This Mac",
    });

    expect(identity.hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.displayName).toBe("This Mac");
    expect(identity.signing.hostKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const keyPath = join(directory, "remote", "private-listener-host-key.pem");
    expect(existsSync(keyPath)).toBe(true);
    // The private key is persisted with owner-only permissions and never leaves
    // this boundary; only fingerprints and signatures are exposed.
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const keyPem = readFileSync(keyPath, "utf8");
    expect(keyPem).toContain("PRIVATE KEY");
    expect(JSON.stringify(identity.signing)).not.toContain("PRIVATE KEY");
  });

  it("produces signatures verifiable against the persisted host public key", () => {
    const directory = makeDirectory();
    const connection = freshConnection(directory);
    const identity = resolvePrivateListenerHostIdentity({
      connection,
      dataDirectory: directory,
    });

    const payload = "octant-host-hello";
    const signature = identity.signing.signHostPayload(payload);
    const keyPem = readFileSync(join(directory, "remote", "private-listener-host-key.pem"), "utf8");
    const publicKey = createPublicKey(keyPem);

    expect(
      cryptoVerify(
        "sha256",
        Buffer.from(payload, "utf8"),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("reuses the persisted host id and key across resolutions", () => {
    const directory = makeDirectory();

    const first = resolvePrivateListenerHostIdentity({
      connection: freshConnection(directory),
      dataDirectory: directory,
    });
    const second = resolvePrivateListenerHostIdentity({
      connection: freshConnection(directory),
      dataDirectory: directory,
    });

    expect(second.hostId).toBe(first.hostId);
    expect(second.signing.hostKeyFingerprint).toBe(first.signing.hostKeyFingerprint);
  });

  it("prefers a projected host identity when one already exists", () => {
    const directory = makeDirectory();
    const connection = freshConnection(directory);
    const projectedHostId = "11111111-1111-4111-8111-111111111111";
    connection
      .prepare(
        "INSERT INTO host_identity_projection (identity_key, host_id, display_name, key_fingerprint, key_generation, created_at, rotated_at) VALUES ('host', ?, ?, ?, 1, ?, NULL)",
      )
      .run(projectedHostId, "Studio Mac", "b".repeat(64), new Date().toISOString());

    const identity = resolvePrivateListenerHostIdentity({
      connection,
      dataDirectory: directory,
      fallbackDisplayName: "ignored",
    });

    expect(identity.hostId).toBe(projectedHostId);
    expect(identity.displayName).toBe("Studio Mac");
  });
});
