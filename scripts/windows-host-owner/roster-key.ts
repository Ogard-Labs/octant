import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { win32 } from "node:path";
import {
  loadWindowsHostProfileNative,
  type WindowsHostProfilePaths,
} from "../../packages/host-runtime/src/windowsHostProfile";
import { createWindowsRosterSigningKeyFile } from "../../packages/host-runtime/src/windowsRosterSigningKey";
import { createRosterSigningKeyStore } from "../../apps/server/src/hub/rosterSigningKey";

const [binding, profile, mode] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  !binding ||
  !mode ||
  (profile !== "octant" && profile !== "nightly-test-data")
)
  throw Error("Supply the owned Windows roster fixture.");
const native = loadWindowsHostProfileNative(win32.resolve(binding));
if (native === undefined) throw Error("Native profile unavailable.");
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
  throw Error("Owned profile unavailable.");
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
const file = createWindowsRosterSigningKeyFile(native, paths);
if (file === undefined) throw Error("Native roster storage unavailable.");
const checks: string[] = [];
function check(ok: boolean, name: string) {
  if (!ok) throw Error(`Owned roster signing check failed: ${name}`);
  checks.push(name);
}
try {
  if (mode === "missing") {
    check(file.read().status === "missing", "read-only access creates no roster key");
    check(
      !existsSync(win32.join(paths.dataDirectory, "hub")),
      "read-only access creates no hub directory",
    );
  } else {
    let signer;
    try {
      signer = createRosterSigningKeyStore(paths.dataDirectory, file).signer();
    } catch {
      if (mode !== "concurrent" && mode !== "refuse") throw Error("Owned roster signing failed.");
    }
    if (mode === "refuse")
      check(signer === undefined, "unsafe roster key refuses without replacement or fallback");
    else if (signer === undefined)
      console.log(JSON.stringify({ profile, concurrentRosterAdmission: "refused" }));
    else {
      const publicKey = createPublicKey({
        key: Buffer.from(signer.publicKey, "base64url"),
        format: "der",
        type: "spki",
      });
      check(
        publicKey.asymmetricKeyType === "ec" &&
          publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1",
        "the actual roster signer retains P256 SPKI",
      );
      const signature = Buffer.from(signer.sign("owned roster fixture"), "base64url");
      check(
        signature.length === 64 &&
          verify(
            "sha256",
            Buffer.from("owned roster fixture"),
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            signature,
          ),
        "the actual roster signature verifies as SHA256 P1363",
      );
      const again = createRosterSigningKeyStore(paths.dataDirectory, file).signer();
      check(again.publicKey === signer.publicKey, "repeated resolution preserves the roster key");
      const existing = file.create(Buffer.alloc(32, 9));
      try {
        check(existing.status === "ready", "exclusive creation returns the existing winner");
      } finally {
        if (existing.status === "ready") existing.bytes.fill(0);
      }
      check(
        createRosterSigningKeyStore(paths.dataDirectory, file).signer().publicKey ===
          signer.publicKey,
        "a competing candidate never replaces the roster key",
      );
      for (const target of [
        win32.join(paths.dataDirectory, "hub"),
        win32.join(paths.dataDirectory, "hub", "roster-signing-key.pem"),
      ]) {
        let refused = false;
        try {
          renameSync(target, target + ".moved");
        } catch {
          refused = true;
        }
        check(refused, "the admitted roster key and hub directory remain held");
      }
      let noFallback = false;
      try {
        createRosterSigningKeyStore(paths.dataDirectory).signer();
      } catch {
        noFallback = true;
      }
      check(noFallback, "Windows never falls back to ordinary roster files");
      let wrongRoot = false;
      try {
        createRosterSigningKeyStore(paths.dataDirectory + "-other", file).signer();
      } catch {
        wrongRoot = true;
      }
      check(wrongRoot, "a mismatched server data directory refuses before access");
      check(
        !existsSync(win32.join(paths.dataDirectory, "remote")),
        "roster signing does not create listener identity or TLS files",
      );
      if (!("rosterSigningKeyFile" in native) || typeof native.rosterSigningKeyFile !== "function")
        throw Error("Native roster ABI disappeared.");
      for (const [scope, directory, candidate] of [
        ["99999999-9999-4999-8999-999999999999", paths.dataDirectory, null],
        [paths.profileId, paths.dataDirectory + "-other", null],
        [paths.profileId, paths.dataDirectory, Buffer.alloc(4097)],
      ] as const) {
        const result: unknown = native.rosterSigningKeyFile(profile, scope, directory, candidate);
        check(
          typeof result === "object" &&
            result !== null &&
            "status" in result &&
            result.status === "refused",
          "native scope, canonical root and byte bounds refuse before file access",
        );
      }
      console.log(
        JSON.stringify({
          profile,
          profileId: paths.profileId,
          rosterFingerprint: createHash("sha256")
            .update(Buffer.from(signer.publicKey, "base64url"))
            .digest("hex"),
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
