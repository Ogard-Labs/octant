import { beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  attachWindowsHostRuntimeOwner,
  BoundedHostLogStore,
  ServicePolicyStore,
  type HostInfoReceipt,
  type WindowsHostProfileNative,
} from "@octant/host-runtime";
import { probeHostInfoReceipt } from "./serverProcess";
import {
  attachWindowsDesktopHost,
  requestWindowsDesktopHostStop,
  type WindowsDesktopHost,
} from "./windowsDesktopHost";

vi.mock("@octant/host-runtime", async (original) => ({
  ...(await original<typeof import("@octant/host-runtime")>()),
  attachWindowsHostRuntimeOwner: vi.fn(),
}));
vi.mock("./serverProcess", async (original) => ({
  ...(await original<typeof import("./serverProcess")>()),
  probeHostInfoReceipt: vi.fn(),
}));

const profileId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const endpoint = "\\\\.\\pipe\\Octant-host-" + "a".repeat(64);
const receipt: HostInfoReceipt = {
  schemaVersion: 1,
  hostId: profileId,
  instanceId,
  controlEndpoint: endpoint,
  url: "http://127.0.0.1:43124/",
  serviceMode: "foreground",
  serverVersion: "1",
  wireVersion: "1",
  updatedAt: "2026-11-08T00:00:00.000Z",
};
const native: WindowsHostProfileNative = {
  apiVersion: 1,
  frameBytes: 16384,
  openProfile: vi.fn(),
  prepare: vi.fn(),
  claim: vi.fn(),
  poll: vi.fn(),
  reply: vi.fn(),
  close: vi.fn(),
  lookup: vi.fn(),
  beginRequest: vi.fn(),
  pollRequest: vi.fn(),
  closeRequest: vi.fn(),
};
function fixture(): WindowsDesktopHost {
  return {
    native,
    paths: {
      platform: "win32",
      profile: "octant",
      profileId,
      rootDirectory: "C:\\profile",
      dataDirectory: "C:\\profile\\data",
      configDirectory: "C:\\profile\\config",
      stateDirectory: "C:\\profile\\state",
      logsDirectory: "C:\\profile\\logs",
    },
    startup: {
      servicePolicy: new ServicePolicyStore({ path: join(tmpdir(), "unused-desktop-policy") }),
      logs: new BoundedHostLogStore({ path: join(tmpdir(), "unused-desktop-log") }),
      readHostInfo: vi.fn(async () => receipt),
      readBridgeSecret: vi.fn(async () => "native-secret"),
      writeHostInfo: vi.fn(async () => undefined),
      writeBridgeSecret: vi.fn(async () => undefined),
      clearProjections: vi.fn(async () => undefined),
    },
  };
}
function attached() {
  vi.mocked(attachWindowsHostRuntimeOwner).mockResolvedValue({
    status: "attached",
    attachment: {
      kind: "attached",
      owner: {
        schemaVersion: 1,
        hostId: profileId,
        instanceId,
        endpoint,
        pid: 42,
        processStart: "win32:0000000100000002",
        serverVersion: "1",
        wireVersion: "1",
        serviceMode: "foreground",
        nonceDigest: "a".repeat(64),
        createdAt: receipt.updatedAt,
      },
      request: async () => undefined,
      requestStop: vi.fn(async () => true),
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(probeHostInfoReceipt).mockResolvedValue({ url: receipt.url, instanceId });
});

it("permits startup only on positive native absence and refuses unsafe discovery", async () => {
  const host = fixture();
  vi.mocked(attachWindowsHostRuntimeOwner).mockResolvedValue({ status: "missing" });
  await expect(attachWindowsDesktopHost(host)).resolves.toBeUndefined();
  vi.mocked(attachWindowsHostRuntimeOwner).mockResolvedValue({ status: "refused" });
  await expect(attachWindowsDesktopHost(host)).rejects.toThrow("authenticate");
  expect(host.startup.readHostInfo).not.toHaveBeenCalled();
  expect(probeHostInfoReceipt).not.toHaveBeenCalled();
});

it("attaches only the native profile identity and matching authenticated generation without mutation", async () => {
  const host = fixture();
  attached();
  await expect(attachWindowsDesktopHost(host)).resolves.toMatchObject({
    bridgeSecret: "native-secret",
  });
  expect(attachWindowsHostRuntimeOwner).toHaveBeenCalledWith({
    native,
    scope: profileId,
    hostId: profileId,
    wireVersion: "1",
  });
  expect(probeHostInfoReceipt).toHaveBeenCalledWith(
    expect.objectContaining({ expectedHostId: profileId, expectedControlEndpoint: endpoint }),
  );
  expect(native.prepare).not.toHaveBeenCalled();
  expect(native.claim).not.toHaveBeenCalled();
  expect(host.startup.writeBridgeSecret).not.toHaveBeenCalled();
  expect(host.startup.writeHostInfo).not.toHaveBeenCalled();
});

it("refuses a projection from another native owner instance or endpoint rather than launching", async () => {
  attached();
  for (const changed of [
    { ...receipt, instanceId: "33333333-3333-4333-8333-333333333333" },
    { ...receipt, controlEndpoint: "\\\\.\\pipe\\Octant-host-" + "b".repeat(64) },
  ]) {
    const host = fixture();
    vi.mocked(host.startup.readHostInfo).mockResolvedValue(changed);
    await expect(attachWindowsDesktopHost(host)).rejects.toThrow("discovery changed");
  }
  expect(probeHostInfoReceipt).not.toHaveBeenCalled();
});

it("defers competing-owner discovery while its exact startup child remains live", async () => {
  const host = fixture();
  const child = { exitCode: null as number | null, signalCode: null };
  vi.mocked(attachWindowsHostRuntimeOwner).mockResolvedValue({ status: "refused" });
  await expect(attachWindowsDesktopHost(host, child)).resolves.toBeUndefined();
  expect(attachWindowsHostRuntimeOwner).not.toHaveBeenCalled();
  expect(host.startup.readHostInfo).not.toHaveBeenCalled();
  child.exitCode = 0;
  await expect(attachWindowsDesktopHost(host, child)).rejects.toThrow("authenticate");
  attached();
  vi.mocked(host.startup.readHostInfo).mockResolvedValue(undefined);
  await expect(attachWindowsDesktopHost(host, child)).rejects.toThrow("discovery changed");
});

it("stops only its authenticated exact owned launch and never another profile owner generation", async () => {
  attached();
  const host = fixture();
  await expect(requestWindowsDesktopHostStop(host, instanceId)).resolves.toBe(true);
  const found = await attachWindowsHostRuntimeOwner({
    native,
    scope: profileId,
    hostId: profileId,
    wireVersion: "1",
  });
  if (found.status !== "attached") throw Error("Expected native owner fixture.");
  expect(found.attachment.requestStop).toHaveBeenCalledOnce();
  vi.mocked(found.attachment.requestStop).mockClear();
  await expect(
    requestWindowsDesktopHostStop(host, "33333333-3333-4333-8333-333333333333"),
  ).resolves.toBe(false);
  expect(found.attachment.requestStop).not.toHaveBeenCalled();
  vi.mocked(attachWindowsHostRuntimeOwner).mockResolvedValue({ status: "refused" });
  await expect(requestWindowsDesktopHostStop(host, instanceId)).resolves.toBe(false);
});
