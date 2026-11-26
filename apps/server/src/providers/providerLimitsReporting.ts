import {
  isAcpAgentKind,
  type ProviderDriverKind,
  type ProviderUsageLimitsUnavailableReason,
} from "@octant/contracts";
import type { ProviderRuntimeTurnReport } from "./providerRuntimeUsageLimitsStore";

/**
 * How a runtime can disclose account limits, if at all. Settings shows this
 * so a reader knows whether to wait for a report or stop expecting one.
 *
 * - `usage-windows`: the CLI runtime narrates rolling usage windows during a
 *   turn (Claude Code, Codex app-server).
 * - `account-endpoint`: Octant reads the account's plan windows from the
 *   provider's usage endpoint with the credential already on the host
 *   (Devin and OpenCode Go from the sign-in the CLI saved; Mistral Vibe
 *   from the API key Settings holds). No figures means that credential is
 *   missing.
 * - `status-line`: Octant passively reads the local quota snapshot captured by
 *   the CLI's documented `statusLine` hook when interactive `agy` runs (Google
 *   Antigravity personal sign-in). Never wraps headless `agy -p`.
 * - `response-headers`: the HTTP endpoint attaches quota headers to the
 *   responses Octant already requests.
 * - `runtime-does-not-report`: the protocol has no limits channel; the
 *   limits belong to the account behind the runtime.
 * - `local-runtime`: the model runs on this computer and has no account.
 */
export type ProviderLimitsReporting =
  | "usage-windows"
  | "account-endpoint"
  | "status-line"
  | "response-headers"
  | "runtime-does-not-report"
  | "local-runtime";

export function providerLimitsReporting(kind: ProviderDriverKind): ProviderLimitsReporting {
  // The ACP protocol has no limits channel. Devin and Mistral Vibe differ
  // because Octant reads their plan windows from an account endpoint. Google
  // Antigravity's own `/usage` headless mode (`agy -p`) is not supported for
  // wrapping inside third-party apps on consumer plans, so Octant never runs
  // `agy -p`; instead it can passively read the CLI's documented `statusLine`
  // hook when the person opts in and runs interactive `agy`.
  if (isAcpAgentKind(kind)) {
    if (kind === "devin" || kind === "mistral-vibe") return "account-endpoint";
    if (kind === "antigravity") return "status-line";
    return "runtime-does-not-report";
  }
  switch (kind) {
    case "claude":
    case "codex":
      return "usage-windows";
    case "opencode":
      return "account-endpoint";
    case "openai-compatible":
    case "anthropic-compatible":
    case "azure-foundry":
      return "response-headers";
    case "ollama":
      return "local-runtime";
    case "pi":
    case "oh-my-pi":
    case "openai-image":
    case "gemini-native-image":
    case "bfl-image":
    case "ideogram-image":
    case "gemini-video":
    case "runway-video":
    case "fal-video":
    // Bedrock's Converse answers carry no quota headers.
    case "amazon-bedrock":
    // Octant reads no quota headers on an outside driver's brokered calls.
    case "outside-harness-endpoint":
    case "outside-image":
    case "outside-video":
    // ACP has no limits channel, and an added agent has no account endpoint.
    case "acp-agent":
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
    case "account-endpoint":
    case "status-line":
      return "not-ready";
    case "response-headers":
      return lastCompletedTurn === "silent" ? "endpoint-silent" : "unsupported";
    case "runtime-does-not-report":
      return "runtime-does-not-report";
    case "local-runtime":
      return "local-runtime";
  }
}
