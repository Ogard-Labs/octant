import {
  attachWindowsHostRuntimeOwner,
  createWindowsHostStartup,
  resolveWindowsHostProfile,
  type WindowsHostProfileNative,
  type WindowsHostProfilePaths,
} from "@octant/host-runtime";
import { probeHostInfoReceipt, resolveStableHostAttachment } from "./serverProcess";

export interface WindowsDesktopHost {
  readonly native: WindowsHostProfileNative;
  readonly paths: WindowsHostProfilePaths;
  readonly startup: NonNullable<ReturnType<typeof createWindowsHostStartup>>;
}

/** Native facts select the profile; desktop main never claims the child server's ownership. */
export function resolveWindowsDesktopHost(options: {
  readonly native: WindowsHostProfileNative;
  readonly profile: "octant" | "nightly-test-data";
  readonly env: Readonly<Record<string, string | undefined>>;
}): WindowsDesktopHost {
  const resolved = resolveWindowsHostProfile(options);
  if (resolved.status !== "ready")
    throw new Error("Octant could not resolve its private native Windows profile.");
  const startup = createWindowsHostStartup(options.native, resolved.paths);
  if (startup === undefined)
    throw new Error("Octant's private native Windows startup files are unavailable.");
  return { native: options.native, paths: resolved.paths, startup };
}

/** Only positive native absence permits launch; unsafe discovery never becomes a second host. */
export async function attachWindowsDesktopHost(
  host: WindowsDesktopHost,
  startingInstanceId?: string,
) {
  const found = await attachWindowsHostRuntimeOwner({
    native: host.native,
    scope: host.paths.profileId,
    hostId: host.paths.profileId,
    wireVersion: "1",
  });
  if (found.status === "missing") return undefined;
  if (found.status !== "attached")
    throw new Error("Octant could not authenticate its existing native Windows host.");
  const owner = found.attachment.owner;
  // The authenticated child owns its endpoint before it publishes discovery.
  // Its own startup wait uses health readiness; only competing owners attach.
  if (startingInstanceId !== undefined && owner.instanceId === startingInstanceId) return undefined;
  const attached = await resolveStableHostAttachment({
    readReceipt: async () => {
      const receipt = await host.startup.readHostInfo();
      return receipt !== undefined &&
        receipt.instanceId === owner.instanceId &&
        receipt.controlEndpoint === owner.endpoint
        ? receipt
        : undefined;
    },
    readBridgeSecret: host.startup.readBridgeSecret,
    probeReceipt: (receipt) =>
      probeHostInfoReceipt({
        receipt,
        expectedHostId: host.paths.profileId,
        expectedWireVersion: "1",
        expectedControlEndpoint: owner.endpoint,
      }),
  });
  if (attached === undefined)
    throw new Error("Octant's native Windows host discovery changed or is unavailable.");
  return attached;
}
