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
}): Promise<{ snapshot: DiscoverySnapshot; createdIds: ProviderInstanceId[] }> {
  return enqueueAutoRegister(() => autoRegisterPreferredCandidatesUnlocked(input));
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
    case "kimi-code-acp":
    case "claude-agent-sdk":
    case "mistral-vibe-acp":
    case "grok-acp":
    case "goose-acp":
    case "glm-acp":
    case "gemini-acp":
    case "copilot-acp":
    case "cline-acp":
    case "qwen-acp":
    case "devin-acp":
    case "kilo-acp":
    case "pi-rpc":
      return instance.configuration.binaryPath;
    default:
      return undefined;
  }
}
