// Production host identity for the packaged private
// listener gateway.
//
// The packaged server process composes the dual-listener gateway from its own
// persistence graph. The gateway needs a stable host id, a display name, and a
// host-signing port (used to sign the remote hello and protocol negotiation).
// The private key of the host identity never leaves this boundary: it is
// generated once and persisted under the local data directory (the same trust
// boundary as the SQLite event journal) with owner-only permissions, and only
// fingerprints and signatures are ever exposed.
//
// When a host identity has already been projected (e.g. by desktop onboarding)
// the projected id and display name are reused so the server and desktop agree
// on identity; the server-owned signing key remains authoritative for the
// listener the server process binds.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { decodeStableHostId, type StableHostId } from "@octant/contracts/remote-access";
import { readHostIdentity } from "../persistence/remoteAccessProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { HostSigningPort } from "./remoteProtocolService";

const HOST_IDENTITY_SUBDIR = "remote";
const HOST_ID_FILE = "private-listener-host-id";
const HOST_KEY_FILE = "private-listener-host-key.pem";
const DISPLAY_NAME_MAX = 128;
const OWNER_ONLY = 0o600;

export interface PrivateListenerHostIdentity {
  readonly hostId: StableHostId;
  readonly displayName: string;
  readonly signing: HostSigningPort;
}

export interface ResolvePrivateListenerHostIdentityOptions {
  readonly connection: SqliteConnection;
  readonly dataDirectory: string;
  readonly fallbackDisplayName?: string;
}

/**
 * Resolve (and lazily provision) the host identity for the server-owned
 * private listener gateway. Called on first enable, not at startup, so a
 * disabled-by-default server never touches key material.
 */
export function resolvePrivateListenerHostIdentity(
  options: ResolvePrivateListenerHostIdentityOptions,
): PrivateListenerHostIdentity {
  const directory = join(options.dataDirectory, HOST_IDENTITY_SUBDIR);
  mkdirSync(directory, { recursive: true });

  const projected = readHostIdentity(options.connection);
  const hostId =
    projected !== undefined ? decodeStableHostId(projected.host_id) : loadOrCreateHostId(directory);
  const displayName = boundedDisplayName(
    projected?.display_name ?? options.fallbackDisplayName ?? safeHostname(),
  );
  const signing = loadOrCreateSigning(directory);
  return { hostId, displayName, signing };
}

function loadOrCreateHostId(directory: string): StableHostId {
  const path = join(directory, HOST_ID_FILE);
  if (existsSync(path)) {
    return decodeStableHostId(readFileSync(path, "utf8").trim());
  }
  const hostId = randomUUID();
  writeFileSync(path, `${hostId}\n`, { mode: OWNER_ONLY });
  return decodeStableHostId(hostId);
}

function loadOrCreateSigning(directory: string): HostSigningPort {
  const path = join(directory, HOST_KEY_FILE);
  let privateKeyPem: string;
  if (existsSync(path)) {
    privateKeyPem = readFileSync(path, "utf8");
  } else {
    const generated = generateKeyPairSync("ec", { namedCurve: "P-256" });
    privateKeyPem = String(generated.privateKey.export({ format: "pem", type: "pkcs8" }));
    writeFileSync(path, privateKeyPem, { mode: OWNER_ONLY });
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const publicDer = createPublicKey(privateKeyPem).export({ format: "der", type: "spki" });
  const hostKeyFingerprint = createHash("sha256").update(publicDer).digest("hex");

  return {
    hostKeyFingerprint,
    signHostPayload: (payload: string) =>
      cryptoSign("sha256", Buffer.from(payload, "utf8"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
  };
}

function boundedDisplayName(value: string): string {
  const trimmed = value.trim().slice(0, DISPLAY_NAME_MAX);
  return trimmed.length === 0 ? "Octant" : trimmed;
}

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return "Octant";
  }
}
