import type {
  DiscoveryCandidate,
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
} from "@octant/contracts";
import {
  groupByDriverKind,
  selectPreferredCandidate,
  shouldAutoRegisterCandidate,
} from "@octant/domain";

export async function autoRegisterPreferredCandidates(input: {
  readonly snapshot: DiscoverySnapshot;
  readonly listInstances: () => Promise<ReadonlyArray<ProviderInstance>>;
  readonly createDisabled: (candidate: DiscoveryCandidate) => Promise<ProviderInstanceId>;
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
    try {
      const instanceId = await input.createDisabled(preferred);
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
    case "devin-acp":
    case "kilo-acp":
    case "pi-rpc":
      return instance.configuration.binaryPath;
    default:
      return undefined;
  }
}
