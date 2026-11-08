import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { win32 } from "node:path";
import {
  acquireWindowsHostProfileOwner,
  loadWindowsHostProfileNative,
  type WindowsHostProfilePaths,
} from "../../packages/host-runtime/src/windowsHostProfile";
import {
  createWindowsAuthorityStateFiles,
  type WindowsAuthorityStateNative,
} from "../../packages/host-runtime/src/windowsAuthorityState";
import { createHubStateStore } from "../../apps/server/src/hub/hubStateStore";
import { createDelegationStateStore } from "../../apps/server/src/hub/delegationStateStore";
import { createTailscaleCertificateSetting } from "../../apps/server/src/hub/tailscaleCertificate";

const [binding, profile, mode] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  !binding ||
  !mode ||
  (profile !== "octant" && profile !== "nightly-test-data")
)
  throw Error("Supply the owned authority-state fixture.");
const loaded = loadWindowsHostProfileNative(win32.resolve(binding));
if (loaded === undefined) throw Error("Native profile unavailable.");
function stateNative(value: typeof loaded): value is WindowsAuthorityStateNative {
  return (
    value !== undefined &&
    "beginAuthorityState" in value &&
    typeof value.beginAuthorityState === "function" &&
    "readAuthorityState" in value &&
    typeof value.readAuthorityState === "function" &&
    "writeAuthorityState" in value &&
    typeof value.writeAuthorityState === "function" &&
    "commitAuthorityState" in value &&
    typeof value.commitAuthorityState === "function" &&
    "closeAuthorityState" in value &&
    typeof value.closeAuthorityState === "function"
  );
}
if (!stateNative(loaded)) throw Error("Native authority-state ABI unavailable.");
const native = loaded;
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
function status(value: unknown, expected: string): boolean {
  return record(value) && value.status === expected;
}
const opened = native.openProfile(profile);
if (
  !record(opened) ||
  opened.status !== "ready" ||
  typeof opened.profileId !== "string" ||
  typeof opened.rootDirectory !== "string"
)
  throw Error("Owned profile unavailable.");
const paths: WindowsHostProfilePaths = {
  platform: "win32",
  profile,
  profileId: opened.profileId,
  rootDirectory: opened.rootDirectory,
  dataDirectory: win32.join(opened.rootDirectory, "data"),
  configDirectory: win32.join(opened.rootDirectory, "config"),
  stateDirectory: win32.join(opened.rootDirectory, "state"),
  logsDirectory: win32.join(opened.rootDirectory, "logs"),
};
console.log(JSON.stringify({ fixtureScope: paths.profileId }));
const files = createWindowsAuthorityStateFiles(native, paths);
if (files === undefined) throw Error("Authority-state ports unavailable.");
const checks: string[] = [];
function check(value: boolean, name: string) {
  if (!value) throw Error(`Owned authority-state check failed: ${name}`);
  checks.push(name);
}
const begin = (purpose: string, mode: "read" | "replace", length: number | null) =>
  native.beginAuthorityState(profile, paths.profileId, paths.dataDirectory, purpose, mode, length);
