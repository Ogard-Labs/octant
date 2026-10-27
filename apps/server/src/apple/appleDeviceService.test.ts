import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAppleDeviceRequest,
  type AppleDeviceEvidence,
  type AppleDeviceRecord,
  type AppleDeviceRequest,
  type AppleDeviceResponse,
} from "@octant/contracts";
import type { AppleDeviceExecutionScope } from "@octant/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppleDeviceLeases, APPLE_DEVICE_DISCONNECT_GRACE_MS } from "./appleDeviceLeases";
import { AppleDeviceService, type AppleDeviceExecutionContext } from "./appleDeviceService";
import { AppleRuntimeStore } from "./appleRuntimeStore";
import { parseDevicectlDeviceList, parseDevicectlLockState } from "./devicectl";
import type { AppleProcessResult } from "./appleToolchainService";

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/devicectl/${name}`, import.meta.url), "utf8");

// Every hardware identifier the fixture listing carries. None may leave the host.
const HARDWARE_IDENTIFIERS = [
  "00008140-000A1B2C3D4E801C",
  "00008103-001C2D3E4F5A001E",
  "00008120-000E5F6A7B8C901E",
  "F2LXQ7WIRED1",
  "H7NETWORK2PD",
  "K9LOCKED3PHN",
  "M3DEVMODE4FF",
  "2817461923840022",
  "1937402847562001",
  "3001002003004005",
];
const CORE_DEVICE_IDENTIFIERS = [
  "6E2B1C4A-0D5F-4E8B-9A71-3C2D1E0F9A01",
  "6E2B1C4A-0D5F-4E8B-9A71-3C2D1E0F9A03",
];

const authority = {
  hostId: "40000000-0000-4000-8000-000000000001",
  mode: "code",
  projectId: "40000000-0000-4000-8000-000000000002",
  providerInstanceId: "40000000-0000-4000-8000-000000000003",
  extension: { kind: "core" },
} as const;
const person = { kind: "local-user", actorId: "40000000-0000-4000-8000-000000000010" } as const;
const firstThread = {
  threadId: "40000000-0000-4000-8000-000000000020",
  checkoutId: "40000000-0000-4000-8000-000000000021",
};
const secondThread = {
  threadId: "40000000-0000-4000-8000-000000000030",
  checkoutId: "40000000-0000-4000-8000-000000000031",
};

let requestNumber = 0;
function deviceRequest(
  kind: AppleDeviceRequest["kind"],
  thread: typeof firstThread,
  extra: Record<string, unknown> = {},
): AppleDeviceRequest {
  requestNumber += 1;
  const suffix = String(requestNumber).padStart(12, "0");
  return decodeAppleDeviceRequest({
    actionId: `41000000-0000-4000-8000-${suffix}`,
    correlationId: `42000000-0000-4000-8000-${suffix}`,
    authority,
    ...thread,
    kind,
    requestedBy: person,
    timeoutMs: 30_000,
    approval: { kind: "not-required" },
    ...extra,
  });
}

/** The checkout each thread builds from; every test gets its own. */
let checkoutRoot = "";

function scopeFor(
  thread: typeof firstThread,
  extra: Partial<AppleDeviceExecutionScope> = {},
): AppleDeviceExecutionContext {
  return {
    authority: authority as never,
    threadId: thread.threadId as never,
    checkoutId: thread.checkoutId as never,
    checkoutRoot,
    executionPolicy: "approval-gated",
    approvalValid: false,
    ...extra,
  };
}

const confirmed = (thread: typeof firstThread) =>
  scopeFor(thread, { approvalValid: true, approvedBy: person as never });
const approval = {
  approval: { kind: "approved", approvalId: "43000000-0000-4000-8000-000000000001" },
};

const usage = (subcommand: string, extra = "") =>
  `OVERVIEW: devicectl ${subcommand}\n\nUSAGE: devicectl ${subcommand} [<options>]\n${extra}`;

interface Host {
  readonly calls: Array<ReadonlyArray<string>>;
  readonly offers: Set<string>;
  /** Subcommands whose next `--help` times out instead of answering. */
  readonly slowHelp: Set<string>;
  xcode: "selected" | "missing";
  listing: string;
  /** What the fake project builds, and whether a build script swaps the app for a link. */
  build: { bundleIdentifier: string; plantLinkTo?: string; whileBuilding?: () => void };
  installAnswer: string;
  /** Launches that ran under the signing port, which has no network. */
  readonly signingCalls: Array<ReadonlyArray<string>>;
  identities: string;
  /** The entitlements each `codesign` of the app read, at the time it ran. */
  readonly entitlements: string[];
  readonly artifacts: Map<string, string>;
  readonly journal: AppleDeviceEvidence[];
}

const ok = (stdout = ""): AppleProcessResult => ({
  termination: "exited",
  exitCode: 0,
  stdout: new TextEncoder().encode(stdout),
  stderr: new Uint8Array(),
  parserFailed: false,
  cleanupUncertain: false,
});
const failed: AppleProcessResult = { ...ok(), exitCode: 1 };

// A build log line and console output that name the device's UDID, as an
// ambiguous destination list or an app's own print can.
const UDID = "00008140-000A1B2C3D4E801C";
const PRODUCT_DIRECTORY = join("Build", "Products", "Debug-iphoneos");

function fakeExecute(host: Host) {
  return async (
    input: {
      readonly argv: ReadonlyArray<string>;
      readonly onOutput?: (chunk: Uint8Array) => void;
    },
    signal?: AbortSignal,
  ): Promise<AppleProcessResult> => {
    host.calls.push(input.argv);
    const [tool, ...rest] = input.argv;
    if (tool === "xcode-select") {
      return host.xcode === "selected"
        ? ok("/Applications/Xcode.app/Contents/Developer\n")
        : failed;
    }
    if (tool === "xcodebuild") {
      const derived = input.argv[input.argv.indexOf("-derivedDataPath") + 1] ?? "";
      if (input.argv.includes("-showBuildSettings")) {
        return ok(
          JSON.stringify([
            {
              target: "SimulatorFixture",
              buildSettings: {
                TARGET_BUILD_DIR: join(derived, PRODUCT_DIRECTORY),
                WRAPPER_NAME: "SimulatorFixture.app",
                PRODUCT_BUNDLE_IDENTIFIER: host.build.bundleIdentifier,
              },
            },
          ]),
        );
      }
      if (input.argv.at(-1) === "build") {
        host.build.whileBuilding?.();
        const product = join(derived, PRODUCT_DIRECTORY, "SimulatorFixture.app");
        if (host.build.plantLinkTo === undefined) {
          await mkdir(join(product, "Frameworks", "Fixture.framework"), { recursive: true });
        } else {
          await mkdir(join(derived, PRODUCT_DIRECTORY), { recursive: true });
          await symlink(host.build.plantLinkTo, product);
        }
        return ok(`note: Using the first of multiple matching destinations: { id:${UDID} }\n`);
      }
      return ok();
    }
    if (tool !== "xcrun" || rest[0] !== "devicectl") return failed;
    const args = rest.slice(1);
    if (args.slice(0, 3).join(" ") === "device process launch" && args.includes("--console")) {
      input.onOutput?.(new TextEncoder().encode(`Fixture ready on ${UDID}\n`));
      // The console session stays attached until it is interrupted.
      return await new Promise((resolveSession) => {
        signal?.addEventListener("abort", () =>
          resolveSession({ ...ok(), termination: "cancelled", exitCode: null }),
        );
      });
    }
    if (args.at(-1) === "--help") {
      const subcommand = args.slice(0, -1).join(" ");
      if (host.slowHelp.delete(subcommand)) {
        return { ...ok(), termination: "timed-out", exitCode: null };
      }
      if (!host.offers.has(subcommand)) {
        // An unknown subcommand falls back to its parent's help.
        return ok(usage(args.slice(0, -2).join(" ")));
      }
      return ok(usage(subcommand, subcommand === "device process launch" ? "  --console" : ""));
    }
    const output = args[args.indexOf("--json-output") + 1];
    if (output === undefined) return failed;
    if (args[0] === "list" && args[1] === "devices") {
      await writeFile(output, host.listing);
      return ok();
    }
    if (args.slice(0, 3).join(" ") === "device info lockState") {
      const target = args[args.indexOf("--device") + 1];
      await writeFile(
        output,
        await fixture(
          target === "6E2B1C4A-0D5F-4E8B-9A71-3C2D1E0F9A03"
            ? "lock-state-locked.json"
            : "lock-state-unlocked.json",
        ),
      );
      return ok();
    }
    if (args.slice(0, 3).join(" ") === "device install app") {
      await writeFile(output, await fixture(host.installAnswer));
      return host.installAnswer === "install-app.json" ? ok() : failed;
    }
    return failed;
  };
}

function fakeSigning(host: Host) {
  return async (input: { readonly argv: ReadonlyArray<string> }): Promise<AppleProcessResult> => {
    host.signingCalls.push(input.argv);
    if (input.argv[0] === "security") return ok(host.identities);
    if (input.argv[0] !== "codesign") return failed;
    const entitlements = input.argv.indexOf("--entitlements");
    if (entitlements >= 0) {
      host.entitlements.push(await readFile(input.argv[entitlements + 1] ?? "", "utf8"));
    }
    return ok();
  };
}

const TEAM = "A1B2C3D4E5";
const CERTIFICATE = new TextEncoder().encode("fixture development certificate");
const FINGERPRINT = createHash("sha1").update(CERTIFICATE).digest("hex").toUpperCase();

/** A provisioning profile as Xcode installs it: a CMS envelope around an XML property list. */
function provisioningProfile(applicationIdentifier: string): Uint8Array {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key><string>Octant &amp; Fixture</string>
  <key>DeveloperCertificates</key>
  <array><data>${Buffer.from(CERTIFICATE).toString("base64")}</data></array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>${applicationIdentifier}</string>
    <key>com.apple.developer.team-identifier</key><string>${TEAM}</string>
    <key>get-task-allow</key><true/>
    <key>keychain-access-groups</key><array><string>${TEAM}.*</string></array>
  </dict>
  <key>ExpirationDate</key><date>2027-10-26T12:00:00Z</date>
  <key>Name</key><string>iOS Team Provisioning Profile: *</string>
  <key>Platform</key><array><string>iOS</string></array>
  <key>ProvisionedDevices</key><array><string>${UDID}</string></array>
  <key>TeamIdentifier</key><array><string>${TEAM}</string></array>
  <key>UUID</key><string>7B1E0F9A-3C2D-4E5F-8A9B-0C1D2E3F4A5B</string>
  <key>Version</key><integer>1</integer>
</dict>
</plist>`;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x30, 0x82, 0x2f, 0x1e, 0x06, 0x09, 0x2a, 0x86]),
      Buffer.from(plist, "utf8"),
      Buffer.from([0xa0, 0x82, 0x0b, 0x9f, 0x30, 0x82]),
    ]),
  );
}

