import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import type { ProviderDriverKind } from "@octant/contracts";
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
  readonly root: string;
}): ProviderLocalUsageHistorySource | undefined {
  if (input.driverKind === "codex") {
    return createCodexLocalUsageHistorySource({ root: input.root });
  }
  if (input.driverKind === "claude") {
    return createClaudeLocalUsageHistorySource({ root: input.root });
  }
  return undefined;
}
