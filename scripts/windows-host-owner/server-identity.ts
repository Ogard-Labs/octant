import { renameSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { win32 } from "node:path";
import {
  loadWindowsHostProfileNative,
  type WindowsHostProfilePaths,
} from "../../packages/host-runtime/src/windowsHostProfile";
import { createWindowsServerIdentityFiles } from "../../packages/host-runtime/src/windowsServerIdentity";
import {
  resolvePrivateListenerHostIdentity,
  existingPrivateListenerSigning,
} from "../../apps/server/src/remote/privateListenerHostIdentity";
import type { SqliteConnection } from "../../apps/server/src/persistence/sqlitePort";

const [binding, profile, mode] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  !binding ||
  (profile !== "octant" && profile !== "nightly-test-data") ||
  !mode
)
  throw new Error("Supply the owned Windows identity fixture.");
const native = loadWindowsHostProfileNative(win32.resolve(binding));
if (native === undefined) throw new Error("Native profile unavailable.");
const value: unknown = native.openProfile(profile);
if (
  typeof value !== "object" ||
  value === null ||
  !("status" in value) ||
  value.status !== "ready" ||
  !("profileId" in value) ||
  typeof value.profileId !== "string" ||
  !("rootDirectory" in value) ||
  typeof value.rootDirectory !== "string"
)
  throw new Error("Owned profile unavailable.");