function session(value: unknown): number {
  if (!record(value) || value.status !== "opened" || typeof value.session !== "number")
    throw Error("Owned session refused.");
  return value.session;
}
const lifetime = setTimeout(() => process.exit(2), 25_000);
let held: Awaited<ReturnType<typeof acquireWindowsHostProfileOwner>> | undefined;
try {
  if (mode === "missing") {
    for (const file of Object.values(files))
      check(file.read().status === "missing", "read-only missing record is positive absence");
    check(
      !existsSync(win32.join(paths.dataDirectory, "hub")),
      "read-only absence creates no hub directory",
    );
    check(
      status(begin("hub-state", "replace", 2), "refused"),
      "a process without a claimed owner cannot write",
    );
    check(
      status(native.prepare(paths.profileId), "prepared"),
      "the fixture can prepare its native owner",
    );
    check(
      status(begin("hub-state", "replace", 2), "refused"),
      "preparing without claiming does not grant writes",
    );
  } else {
    held = await acquireWindowsHostProfileOwner({
      native,
      profile,
      env: {},
      instanceId: randomUUID(),
      serverVersion: "fixture",
      wireVersion: "1",
      serviceMode: "foreground",
    });
    if (held.status !== "ready" || held.ownership.kind !== "owner")
      throw Error("Owned writer unavailable.");
    const hub = createHubStateStore(paths.dataDirectory, files.hub);
    const delegations = createDelegationStateStore(paths.dataDirectory, files.delegations);
    const certificate = createTailscaleCertificateSetting(paths.dataDirectory, files.certificate);
    if (mode === "refuse") {
      let refused = false;
      try {
        hub.load();
      } catch {
        refused = true;
      }
      check(refused, "corrupt or unsafe native authority is refused without reset");
    } else {
      hub.save({
        ownerUnlockBeforePairedMerge: true,
        pendingDeviceRevocations: ["11111111-1111-4111-8111-111111111111"],
      });
      check(
        hub.load().ownerUnlockBeforePairedMerge === true,
        "hub revocation authority round-trips through native files",
      );
      delegations.save({ received: [], sent: [] });
      check(
        delegations.load().received.length === 0,
        "delegation schema round-trips through native files",
      );
      certificate.save({ enabled: false });
      check(
        certificate.load().enabled === false,
        "certificate schema round-trips through native files",
      );
      check(
        status(begin("other-file", "replace", 2), "refused"),
        "an unknown state purpose is refused",
      );
      check(
        status(
          native.beginAuthorityState(
            profile,
            randomUUID(),
            paths.dataDirectory,
            "hub-state",
            "replace",
            2,
          ),
          "refused",
        ),
        "another owner scope is refused",
      );
      check(
        status(
          native.beginAuthorityState(
            profile,
            paths.profileId,
            paths.dataDirectory + "\\other",
            "hub-state",
            "replace",
            2,
          ),
          "refused",
        ),
        "a caller-selected path is refused",
      );
      const prior = session(begin("tailscale-certificate", "read", null));
      certificate.save({ enabled: true, acknowledgedAt: 10 });
      const old = native.readAuthorityState(prior, 0);
      check(
        record(old) &&
          old.bytes instanceof Uint8Array &&
          Buffer.from(old.bytes).toString("utf8") === '{"enabled":false}',
        "a retained read snapshot does not block a newer authority commit",
      );
      if (record(old) && old.bytes instanceof Uint8Array) old.bytes.fill(0);
      native.closeAuthorityState(prior);
      check(certificate.load().enabled === true, "new readers observe the committed authority");
      const large = Buffer.from(" ".repeat(16383) + '{"enabled":false}');
      check(
        files.certificate.replace(large).status === "committed" &&
          certificate.load().enabled === false,
        "native transfers preserve a record larger than one chunk",
      );
      const incomplete = session(begin("hub-state", "replace", 4));
      check(
        status(native.writeAuthorityState(incomplete, 0, Buffer.from("{}")), "written"),
        "sequential chunks accept their declared offset",
      );
      check(
        status(native.commitAuthorityState(incomplete), "refused") &&
          hub.load().ownerUnlockBeforePairedMerge === true,
        "incomplete commit preserves the prior authority",
      );
      for (const [offset, bytes] of [
        [1, Buffer.from("{}")],
        [0, Buffer.alloc(16385)],
      ] as const) {
        const id = session(begin("hub-state", "replace", 16385));
        check(
          status(native.writeAuthorityState(id, offset, bytes), "refused"),
          "misaligned or oversized chunks abort their stage",
        );
      }
      const stale = session(begin("hub-state", "replace", 2));
      native.close();
      check(
        status(native.writeAuthorityState(stale, 0, Buffer.from("{}")), "refused"),
        "owner loss aborts pending writes",
      );
      check(
        readdirSync(win32.join(paths.dataDirectory, "hub")).every((name) => !name.endsWith(".tmp")),
        "all abandoned stages are removed",
      );
      check(
        files.hub.read().status === "ready",
        "read-only consumers remain separate from write ownership",
      );
    }
  }
  console.log(
    JSON.stringify({
      profile,
      profileId: paths.profileId,
      runtime: process.versions,
      authorityStateChecks: checks,
      startupAdmitted: false,
      workCodeEnabled: false,
    }),
  );
} finally {
  if (held?.status === "ready" && held.ownership.kind === "owner") await held.ownership.release();
  native.close();
  clearTimeout(lifetime);
}
