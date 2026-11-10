import type {
  DiscoveryCandidate,
  DiscoverySnapshot,
  FirstRunOnboardingStatus,
  ProviderInstance,
  ProviderInstanceId,
} from "@octant/contracts";
import {
  groupByDriverKind,
  initialEnabledForDiscovery,
  isAcpAgentInstance,
  isFirstRunDiscoveryEnablementEligible,
  selectPreferredCandidate,
  shouldAutoRegisterCandidate,
} from "@octant/domain";

export async function autoRegisterPreferredCandidates(input: {
  readonly snapshot: DiscoverySnapshot;
  readonly listInstances: () => Promise<ReadonlyArray<ProviderInstance>>;
  readonly createFromDiscovery: (
    candidate: DiscoveryCandidate,
    options: { readonly enabled: boolean },
  ) => Promise<ProviderInstanceId>;
  readonly firstRunOnboarding: FirstRunOnboardingStatus;
  readonly movedBinaries?: MovedBinaryRepair;
}): Promise<{ snapshot: DiscoverySnapshot; createdIds: ProviderInstanceId[] }> {
  return enqueueAutoRegister(async () => {
    if (input.movedBinaries !== undefined) {
      await repointMovedBinaries(input.snapshot, input.listInstances, input.movedBinaries);
    }
    return autoRegisterPreferredCandidatesUnlocked(input);
  });
}

/**
 * How a scan repairs a runtime whose saved binary is gone. `exists` answers
 * for the saved path; `repoint` changes only the instance's binary path.
 */
export interface MovedBinaryRepair {
  readonly exists: (binaryPath: string) => Promise<boolean>;
  readonly repoint: (instance: ProviderInstance, binaryPath: string) => Promise<void>;
}

/**
 * Points a runtime whose saved binary no longer exists at the launcher this
 * scan found for the same driver. Runtimes move when they are reinstalled
 * another way or update themselves; a Claude Code saved under an npm prefix
 * stayed "not found" for two months after a native install replaced it,
 * because nothing looked at the saved path again. Only a missing file is
 * repaired: a saved binary that exists is never second-guessed, and the
 * instance's switch and every other setting stay as they were.
 */
async function repointMovedBinaries(
  snapshot: DiscoverySnapshot,
  listInstances: () => Promise<ReadonlyArray<ProviderInstance>>,
  repair: MovedBinaryRepair,
): Promise<void> {
  // A failed or cancelled scan proves nothing about what is installed.
  if (snapshot.status === "failed" || snapshot.status === "cancelled") return;
  const byDriver = groupByDriverKind(
    snapshot.candidates.filter(
      (candidate) =>
        candidate.readiness !== "incompatible" && candidate.readiness !== "unavailable",
    ),
  );
  for (const instance of await listInstances()) {
    const saved = configuredBinaryPath(instance);
    if (saved === undefined) continue;
    const found = selectPreferredCandidate(
      byDriver.get(instance.driverKind as DiscoveryCandidate["driverKind"]) ?? [],
    );
    if (found === undefined) continue;
    const launcher = found.discoveredPath ?? found.binaryPath;
    if (launcher === saved || found.binaryPath === saved) continue;
    try {
      if (await repair.exists(saved)) continue;
      await repair.repoint(instance, launcher);
    } catch {
      // A refused repair leaves the card as it was; Settings still offers the
      // found binary, and the scan's own result is unaffected.
    }
  }
}

let autoRegisterGate: Promise<void> = Promise.resolve();

async function enqueueAutoRegister<T>(run: () => Promise<T>): Promise<T> {
  const previous = autoRegisterGate;
  let release: () => void = () => undefined;
  autoRegisterGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

async function autoRegisterPreferredCandidatesUnlocked(input: {
  readonly snapshot: DiscoverySnapshot;
  readonly listInstances: () => Promise<ReadonlyArray<ProviderInstance>>;
  readonly createFromDiscovery: (
    candidate: DiscoveryCandidate,
    options: { readonly enabled: boolean },
  ) => Promise<ProviderInstanceId>;
  readonly firstRunOnboarding: FirstRunOnboardingStatus;
}): Promise<{ snapshot: DiscoverySnapshot; createdIds: ProviderInstanceId[] }> {
  if (input.snapshot.status === "cancelled" && input.snapshot.candidates.length === 0) {
    return {
      snapshot: { ...input.snapshot, autoRegisteredInstanceIds: [] },
      createdIds: [],
    };
  }

  const existingInstances: Array<{
    driverKind: DiscoveryCandidate["driverKind"];
    binaryPath: string;
  }> = (await input.listInstances()).map((instance) => ({
    driverKind: instance.driverKind as DiscoveryCandidate["driverKind"],
    binaryPath: configuredBinaryPath(instance) ?? "",
  }));
  // Eligibility is a scan-level fact. Recomputing it after the first create
  // would block the second supported default in the same first-run scan.
  const firstRunEnablementEligible = isFirstRunDiscoveryEnablementEligible({
    firstRunOnboarding: input.firstRunOnboarding,
    existingInstanceCount: existingInstances.length,
  });
  const createdIds: ProviderInstanceId[] = [];

  for (const candidates of groupByDriverKind(input.snapshot.candidates).values()) {
    const preferred = selectPreferredCandidate(candidates);
    if (preferred === undefined) continue;
    if (
      shouldAutoRegisterCandidate({
        candidate: preferred,
        existingInstances,
      }).kind !== "allowed"
    ) {
      continue;
    }
    const enabled = initialEnabledForDiscovery({
      driverKind: preferred.driverKind,
      firstRunEnablementEligible,
    });
    try {
      const instanceId = await input.createFromDiscovery(preferred, { enabled });
      createdIds.push(instanceId);
      existingInstances.push({
        driverKind: preferred.driverKind,
        binaryPath: preferred.binaryPath,
      });
    } catch {
      // Auto-registration is a convenience layered on top of discovery. A
      // provider-specific create failure must not hide the valid candidates
      // from Settings or prevent other families from being registered.
    }
  }

  return {
    snapshot: { ...input.snapshot, autoRegisteredInstanceIds: createdIds },
    createdIds,
  };
}

function configuredBinaryPath(instance: ProviderInstance): string | undefined {
  switch (instance.configuration.kind) {
    case "opencode-cli":
    case "codex-cli":
    case "claude-agent-sdk":
    case "pi-rpc":
    case "oh-my-pi-rpc":
      return instance.configuration.binaryPath;
    default:
      return isAcpAgentInstance(instance) ? instance.configuration.binaryPath : undefined;
  }
}
