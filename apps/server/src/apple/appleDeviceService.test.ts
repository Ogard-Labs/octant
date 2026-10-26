import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAppleDeviceRequest,
  type AppleDeviceRecord,
  type AppleDeviceRequest,
  type AppleDeviceResponse,
} from "@octant/contracts";
import type { AppleDeviceExecutionScope } from "@octant/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppleDeviceLeases, APPLE_DEVICE_DISCONNECT_GRACE_MS } from "./appleDeviceLeases";
import { AppleDeviceService } from "./appleDeviceService";
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

function scopeFor(
  thread: typeof firstThread,
  extra: Partial<AppleDeviceExecutionScope> = {},
): AppleDeviceExecutionScope {
  return {
    authority: authority as never,
    threadId: thread.threadId as never,
    checkoutId: thread.checkoutId as never,
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
}

function fakeExecute(host: Host) {
  return async (input: { readonly argv: ReadonlyArray<string> }): Promise<AppleProcessResult> => {
    host.calls.push(input.argv);
    const ok = (stdout = ""): AppleProcessResult => ({
      termination: "exited",
      exitCode: 0,
      stdout: new TextEncoder().encode(stdout),
      stderr: new Uint8Array(),
      parserFailed: false,
      cleanupUncertain: false,
    });
    const failed: AppleProcessResult = { ...ok(), exitCode: 1 };
    const [tool, ...rest] = input.argv;
    if (tool === "xcode-select") {
      return host.xcode === "selected"
        ? ok("/Applications/Xcode.app/Contents/Developer\n")
        : failed;
    }
    if (tool === "xcodebuild") return ok();
    if (tool !== "xcrun" || rest[0] !== "devicectl") return failed;
    const args = rest.slice(1);
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
    return failed;
  };
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
    };
    clock = 1_000_000;
    leases = new AppleDeviceLeases(() => clock);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let idNumber = 0;
  function service(platform: NodeJS.Platform = "darwin", store = new AppleRuntimeStore(root)) {
    return new AppleDeviceService({
      execute: fakeExecute(host),
      outputDirectory: join(root, "devicectl"),
      identities: store,
      leases,
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

  it("answers only discovery, status, and the lease from this host", async () => {
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