const paths: WindowsHostProfilePaths = {
  platform: "win32",
  profile,
  profileId: value.profileId,
  rootDirectory: value.rootDirectory,
  dataDirectory: win32.join(value.rootDirectory, "data"),
  configDirectory: win32.join(value.rootDirectory, "config"),
  stateDirectory: win32.join(value.rootDirectory, "state"),
  logsDirectory: win32.join(value.rootDirectory, "logs"),
};
const files = createWindowsServerIdentityFiles(native, paths);
if (files === undefined) throw new Error("Native identity storage unavailable.");
// The real storage/signing consumer needs only this read-only projection query.
// Real SQLite/journal precedence is separately covered in the server suite.
let projected: { readonly host_id: string; readonly display_name: string } | undefined;
const unavailable = (): never => {
  throw new Error("Unexpected fixture database mutation.");
};
const connection: SqliteConnection = {
  exec: unavailable,
  pragma: unavailable,
  close: () => {},
  transaction: unavailable,
  prepare: (sql) => {
    if (sql !== "SELECT * FROM host_identity_projection WHERE identity_key = 'host'")
      return unavailable();
    return { get: () => projected, all: unavailable, run: unavailable };
  },
};
const checks: string[] = [];
function check(ok: boolean, name: string) {
  if (!ok) throw new Error(`Owned server identity check failed: ${name}`);
  checks.push(name);
}
const options = { connection, dataDirectory: paths.dataDirectory, identityFiles: files };
try {
  if (mode === "missing") {
    check(
      existingPrivateListenerSigning(paths.dataDirectory, files) === undefined,
      "existing signing does not create a key",
    );
    check(
      files.read("host-id").status === "missing",
      "existing signing does not create a fallback host id",
    );
  } else if (mode === "refuse") {
    let refused = false;
    try {
      resolvePrivateListenerHostIdentity(options);
    } catch {
      refused = true;
    }
    check(refused, "unsafe identity refuses without fallback");
  } else {
    let identity;
    try {
      identity = resolvePrivateListenerHostIdentity(options);
    } catch {
      if (mode !== "concurrent") throw new Error("Owned identity resolution failed.");
      console.log(
        JSON.stringify({ profile, concurrentAdmission: "refused", runtime: process.versions }),
      );
      process.exitCode = 0;
    }
    if (identity !== undefined) {
      check(
        String(identity.hostId) !== paths.profileId,
        "the signing host id is distinct from the control profile UUID",
      );
      const publicDer = Buffer.from(identity.signing.hostPublicKey, "base64url");
      const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
      check(
        identity.signing.hostKeyFingerprint ===
          createHash("sha256").update(publicDer).digest("hex"),
        "the fingerprint hashes the P256 public SPKI",
      );
      check(
        verify(
          "sha256",
          Buffer.from("owned identity fixture"),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(identity.signing.signHostPayload("owned identity fixture"), "base64url"),
        ),
        "the actual server signer produces verifiable P1363 signatures",
      );
      for (const target of [
        win32.join(paths.dataDirectory, "remote"),
        win32.join(paths.dataDirectory, "remote", "private-listener-host-key.pem"),
      ]) {
        let refused = false;
        try {
          renameSync(target, target + ".moved");
        } catch {
          refused = true;
        }
        check(refused, "a held identity directory or key cannot be renamed");
      }
      let absentAdapterRefused = false;
      try {
        resolvePrivateListenerHostIdentity({ connection, dataDirectory: paths.dataDirectory });
      } catch {
        absentAdapterRefused = true;
      }
      check(
        absentAdapterRefused,
        "missing Windows storage refuses without an ordinary-file fallback",
      );
      if (!("identityFile" in native) || typeof native.identityFile !== "function")
        throw new Error("Native identity ABI disappeared.");
      for (const [scope, directory, purpose, candidate] of [
        ["99999999-9999-4999-8999-999999999999", paths.dataDirectory, "host-key", null],
        [paths.profileId, win32.join(paths.dataDirectory, "other"), "host-key", null],
        [paths.profileId, paths.dataDirectory, "roster-key", null],
        [paths.profileId, paths.dataDirectory, "host-key", Buffer.alloc(4097)],
      ] as const) {
        const refusal: unknown = native.identityFile(profile, scope, directory, purpose, candidate);
        check(
          typeof refusal === "object" &&
            refusal !== null &&
            "status" in refusal &&
            refusal.status === "refused",
          "native scope, canonical root, purpose and size checks refuse before file authority",
        );
      }
      const repeated = resolvePrivateListenerHostIdentity(options);
      check(
        repeated.hostId === identity.hostId &&
          repeated.signing.hostKeyFingerprint === identity.signing.hostKeyFingerprint,
        "repeated resolution keeps the host id and key",
      );
      const existing = existingPrivateListenerSigning(paths.dataDirectory, files);
      check(
        existing?.hostKeyFingerprint === identity.signing.hostKeyFingerprint,
        "push read uses the same key without provisioning",
      );
      projected = {
        host_id: "55555555-5555-4555-8555-555555555555",
        display_name: "Projected fixture",
      };
      const withProjection = resolvePrivateListenerHostIdentity(options);
      check(
        String(withProjection.hostId) === projected.host_id &&
          withProjection.displayName === projected.display_name,
        "the projected host id and display name keep authority",
      );
      check(
        withProjection.signing.hostKeyFingerprint === identity.signing.hostKeyFingerprint,
        "a projected host id never changes the signing key",
      );
      let mismatched = false;
      try {
        resolvePrivateListenerHostIdentity({
          ...options,
          dataDirectory: win32.join(paths.dataDirectory, "other"),
        });
      } catch {
        mismatched = true;
      }
      check(mismatched, "a different server data directory refuses before key access");
      check(
        files.create("host-key", Buffer.alloc(4097)).status === "refused",
        "an oversized candidate refuses without mutation",
      );
      check(
        files.create("host-id", Buffer.from("77777777-7777-4777-8777-777777777777\n")).status ===
          "ready",
        "exclusive create returns the existing winner rather than replacing it",
      );
      console.log(
        JSON.stringify({
          profile,
          hostId: identity.hostId,
          hostKeyFingerprint: identity.signing.hostKeyFingerprint,
          concurrentAdmission: "ready",
          runtime: process.versions,
          checks,
          startupAdmitted: false,
          workCodeEnabled: false,
        }),
      );
    }
  }
  if (mode === "missing" || mode === "refuse")
    console.log(JSON.stringify({ profile, mode, checks, runtime: process.versions }));
} finally {
  native.close();
}
