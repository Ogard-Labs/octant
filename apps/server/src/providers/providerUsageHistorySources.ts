import type { LocalUsageHistoryCheckpointStore } from "./localUsageHistoryReader";
import { LOCAL_PRICING_REVISION } from "@octant/domain/local-usage-pricing";
import { providerAccountProfile } from "@octant/domain";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import type { ProviderDriverKind, ProviderInstanceId } from "@octant/contracts";
import { join } from "node:path";
import { createClaudeLocalUsageHistorySource } from "./claudeUsageHistory";
import { createCodexLocalUsageHistorySource } from "./codexUsageHistory";

export { createClaudeLocalUsageHistorySource } from "./claudeUsageHistory";
export { createCodexLocalUsageHistorySource } from "./codexUsageHistory";

/**
 * Maps a configured built-in driver to its documented local accounting source.
 * Provider payload parsing remains inside the driver-owned adapter modules;
 * unsupported providers return undefined and are not advertised.
 */
/**
 * Multi-account drivers keep one source per instance. Deduping only by
 * `sourceKind` would drop every extra Codex or Claude home after the first.
 */
export function localUsageHistorySourceKey(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly sourceKind: string;
}): string {
  return providerAccountProfile(input.driverKind)?.supportsMultipleAccounts === true
    ? `${input.sourceKind}:${String(input.instanceId)}`
    : input.sourceKind;
}

export function createLocalUsageHistorySourceForDriver(input: {
  readonly driverKind: ProviderDriverKind;
  readonly home: string;
  readonly claudeConfigDirectory?: string;
  readonly codexHome?: string;
  readonly checkpointStore?: LocalUsageHistoryCheckpointStore;
}): ProviderLocalUsageHistorySource | undefined {
  if (input.driverKind === "codex") {
    return createCodexLocalUsageHistorySource({
      root: input.codexHome ?? join(input.home, ".codex"),
      ...(input.checkpointStore === undefined
        ? {}
        : { checkpointStore: input.checkpointStore, checkpointRevision: LOCAL_PRICING_REVISION }),
      allowedRelativeRoots: ["sessions", "archived_sessions"],
    });
  }
  if (input.driverKind === "claude") {
    return createClaudeLocalUsageHistorySource({
      root: join(input.claudeConfigDirectory ?? join(input.home, ".claude"), "projects"),
      ...(input.checkpointStore === undefined
        ? {}
        : { checkpointStore: input.checkpointStore, checkpointRevision: LOCAL_PRICING_REVISION }),
    });
  }
  return undefined;
}
