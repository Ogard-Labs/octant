import type { LocalUsageHistoryCheckpointStore } from "./localUsageHistoryReader";
import { LOCAL_PRICING_REVISION } from "./localUsagePricing";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import type { ProviderDriverKind } from "@octant/contracts";
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
export function createLocalUsageHistorySourceForDriver(input: {
  readonly driverKind: ProviderDriverKind;
  readonly home: string;
  readonly checkpointStore?: LocalUsageHistoryCheckpointStore;
}): ProviderLocalUsageHistorySource | undefined {
  if (input.driverKind === "codex") {
    return createCodexLocalUsageHistorySource({
      root: join(input.home, ".codex"),
      ...(input.checkpointStore === undefined
        ? {}
        : { checkpointStore: input.checkpointStore, checkpointRevision: LOCAL_PRICING_REVISION }),
      allowedRelativeRoots: ["sessions", "archived_sessions"],
    });
  }
  if (input.driverKind === "claude") {
    return createClaudeLocalUsageHistorySource({
      root: join(input.home, ".claude", "projects"),
      ...(input.checkpointStore === undefined
        ? {}
        : { checkpointStore: input.checkpointStore, checkpointRevision: LOCAL_PRICING_REVISION }),
    });
  }
  return undefined;
}