describe("AppleDeviceService", () => {
  let root: string;
  let host: Host;
  let clock: number;
  let leases: AppleDeviceLeases;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "octant-apple-devices-"));
    host = {
      calls: [],
      offers: new Set([
        "list devices",
        "device install app",
        "device process launch",
        "device process terminate",
        "device uninstall app",
        "device info lockState",
      ]),
      slowHelp: new Set(),
      xcode: "selected",
      listing: await fixture("list-devices.json"),
      build: { bundleIdentifier: "sh.octant.SimulatorFixture" },
      installAnswer: "install-app.json",
      signingCalls: [],
      identities: `  1) ${FINGERPRINT} "Apple Development: Jane Doe (Z9Y8X7W6V5)"\n     1 valid identities found\n`,
      entitlements: [],
      artifacts: new Map(),
      journal: [],
    };
    clock = 1_000_000;
    leases = new AppleDeviceLeases(() => clock);
    checkoutRoot = join(root, "checkout");
    await mkdir(join(checkoutRoot, "SimulatorFixture.xcodeproj"), { recursive: true });
    await mkdir(join(root, "profiles"), { recursive: true });
    await writeFile(
      join(root, "profiles", "fixture.mobileprovision"),
      provisioningProfile(`${TEAM}.*`),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let idNumber = 0;
  function service(platform: NodeJS.Platform = "darwin", store = new AppleRuntimeStore(root)) {
    return new AppleDeviceService({
      execute: fakeExecute(host),
      executeSigning: fakeSigning(host),
      outputDirectory: join(root, "devicectl"),
      artifactRoot: join(root, "artifacts"),
      signingDirectory: join(root, "signing"),
      provisioningProfileDirectories: [join(root, "profiles"), join(root, "missing")],
      identities: store,
      leases,
      realpath,
      writeArtifact: async (reference, bytes) => {
        host.artifacts.set(reference, new TextDecoder().decode(bytes));
      },
      recordEvidence: (evidence) => host.journal.push(evidence),
      launchSettleMs: 5,
      now: () => new Date(clock).toISOString(),
      newId: () => {
        idNumber += 1;
        return `44000000-0000-4000-8000-${String(idNumber).padStart(12, "0")}`;
      },
      platform,
    });
  }

  async function discover(devices: AppleDeviceService, thread = firstThread) {
    const answer = await devices.request(deviceRequest("discover", thread), scopeFor(thread));
    if (answer.kind !== "apple-device-discovery") throw new Error(JSON.stringify(answer));
    return answer.discovery;
  }

  const byName = (devices: ReadonlyArray<AppleDeviceRecord>, name: string) => {
    const device = devices.find((candidate) => candidate.name === name);
    if (device === undefined) throw new Error(`${name} was not listed`);
    return device;
  };

  it("lists paired iPhones and iPads, wired and on the network, with each state devicectl reports", async () => {
    const discovery = await discover(service());
    expect(
      discovery.devices.map(({ name, model, connection, state }) => ({
        name,
        model,
        connection,
        state,
      })),
    ).toEqual([
      { name: "Henrik's iPhone", model: "iPhone 16 Pro", connection: "wired", state: "connected" },
      {
        name: "Studio iPad",
        model: "iPad Pro (11-inch) (M4)",
        connection: "network",
        state: "connected",
      },
      { name: "Test iPhone (locked)", model: "iPhone 15", connection: "wired", state: "locked" },
      {
        name: "Family iPhone",
        model: "iPhone 14",
        connection: "wired",
        state: "developer-mode-off",
      },
      { name: "Borrowed iPhone", model: "iPhone 16", connection: "wired", state: "untrusted" },
      {
        name: "Old iPad",
        model: "iPad Air (5th generation)",
        connection: "network",
        state: "unavailable",
      },
    ]);
    expect(discovery.devices.every((device) => device.platform === "ios")).toBe(true);
    expect(discovery.tooling).toEqual([
      "list-devices",
      "install-app",
      "launch-app",
      "terminate-process",
      "uninstall-app",
      "console-logs",
    ]);
  });

  it("never answers with or stores a device's UDID, serial number, ECID, or CoreDevice identifier", async () => {
    const devices = service();
    const discovery = await discover(devices);
    const wired = byName(discovery.devices, "Henrik's iPhone");
    const answers: AppleDeviceResponse[] = [
      { kind: "apple-device-discovery", discovery },
      await devices.request(
        deviceRequest("status", firstThread, { deviceId: wired.deviceId }),
        scopeFor(firstThread),
      ),
      await devices.request(
        deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...approval }),
        confirmed(firstThread),
      ),
    ];
    const stored = await readFile(join(root, "device-identities.json"), "utf8");
    for (const identifier of [...HARDWARE_IDENTIFIERS, ...CORE_DEVICE_IDENTIFIERS]) {
      expect(JSON.stringify(answers)).not.toContain(identifier);
    }
    for (const identifier of HARDWARE_IDENTIFIERS) expect(stored).not.toContain(identifier);
    // The listing devicectl wrote is gone once it has been read.
    expect(await readdir(join(root, "devicectl"))).toEqual([]);
  });

  it("keeps the id it gave a device across discoveries and a host restart", async () => {
    const first = byName((await discover(service())).devices, "Studio iPad").deviceId;
    const again = byName((await discover(service())).devices, "Studio iPad").deviceId;
    expect(again).toBe(first);
  });

  it("refuses every device request on a host that is not a Mac before any process starts", async () => {
    const devices = service("linux");
    for (const kind of ["discover", "use-device"] as const) {
      const answer = await devices.request(
        deviceRequest(
          kind,
          firstThread,
          kind === "discover" ? {} : { deviceId: "44000000-0000-4000-8000-000000000001" },
        ),
        confirmed(firstThread),
      );
      expect(answer).toEqual({ kind: "apple-device-refused", reason: "toolchain-unavailable" });
    }
    expect(host.calls).toEqual([]);
  });

  it("reports no device layer when Xcode is not selected", async () => {
    host.xcode = "missing";
    const answer = await service().request(
      deviceRequest("discover", firstThread),
      scopeFor(firstThread),
    );
    expect(answer).toEqual({ kind: "apple-device-refused", reason: "toolchain-unavailable" });
    expect(host.calls.some((argv) => argv[1] === "devicectl")).toBe(false);
  });

  it("reports a device operation the selected Xcode does not offer as unavailable", async () => {
    host.offers.delete("device uninstall app");
    const discovery = await discover(service());
    // The screenshot probe fell back to its parent's help, which is not an offer.
    expect(discovery.tooling).not.toContain("screenshot");
    expect(discovery.tooling).not.toContain("uninstall-app");
  });

  it("asks the selected Xcode again after a probe that did not finish instead of reporting no devices", async () => {
    const devices = service();
    host.slowHelp.add("list devices");
    host.slowHelp.add("device info lockState");
    await expect(
      devices.request(deviceRequest("discover", firstThread), scopeFor(firstThread)),
    ).resolves.toMatchObject({
      kind: "apple-device-failure",
      failure: { category: "unavailable" },
    });
    const again = await discover(devices);
    expect(again.tooling).toContain("list-devices");
    expect(byName(again.devices, "Henrik's iPhone").state).toBe("connected");
  });

  it("starts a lease only when a person at the Mac confirmed it", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    const request = (extra: Record<string, unknown>) =>
      deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...extra });

    await expect(devices.request(request({}), scopeFor(firstThread))).resolves.toEqual({
      kind: "apple-device-refused",
      reason: "confirmation-required",
    });
    await expect(
      devices.request(
        request(approval),
        scopeFor(firstThread, {
          approvalValid: true,
          approvedBy: {
            kind: "remote-device",
            actorId: person.actorId,
            deviceId: "40000000-0000-4000-8000-000000000099",
          } as never,
        }),
      ),
    ).resolves.toEqual({ kind: "apple-device-refused", reason: "local-person-required" });
    // Full access does not start a lease on its own.
    await expect(
      devices.request(request(approval), scopeFor(firstThread, { executionPolicy: "full-access" })),
    ).resolves.toEqual({ kind: "apple-device-refused", reason: "confirmation-required" });
    expect(leases.list()).toEqual([]);

    await expect(devices.request(request(approval), confirmed(firstThread))).resolves.toEqual({
      kind: "apple-device-leased",
      deviceId: wired.deviceId,
      grantedAt: new Date(clock).toISOString(),
    });
    expect(leases.list()).toEqual([
      expect.objectContaining({ deviceId: wired.deviceId, threadId: firstThread.threadId }),
    ]);
    // Asking again for the lease the thread holds needs no new confirmation.
    await expect(devices.request(request({}), scopeFor(firstThread))).resolves.toMatchObject({
      kind: "apple-device-leased",
    });
  });

  it("starts a lease on a locked phone but never on an unavailable one", async () => {
    const devices = service();
    const discovery = await discover(devices);
    const lease = (name: string) =>
      devices.request(
        deviceRequest("use-device", firstThread, {
          deviceId: byName(discovery.devices, name).deviceId,
          ...approval,
        }),
        confirmed(firstThread),
      );
    await expect(lease("Test iPhone (locked)")).resolves.toMatchObject({
      kind: "apple-device-leased",
    });
    await expect(lease("Old iPad")).resolves.toEqual({
      kind: "apple-device-refused",
      reason: "unavailable",
    });
  });

  it("refuses a second thread a leased device without naming the thread that holds it", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    await devices.request(
      deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...approval }),
      confirmed(firstThread),
    );

    const refused = await devices.request(
      deviceRequest("use-device", secondThread, { deviceId: wired.deviceId, ...approval }),
      confirmed(secondThread),
    );
    expect(refused).toEqual({ kind: "apple-device-refused", reason: "destination-leased" });
    const status = await devices.request(
      deviceRequest("status", secondThread, { deviceId: wired.deviceId }),
      scopeFor(secondThread),
    );
    expect(status).toMatchObject({ kind: "apple-device-status", holder: "another-thread" });
    const seen = await discover(devices, secondThread);
    expect(seen.leases).toEqual([{ deviceId: wired.deviceId, holder: "another-thread" }]);
    for (const answer of [refused, status, { discovery: seen }]) {
      expect(JSON.stringify(answer)).not.toContain(firstThread.threadId);
    }
    // The holding thread cannot release it for the other one either.
    await expect(
      devices.request(
        deviceRequest("release-device", secondThread, { deviceId: wired.deviceId }),
        scopeFor(secondThread),
      ),
    ).resolves.toEqual({ kind: "apple-device-refused", reason: "destination-leased" });
  });

  it("gives a free device to only one of two threads confirmed for it at once", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    const answers = await Promise.all(
      [firstThread, secondThread].map((thread) =>
        devices.request(
          deviceRequest("use-device", thread, { deviceId: wired.deviceId, ...approval }),
          confirmed(thread),
        ),
      ),
    );
    expect(answers.map((answer) => answer.kind).toSorted()).toEqual([
      "apple-device-leased",
      "apple-device-refused",
    ]);
    expect(answers).toContainEqual({ kind: "apple-device-refused", reason: "destination-leased" });
    expect(leases.list()).toHaveLength(1);
  });

  it("moves a lease only from the thread the person was shown", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    await devices.request(
      deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...approval }),
      confirmed(firstThread),
    );
    const move = (fromThreadId: string) =>
      devices.request(
        deviceRequest("use-device", secondThread, {
          deviceId: wired.deviceId,
          fromThreadId,
          ...approval,
        }),
        confirmed(secondThread),
      );
    await expect(move(secondThread.threadId)).resolves.toEqual({
      kind: "apple-device-refused",
      reason: "lease-changed",
    });
    await expect(move(firstThread.threadId)).resolves.toMatchObject({
      kind: "apple-device-leased",
    });
    expect(leases.list()).toEqual([
      expect.objectContaining({ deviceId: wired.deviceId, threadId: secondThread.threadId }),
    ]);
  });

  it("releases a lease so another thread may ask for the device", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    await devices.request(
      deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...approval }),
      confirmed(firstThread),
    );
    await expect(
      devices.request(
        deviceRequest("release-device", firstThread, { deviceId: wired.deviceId }),
        scopeFor(firstThread, { executionPolicy: "plan" }),
      ),
    ).resolves.toEqual({ kind: "apple-device-released", deviceId: wired.deviceId });
    await expect(
      devices.request(
        deviceRequest("use-device", secondThread, { deviceId: wired.deviceId, ...approval }),
        confirmed(secondThread),
      ),
    ).resolves.toMatchObject({ kind: "apple-device-leased" });
  });

  it("ends a lease once its device has been gone longer than five minutes", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    await devices.request(
      deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...approval }),
      confirmed(firstThread),
    );
    const listing = JSON.parse(host.listing) as { result: { devices: Array<unknown> } };
    listing.result.devices.splice(0, 1);
    host.listing = JSON.stringify(listing);

    const gone = await discover(devices);
    // A device the thread holds stays listed, as unavailable, while it is away.
    expect(byName(gone.devices, "Henrik's iPhone").state).toBe("unavailable");
    expect(gone.leases).toEqual([{ deviceId: wired.deviceId, holder: "this-thread" }]);
    clock += APPLE_DEVICE_DISCONNECT_GRACE_MS;
    expect((await discover(devices)).leases).toHaveLength(1);
    clock += 1;
    const after = await discover(devices);
    expect(after.leases).toEqual([]);
    expect(after.devices.map((device) => device.name)).not.toContain("Henrik's iPhone");
  });

  it("fails a listing it cannot read instead of reporting no devices, and lets the lease lapse", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    await devices.request(
      deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...approval }),
      confirmed(firstThread),
    );
    host.listing = "{ not json";
    const failed = await devices.request(
      deviceRequest("discover", firstThread),
      scopeFor(firstThread),
    );
    expect(failed).toMatchObject({
      kind: "apple-device-failure",
      failure: { category: "unavailable" },
    });
    clock += APPLE_DEVICE_DISCONNECT_GRACE_MS + 1;
    expect(leases.list()).toEqual([]);
  });

  it("refuses a launch of an app the thread never installed, provisioning updates, and uploads", async () => {
    const devices = service();
    const wired = byName((await discover(devices)).devices, "Henrik's iPhone");
    await devices.request(
      deviceRequest("use-device", firstThread, { deviceId: wired.deviceId, ...approval }),
      confirmed(firstThread),
    );
    await expect(
      devices.request(
        deviceRequest("launch", firstThread, {
          deviceId: wired.deviceId,
          bundleIdentifier: "app.octant.fixture",
        }),
        scopeFor(firstThread, { executionPolicy: "full-access" }),
      ),
    ).resolves.toEqual({ kind: "apple-device-refused", reason: "foreign-bundle" });
    await expect(
      devices.request(
        deviceRequest("provisioning-update", firstThread, { deviceId: wired.deviceId }),
        scopeFor(firstThread, { executionPolicy: "full-access" }),
      ),
    ).resolves.toEqual({
      kind: "apple-device-refused",
      reason: "provisioning-updates-not-offered",
    });
    await expect(
      devices.request(deviceRequest("upload", firstThread, approval), confirmed(firstThread)),
    ).resolves.toEqual({ kind: "apple-device-refused", reason: "distribution-not-enabled" });
  });

  describe("the thread's own app on a leased device", () => {
    const build = { projectPath: "SimulatorFixture.xcodeproj", teamId: TEAM };
    // An approval-gated thread whose window holds this request's one-use approval.
    const approved = (thread = firstThread) => scopeFor(thread, { approvalValid: true });

    async function leased(name = "Henrik's iPhone", thread = firstThread) {
      const devices = service();
      const device = byName((await discover(devices, thread)).devices, name);
      const answer = await devices.request(
        deviceRequest("use-device", thread, { deviceId: device.deviceId, ...approval }),
        confirmed(thread),
      );
      expect(answer.kind).toBe("apple-device-leased");
      return { devices, deviceId: device.deviceId };
    }

    function evidenceOf(answer: AppleDeviceResponse): AppleDeviceEvidence {
      if (answer.kind !== "apple-device-evidence") throw new Error(JSON.stringify(answer));
      return answer.evidence;
    }

    it("builds the app unsigned, then signs that bundle with the person's identity for the team, offline", async () => {
      const { devices, deviceId } = await leased();
      const evidence = evidenceOf(
        await devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(evidence).toMatchObject({
        kind: "build",
        outcome: "succeeded",
        bundleIdentifier: "sh.octant.SimulatorFixture",
        signing: { teamId: TEAM, identity: FINGERPRINT },
      });
      const xcodebuild = host.calls.filter((argv) => argv[0] === "xcodebuild" && argv.length > 3);
      expect(xcodebuild.map((argv) => argv.at(-1))).toEqual(["-json", "build"]);
      for (const argv of xcodebuild) {
        expect(argv).toContain("CODE_SIGNING_ALLOWED=NO");
        expect(argv).toContain("generic/platform=iOS");
      }
      // Signing ran only under the port with no network, never as a build step.
      expect(host.calls.some((argv) => argv[0] === "codesign" || argv[0] === "security")).toBe(
        false,
      );
      expect(host.signingCalls.map((argv) => argv[0])).toEqual([
        "security",
        "codesign",
        "codesign",
      ]);
      for (const argv of host.signingCalls.slice(1)) {
        expect(argv).toEqual(expect.arrayContaining(["--sign", FINGERPRINT, "--timestamp=none"]));
      }
      expect(host.signingCalls[1]?.at(-1)).toMatch(/Fixture\.framework$/);
      expect(host.signingCalls[2]?.at(-1)).toMatch(/SimulatorFixture\.app$/);
      // The profile's entitlements, with its wildcard app ID narrowed to this app.
      expect(host.entitlements[0]).toContain(`<string>${TEAM}.sh.octant.SimulatorFixture</string>`);
      expect(host.entitlements[0]).toContain("<key>get-task-allow</key><true/>");
      // The entitlements file is gone once the signature is made.
      expect(await readdir(join(root, "signing"))).toEqual([]);
      const product = join(
        root,
        "artifacts",
        `device-derived-${evidence.actionId}`,
        PRODUCT_DIRECTORY,
        "SimulatorFixture.app",
      );
      expect((await stat(join(product, "embedded.mobileprovision"))).isFile()).toBe(true);
      // Octant never asks Apple to change provisioning, under any launch.
      for (const argv of [...host.calls, ...host.signingCalls]) {
        expect(argv).not.toContain("-allowProvisioningUpdates");
      }
    });

    it("journals which identity signed which product, and nothing that names the person or the device", async () => {
      const { devices, deviceId } = await leased();
      await devices.request(
        deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
        approved(),
      );
      expect(host.journal).toHaveLength(1);
      const recorded = JSON.stringify([host.journal, [...host.artifacts.values()]]);
      expect(recorded).toContain(FINGERPRINT);
      for (const secret of ["Jane Doe", "Z9Y8X7W6V5", root, ...HARDWARE_IDENTIFIERS]) {
        expect(recorded).not.toContain(secret);
      }
      expect(recorded).not.toContain(CORE_DEVICE_IDENTIFIERS[0]);
    });

    it("runs the fixture app on the device from an approval-gated thread, reads its console, and stops it", async () => {
      const { devices, deviceId } = await leased();
      const run = evidenceOf(
        await devices.request(
          deviceRequest("run", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(run).toMatchObject({
        kind: "run",
        outcome: "succeeded",
        bundleIdentifier: "sh.octant.SimulatorFixture",
        product: `apple-device-product-${run.actionId}`,
      });
      const launch = host.calls.find((argv) => argv.includes("--console"));
      expect(launch).toEqual([
        "xcrun",
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        CORE_DEVICE_IDENTIFIERS[0],
        "--terminate-existing",
        "--console",
        "sh.octant.SimulatorFixture",
      ]);
      const app = { deviceId, bundleIdentifier: "sh.octant.SimulatorFixture" };
      const logs = evidenceOf(
        await devices.request(deviceRequest("logs", firstThread, app), scopeFor(firstThread)),
      );
      expect(logs.outcome).toBe("succeeded");
      const consoleReference = logs.artifacts[0]?.reference ?? "";
      expect(host.artifacts.get(consoleReference)).toBe("Fixture ready on [ID]\n");
      // What the app printed is kept by reference; only its size is journaled.
      expect(JSON.stringify(logs.diagnostics)).not.toContain("Fixture ready");

      expect(
        evidenceOf(
          await devices.request(
            deviceRequest("terminate", firstThread, { ...app, ...approval }),
            approved(),
          ),
        ).outcome,
      ).toBe("succeeded");
      // Nothing is left to stop, and nothing is ever stopped by name.
      await expect(
        devices.request(
          deviceRequest("terminate", firstThread, { ...app, ...approval }),
          approved(),
        ),
      ).resolves.toEqual({ kind: "apple-device-refused", reason: "process-not-owned" });
      expect(
        host.calls.some((argv) => argv.includes("terminate") && !argv.includes("--help")),
      ).toBe(false);
    });

    it("installs only a product this thread's build signed, and launches only what it installed", async () => {
      const { devices, deviceId } = await leased();
      const built = evidenceOf(
        await devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      for (const artifact of ["apple-device-product-elsewhere", "Applications-Other.app"]) {
        await expect(
          devices.request(
            deviceRequest("install", firstThread, { deviceId, artifact, ...approval }),
            approved(),
          ),
        ).resolves.toEqual({ kind: "apple-device-refused", reason: "invalid-artifact" });
      }
      await expect(
        devices.request(
          deviceRequest("launch", firstThread, {
            deviceId,
            bundleIdentifier: "sh.octant.SimulatorFixture",
            ...approval,
          }),
          approved(),
        ),
      ).resolves.toEqual({ kind: "apple-device-refused", reason: "foreign-bundle" });
      expect(
        evidenceOf(
          await devices.request(
            deviceRequest("install", firstThread, {
              deviceId,
              artifact: built.product,
              ...approval,
            }),
            approved(),
          ),
        ).outcome,
      ).toBe("succeeded");
      // The person's other apps stay out of reach.
      await expect(
        devices.request(
          deviceRequest("launch", firstThread, {
            deviceId,
            bundleIdentifier: "com.apple.mobilesafari",
            ...approval,
          }),
          approved(),
        ),
      ).resolves.toEqual({ kind: "apple-device-refused", reason: "foreign-bundle" });

      // Another thread, on a device of its own, cannot redeem this thread's product.
      const other = byName((await discover(devices, secondThread)).devices, "Studio iPad");
      await devices.request(
        deviceRequest("use-device", secondThread, { deviceId: other.deviceId, ...approval }),
        confirmed(secondThread),
      );
      await expect(
        devices.request(
          deviceRequest("install", secondThread, {
            deviceId: other.deviceId,
            artifact: built.product,
            ...approval,
          }),
          approved(secondThread),
        ),
      ).resolves.toEqual({ kind: "apple-device-refused", reason: "invalid-artifact" });
    });

    it("asks for each effect's approval in an approval-gated thread and refuses every effect in Plan", async () => {
      const { devices, deviceId } = await leased();
      const before = host.calls.length;
      await expect(
        devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build }),
          scopeFor(firstThread),
        ),
      ).resolves.toEqual({ kind: "apple-device-refused", reason: "approval-required" });
      await expect(
        devices.request(
          deviceRequest("run", firstThread, { deviceId, ...build, ...approval }),
          scopeFor(firstThread, { executionPolicy: "plan", approvalValid: true }),
        ),
      ).resolves.toEqual({ kind: "apple-device-refused", reason: "read-only-policy" });
      // Only the discovery each request makes ran; nothing was built or signed.
      expect(host.calls.slice(before).some((argv) => argv.at(-1) === "build")).toBe(false);
      expect(host.signingCalls).toEqual([]);
    });

    it("needs no approval in Full access, but still the lease", async () => {
      const devices = service();
      const device = byName((await discover(devices)).devices, "Henrik's iPhone");
      const request = deviceRequest("build", firstThread, { deviceId: device.deviceId, ...build });
      const fullAccess = scopeFor(firstThread, { executionPolicy: "full-access" });
      await expect(devices.request(request, fullAccess)).resolves.toEqual({
        kind: "apple-device-refused",
        reason: "lease-required",
      });
      await devices.request(
        deviceRequest("use-device", firstThread, { deviceId: device.deviceId, ...approval }),
        confirmed(firstThread),
      );
      expect(evidenceOf(await devices.request(request, fullAccess)).outcome).toBe("succeeded");
    });

    it("names the step to take in Xcode when the keychain or profiles cannot sign the app, before building", async () => {
      const { devices, deviceId } = await leased();
      host.identities = "     0 valid identities found\n";
      const evidence = evidenceOf(
        await devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(evidence.outcome).toBe("failed");
      expect(evidence.signing).toBeUndefined();
      expect(evidence.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
        "no valid development signing identity",
      );
      expect(host.calls.some((argv) => argv.at(-1) === "build")).toBe(false);

      host.identities = `  1) ${FINGERPRINT} "Apple Development: Jane Doe (Z9Y8X7W6V5)"\n`;
      host.build = { bundleIdentifier: "com.example.Unprovisioned" };
      await writeFile(
        join(root, "profiles", "fixture.mobileprovision"),
        provisioningProfile(`${TEAM}.sh.octant.*`),
      );
      const unprovisioned = evidenceOf(
        await devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(unprovisioned.diagnostics.at(-1)?.message).toContain(
        "Octant does not create profiles",
      );
    });

    it("does not sign an app a build script swapped for a link to another app", async () => {
      const { devices, deviceId } = await leased();
      const elsewhere = join(root, "Elsewhere.app");
      await mkdir(elsewhere);
      host.build = { bundleIdentifier: "sh.octant.SimulatorFixture", plantLinkTo: elsewhere };
      const evidence = evidenceOf(
        await devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(evidence.outcome).toBe("failed");
      expect(host.signingCalls.filter((argv) => argv[0] === "codesign")).toEqual([]);
      expect(await readdir(elsewhere)).toEqual([]);
    });

    it("keeps devicectl's own words, which can name the device, out of an install's evidence", async () => {
      const { devices, deviceId } = await leased();
      host.installAnswer = "install-app-failed.json";
      const evidence = evidenceOf(
        await devices.request(
          deviceRequest("run", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(evidence.outcome).toBe("failed");
      expect(evidence.diagnostics.at(-1)?.message).toBe(
        "devicectl could not install the app (com.apple.dt.CoreDeviceError 3002).",
      );
      const recorded = JSON.stringify([host.journal, [...host.artifacts.values()]]);
      for (const identifier of HARDWARE_IDENTIFIERS) expect(recorded).not.toContain(identifier);
      expect(host.calls.some((argv) => argv.includes("--console"))).toBe(false);
    });

    it("touches the device no more once the lease ends while the app is still building", async () => {
      const { devices, deviceId } = await leased();
      host.build = {
        bundleIdentifier: "sh.octant.SimulatorFixture",
        whileBuilding: () => leases.release(String(deviceId), firstThread.threadId),
      };
      const evidence = evidenceOf(
        await devices.request(
          deviceRequest("run", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(evidence.outcome).toBe("failed");
      expect(evidence.diagnostics.at(-1)?.message).toContain("lease on the device ended");
      expect(host.calls.some((argv) => argv.includes("install") && !argv.includes("--help"))).toBe(
        false,
      );
      expect(host.calls.some((argv) => argv.includes("--console"))).toBe(false);
    });

    it("refuses a device action whose id another action already used, before building into its directory", async () => {
      const { devices, deviceId } = await leased();
      const built = evidenceOf(
        await devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      const other = byName((await discover(devices, secondThread)).devices, "Studio iPad");
      await devices.request(
        deviceRequest("use-device", secondThread, { deviceId: other.deviceId, ...approval }),
        confirmed(secondThread),
      );
      const builds = host.calls.filter((argv) => argv.at(-1) === "build").length;
      await expect(
        devices.request(
          deviceRequest("build", secondThread, {
            deviceId: other.deviceId,
            ...build,
            ...approval,
            actionId: built.actionId,
          }),
          approved(secondThread),
        ),
      ).resolves.toMatchObject({ kind: "apple-device-failure", failure: { category: "invalid" } });
      // The first thread's signed product stays the one its build made.
      expect(host.calls.filter((argv) => argv.at(-1) === "build")).toHaveLength(builds);
      expect(host.journal).toHaveLength(1);
    });

    it("keeps host paths out of the evidence when signing fails on a file it reads", async () => {
      const { devices, deviceId } = await leased();
      // Xcode replaces a profile while the app builds, after signing was chosen.
      host.build = {
        bundleIdentifier: "sh.octant.SimulatorFixture",
        whileBuilding: () => unlinkSync(join(root, "profiles", "fixture.mobileprovision")),
      };
      const evidence = evidenceOf(
        await devices.request(
          deviceRequest("build", firstThread, { deviceId, ...build, ...approval }),
          approved(),
        ),
      );
      expect(evidence.outcome).toBe("interrupted");
      const recorded = JSON.stringify([host.journal, [...host.artifacts.values()]]);
      expect(recorded).toContain("embedded.mobileprovision");
      expect(recorded).not.toContain(root);
    });

    it("ends the console session of the app when its thread's lease ends", async () => {
      const { devices, deviceId } = await leased();
      await devices.request(
        deviceRequest("run", firstThread, { deviceId, ...build, ...approval }),
        approved(),
      );
      await devices.request(
        deviceRequest("release-device", firstThread, { deviceId }),
        scopeFor(firstThread),
      );
      // The thread no longer holds the device, so it reads nothing more of it.
      await expect(
        devices.request(
          deviceRequest("logs", firstThread, {
            deviceId,
            bundleIdentifier: "sh.octant.SimulatorFixture",
          }),
          scopeFor(firstThread),
        ),
      ).resolves.toEqual({ kind: "apple-device-refused", reason: "lease-required" });
      await devices.request(
        deviceRequest("use-device", firstThread, { deviceId, ...approval }),
        confirmed(firstThread),
      );
      const logs = evidenceOf(
        await devices.request(
          deviceRequest("logs", firstThread, {
            deviceId,
            bundleIdentifier: "sh.octant.SimulatorFixture",
          }),
          scopeFor(firstThread),
        ),
      );
      expect(logs.diagnostics.at(-1)?.message).toContain("is no longer running (cancelled)");
    });
  });
});

describe("AppleDeviceLeases", () => {
  const lease = (thread: typeof firstThread, deviceId: string) => ({
    deviceId: deviceId as never,
    threadId: thread.threadId as never,
    checkoutId: thread.checkoutId as never,
    grantedBy: person as never,
    grantedAt: "2026-10-26T12:00:00.000Z" as never,
  });
  const phone = "44000000-0000-4000-8000-000000000001";
  const tablet = "44000000-0000-4000-8000-000000000002";

  it("ends a thread's leases when it is archived or purged", () => {
    const leases = new AppleDeviceLeases(() => 0);
    leases.start(lease(firstThread, phone));
    leases.start(lease(secondThread, tablet));
    expect(leases.threadSettled(firstThread.threadId, "thread-archived")).toEqual([
      { lease: lease(firstThread, phone), reason: "thread-archived" },
    ]);
    expect(leases.threadSettled(secondThread.threadId, "thread-purged")).toEqual([
      { lease: lease(secondThread, tablet), reason: "thread-purged" },
    ]);
    expect(leases.list()).toEqual([]);
  });

  it("ends a lease when its thread is bound to another checkout", () => {
    const leases = new AppleDeviceLeases(() => 0);
    leases.start(lease(firstThread, phone));
    expect(leases.threadCheckout(firstThread.threadId, firstThread.checkoutId)).toEqual([]);
    expect(
      leases.threadCheckout(firstThread.threadId, "40000000-0000-4000-8000-000000000099"),
    ).toEqual([{ lease: lease(firstThread, phone), reason: "checkout-rebound" }]);
  });

  it("keeps a lease whose device came back within five minutes", () => {
    let now = 0;
    const leases = new AppleDeviceLeases(() => now);
    leases.start(lease(firstThread, phone));
    leases.observeDevices([]);
    now += APPLE_DEVICE_DISCONNECT_GRACE_MS - 1;
    leases.observeDevices([{ deviceId: phone, state: "locked" }]);
    now += APPLE_DEVICE_DISCONNECT_GRACE_MS;
    expect(leases.list()).toHaveLength(1);
  });
});

describe("devicectl answers", () => {
  const listing = (device: Record<string, unknown>) => ({
    info: { outcome: "success" },
    result: {
      devices: [
        {
          identifier: "6E2B1C4A-0D5F-4E8B-9A71-3C2D1E0F9A09",
          connectionProperties: {
            pairingState: "paired",
            transportType: "wired",
            tunnelState: "connected",
          },
          deviceProperties: { developerModeStatus: "enabled", osVersionNumber: "26.1" },
          hardwareProperties: { deviceType: "iPhone", marketingName: "iPhone 16" },
          ...device,
        },
      ],
    },
  });

  it("keeps a device name from reordering or hiding the words of its confirmation", () => {
    const parsed = parseDevicectlDeviceList(
      listing({
        deviceProperties: {
          developerModeStatus: "enabled",
          osVersionNumber: "26.1",
          name: "Henrik‮'s iPhone\nAllow everything\u2028Thread: Release\u061c build",
        },
      }),
    );
    expect(parsed).toMatchObject({
      kind: "listed",
      devices: [{ name: "Henrik 's iPhone Allow everything Thread: Release  build" }],
    });
  });

  it("does not call a device ready for development unless it says Developer Mode is on", () => {
    const parsed = parseDevicectlDeviceList(
      listing({ deviceProperties: { osVersionNumber: "26.1", name: "Quiet iPhone" } }),
    );
    expect(parsed).toMatchObject({ devices: [{ listedState: "developer-mode-off" }] });
  });

  it("reads a failed or unexpected listing as unreadable, never as no devices", () => {
    expect(parseDevicectlDeviceList({ ...listing({}), info: { outcome: "failed" } })).toEqual({
      kind: "unreadable",
    });
    expect(parseDevicectlDeviceList({ info: { outcome: "success" }, result: {} })).toEqual({
      kind: "unreadable",
    });
    expect(parseDevicectlLockState({ info: { outcome: "success" }, result: {} })).toBe("unknown");
  });
});
