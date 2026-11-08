import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { win32 } from "node:path";
import {
  loadWindowsHostProfileNative,
  type WindowsHostProfilePaths,
} from "../../packages/host-runtime/src/windowsHostProfile";
import { createWindowsListenerTlsFiles } from "../../packages/host-runtime/src/windowsListenerTls";
import {
  createSelfMadeListenerCertificateStore,
  listenerTlsPin,
} from "../../apps/server/src/remote/selfMadeListenerCertificate";

const [binding, profile, mode] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  !binding ||
  !mode ||
  (profile !== "octant" && profile !== "nightly-test-data")
)
  throw Error("Supply the owned Windows TLS fixture.");
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
const files = createWindowsListenerTlsFiles(native, paths);
if (files === undefined) throw Error("Native TLS storage unavailable.");
const checks: string[] = [];
function check(ok: boolean, name: string) {
  if (!ok) throw Error(`Owned listener TLS check failed: ${name}`);
  checks.push(name);
}
const start = new Date("2026-11-08T07:00:00Z");
const now = mode === "renew" ? new Date(start.getTime() + 340 * 86400000) : start;
const options = { dataDirectory: paths.dataDirectory, tlsFiles: files, now: () => now };
try {
  if (mode === "missing") {
    check(files.read("key").status === "missing", "read-only access creates no key");
    check(
      files.read("certificate").status === "missing",
      "read-only access creates no certificate",
    );
    check(
      !existsSync(win32.join(paths.dataDirectory, "remote")),
      "read-only access creates no remote directory",
    );
  } else {
    const result = createSelfMadeListenerCertificateStore(options).ensure("100.64.0.7");
    if (mode === "concurrent" && result.status === "refused") {
      console.log(
        JSON.stringify({ profile, concurrentTlsAdmission: "refused", runtime: process.versions }),
      );
    } else if (mode === "refuse" || mode === "exposed") {
      check(result.status === "refused", "unsafe TLS storage refuses without fallback");
      if (mode === "exposed")
        check(
          result.status === "refused" && result.code === "tls-key-exposed",
          "an exposed native key retains its refusal reason",
        );
    } else {
      if (result.status !== "ready") throw Error("Native listener TLS creation refused.");
      check(
        listenerTlsPin(result.tls.cert) === result.tlsPin,
        "the public pin matches the actual certificate SPKI",
      );
      const repeated = createSelfMadeListenerCertificateStore(options).ensure("100.64.0.7");
      check(
        repeated.status === "ready" &&
          repeated.tlsPin === result.tlsPin &&
          repeated.tls.key === result.tls.key &&
          repeated.tls.cert === result.tls.cert,
        "repeated ensure preserves the native key and current certificate",
      );
      const winner = files.createKey(Buffer.alloc(32, 7));
      try {
        check(
          winner.status === "ready" && winner.bytes.toString() === result.tls.key,
          "exclusive key creation preserves the existing winner",
        );
      } finally {
        if (winner.status === "ready") winner.bytes.fill(0);
      }
      for (const target of [
        win32.join(paths.dataDirectory, "remote"),
        win32.join(paths.dataDirectory, "remote", "private-listener-tls-key.pem"),
      ]) {
        let refused = false;
        try {
          renameSync(target, target + ".moved");
        } catch {
          refused = true;
        }
        check(refused, "the admitted private key and remote directory remain held");
      }
      check(
        createSelfMadeListenerCertificateStore({ dataDirectory: paths.dataDirectory }).ensure(
          "100.64.0.7",
        ).status === "refused",
        "Windows has no ordinary-file fallback",
      );
      check(
        createSelfMadeListenerCertificateStore({
          ...options,
          dataDirectory: paths.dataDirectory + "-other",
        }).ensure("100.64.0.7").status === "refused",
        "a mismatched server directory refuses before access",
      );
      if (!("listenerTlsFile" in native) || typeof native.listenerTlsFile !== "function")
        throw Error("Native TLS ABI disappeared.");
      for (const [scope, directory, purpose, candidate] of [
        ["99999999-9999-4999-8999-999999999999", paths.dataDirectory, "key", null],
        [paths.profileId, paths.dataDirectory + "-other", "key", null],
        [paths.profileId, paths.dataDirectory, "host-key", null],
        [paths.profileId, paths.dataDirectory, "key", Buffer.alloc(4097)],
        [paths.profileId, paths.dataDirectory, "certificate", Buffer.alloc(16385)],
      ] as const) {
        const refusal: unknown = native.listenerTlsFile(
          profile,
          scope,
          directory,
          purpose,
          candidate,
        );
        check(
          typeof refusal === "object" &&
            refusal !== null &&
            "status" in refusal &&
            refusal.status === "refused",
          "native scope, fixed purpose, canonical directory and byte bounds refuse",
        );
      }
      console.log(
        JSON.stringify({
          profile,
          tlsPin: result.tlsPin,
          certificateHash: createHash("sha256").update(result.tls.cert).digest("hex"),
          runtime: process.versions,
          checks,
          startupAdmitted: false,
          workCodeEnabled: false,
        }),
      );
    }
  }
  if (mode === "missing" || mode === "refuse" || mode === "exposed")
    console.log(JSON.stringify({ profile, mode, checks, runtime: process.versions }));
} finally {
  native.close();
}
