import {
  attachWindowsHostRuntimeOwner,
  createWindowsHostStartup,
  resolveWindowsHostProfile,
  type WindowsHostProfileNative,
  type WindowsHostProfilePaths,
} from "@octant/host-runtime";
import {
  probeHostInfoReceipt,
  resolveStableHostAttachment,
  type ManagedChildProcess,
} from "./serverProcess";

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

const UNANSWERED_ATTACH_ATTEMPTS = 3;
const UNANSWERED_ATTACH_PAUSE_MS = 250;

function discoverWindowsDesktopOwner(host: WindowsDesktopHost) {
  return attachWindowsHostRuntimeOwner({
    native: host.native,
    scope: host.paths.profileId,
    hostId: host.paths.profileId,
    wireVersion: "1",
  });
}

/** Only positive native absence permits launch; unsafe discovery never becomes a second host. */
export async function attachWindowsDesktopHost(
  host: WindowsDesktopHost,
  startingChild?: Pick<ManagedChildProcess, "exitCode" | "signalCode">,
) {
  // Startup may own the pipe before its event loop can answer control requests.
  // Keep waiting for this held child's health; discover a winner after it exits.
  if (
    startingChild !== undefined &&
    startingChild.exitCode === null &&
    startingChild.signalCode === null
  )
    return undefined;
  let found = await discoverWindowsDesktopOwner(host);
  // Package run 42539121763 refused a valid Stable owner right after it
  // published readiness, while the identical code had attached in the run
  // before. Only an unanswered control pipe is retried, a bounded number of
  // times; each lookup re-authenticates the owner record and process birth.
  for (
    let attempt = 1;
    attempt < UNANSWERED_ATTACH_ATTEMPTS &&
    found.status === "refused" &&
    found.reason === "unanswered";
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, UNANSWERED_ATTACH_PAUSE_MS));
    found = await discoverWindowsDesktopOwner(host);
  }
  if (found.status === "missing") return undefined;
  if (found.status !== "attached")
    throw new Error(
      `Octant could not authenticate its existing native Windows host (${found.reason}).`,
    );
  const owner = found.attachment.owner;
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

/** Never stop a winning replacement or a host this desktop only borrowed. */
export async function requestWindowsDesktopHostStop(
  host: WindowsDesktopHost,
  instanceId: string,
): Promise<boolean> {
  const found = await discoverWindowsDesktopOwner(host);
  return (
    found.status === "attached" &&
    found.attachment.owner.instanceId === instanceId &&
    (await found.attachment.requestStop())
  );
}
