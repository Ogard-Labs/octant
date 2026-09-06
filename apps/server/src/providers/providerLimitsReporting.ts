import type { ProviderDriverKind, ProviderUsageLimitsUnavailableReason } from "@octant/contracts";
import type { ProviderRuntimeTurnReport } from "./providerRuntimeUsageLimitsStore";

/**
 * How a runtime can disclose account limits, if at all. Settings shows this
 * so a reader knows whether to wait for a report or stop expecting one.
 *
 * - `usage-windows`: the CLI runtime narrates rolling usage windows during a
 *   turn (Claude Code, Codex app-server).
 * - `response-headers`: the HTTP endpoint attaches quota headers to the
 *   responses Octant already requests.
 * - `runtime-does-not-report`: the protocol has no limits channel; the
 *   limits belong to the account behind the runtime.
 * - `local-runtime`: the model runs on this computer and has no account.
 */
export type ProviderLimitsReporting =
  | "usage-windows"
  | "response-headers"
  | "runtime-does-not-report"
  | "local-runtime";

export function providerLimitsReporting(kind: ProviderDriverKind): ProviderLimitsReporting {
  switch (kind) {
    case "claude":
    case "codex":
      return "usage-windows";
    case "openai-compatible":
    case "anthropic-compatible":
    case "azure-foundry":
      return "response-headers";
    case "ollama":
      return "local-runtime";
    case "opencode":
    case "pi":
    case "oh-my-pi":
    case "kilo":
    case "devin":
    case "mistral-vibe":
    case "kimi-code":
    case "grok":
    case "goose":
    case "glm":
    case "gemini":
    case "copilot":
    case "cline":
    case "qwen":
    case "openai-image":
    case "gemini-native-image":
    case "bfl-image":
      return "runtime-does-not-report";
  }
}

/**
 * The reason to show when no limit evidence exists for an enabled instance.
 * `unsupported` keeps its meaning of "can report, has not yet"; the other
 * reasons close the question instead of leaving a reader waiting.
 */
export function unavailableLimitsReason(
  kind: ProviderDriverKind,
  lastCompletedTurn: ProviderRuntimeTurnReport | undefined,
): ProviderUsageLimitsUnavailableReason {
  switch (providerLimitsReporting(kind)) {
    case "usage-windows":
      return "unsupported";
    case "response-headers":
      return lastCompletedTurn === "silent" ? "endpoint-silent" : "unsupported";
    case "runtime-does-not-report":
      return "runtime-does-not-report";
    case "local-runtime":
      return "local-runtime";
  }
}
