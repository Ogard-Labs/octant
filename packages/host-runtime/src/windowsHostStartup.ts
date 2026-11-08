import { win32 } from "node:path";
import { BoundedHostLogStore } from "./logs";
import { ServicePolicyStore } from "./servicePolicy";
import { decodeHostInfoReceipt, encodeHostInfoReceipt, type HostInfoReceipt } from "./hostInfo";
import { createWindowsHostStartupFiles } from "./windowsAuthorityState";
import { readPrivateFileText, replacePrivateFileText } from "./privateFileText";
import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

const BRIDGE_SECRET = /^[A-Za-z0-9_-]{43}$/;
const PIPE_ENDPOINT = /^\\\\\.\\pipe\\Octant-host-[0-9a-f]{64}$/;

/** Read discovery without a lease; only the actual child owner may publish or clear it. */
export function createWindowsHostStartup(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
) {
  const files = createWindowsHostStartupFiles(native, paths);
  if (files === undefined) return undefined;
  const readBridgeSecret = async (): Promise<string | undefined> => {
    const result = readPrivateFileText(files.bridgeSecret, 44);
    if (result.status === "missing") return undefined;
    if (result.status !== "ready")
      throw new Error("The native bridge projection is unsafe or unavailable.");
    const secret = result.text.endsWith("\n") ? result.text.slice(0, -1) : result.text;
    if (!BRIDGE_SECRET.test(secret)) throw new Error("The native bridge projection is invalid.");
    return secret;
  };
  const readHostInfo = async (): Promise<HostInfoReceipt | undefined> => {
    const result = readPrivateFileText(files.hostInfo, 4096);
    if (result.status === "missing") return undefined;
    if (result.status !== "ready")
      throw new Error("The native host projection is unsafe or unavailable.");
    const receipt = decodeHostInfoReceipt(result.text);
    if (receipt.hostId !== paths.profileId || !PIPE_ENDPOINT.test(receipt.controlEndpoint))
      throw new Error("The native host projection is inconsistent with its profile.");
    return receipt;
  };
  return Object.freeze({
    servicePolicy: new ServicePolicyStore({
      path: win32.join(paths.configDirectory, "service-policy.json"),
      privateFile: files.servicePolicy,
    }),
    logs: new BoundedHostLogStore({
      path: win32.join(paths.logsDirectory, "service.log"),
      privateFile: files.serviceLog,
    }),
    readBridgeSecret,
    readHostInfo,
    writeBridgeSecret: async (secret: string): Promise<void> => {
      if (
        !BRIDGE_SECRET.test(secret) ||
        replacePrivateFileText(files.bridgeSecret, `${secret}\n`).status !== "committed"
      )
        throw new Error("The native bridge projection could not be written.");
    },
    writeHostInfo: async (receipt: HostInfoReceipt): Promise<void> => {
      if (
        receipt.hostId !== paths.profileId ||
        !PIPE_ENDPOINT.test(receipt.controlEndpoint) ||
        replacePrivateFileText(files.hostInfo, encodeHostInfoReceipt(receipt)).status !==
          "committed"
      )
        throw new Error("The native host projection could not be written.");
    },
    clearProjections: async (expected: {
      readonly instanceId: string;
      readonly bridgeSecret?: string;
    }): Promise<void> => {
      const receipt = await readHostInfo();
      if (
        receipt?.instanceId === expected.instanceId &&
        files.hostInfo.remove().status !== "removed"
      )
        throw new Error("The native host projection could not be cleared.");
      if (
        expected.bridgeSecret !== undefined &&
        (await readBridgeSecret()) === expected.bridgeSecret &&
        files.bridgeSecret.remove().status !== "removed"
      )
        throw new Error("The native bridge projection could not be cleared.");
    },
  });
}
