import type { ProviderDriverKind } from "@octant/contracts";
import { isAcpAgentKind } from "@octant/contracts/acp-agent-profiles";
import type { StrictKeptProtection, StrictKeptProtections } from "@octant/contracts/strict-notice";

/**
 * What Strict kept for one provider launch, from the decisions the host made
 * for it: whether the launch was Strict, which runtime family it started, and
 * whether it ran inside Octant's sandbox. Undefined when the launch was not
 * Strict, so a thread shows a notice only where Strict actually withheld
 * something.
 *
 * The per-family lists follow what Strict changes for each runtime (Decisions
 * and requirements, "Octant adds no restrictions of its own unless Strict is
 * on"): the fixed environment for Claude Code, Codex, Pi and the ACP agents;
 * the provider channels for Claude Code, Pi and the ACP agents; provider
 * Project trust for Claude Code and Codex; the protected files and the
 * outside-content withdrawal for every runtime; and the forge asks for every
 * runtime that runs its own shell.
 */
export function strictKeptAtLaunch(input: {
  readonly strict: boolean;
  readonly driverKind: ProviderDriverKind;
  readonly sandboxed: boolean;
}): StrictKeptProtections | undefined {
  if (!input.strict) return undefined;
  const kind = input.driverKind;
  const acp = isAcpAgentKind(kind);
  const ownShell = kind === "claude" || kind === "codex" || kind === "opencode" || kind === "pi";
  const kept: Array<StrictKeptProtection> = [];
  if (input.sandboxed) kept.push("octant-sandbox");
  kept.push("protected-files");
  if (kind === "claude" || kind === "codex" || kind === "pi" || acp) kept.push("fixed-environment");
  if (kind === "claude" || kind === "pi" || acp) kept.push("provider-channels-off");
  if (kind === "claude" || kind === "codex") kept.push("octant-project-trust");
  kept.push("outside-content-withdrawal");
  if (ownShell || acp) kept.push("forge-asks");
  return kept;
}

/** The words a thread uses for each kept protection, in the notice's order. */
export const STRICT_KEPT_LABELS: Readonly<Record<StrictKeptProtection, string>> = {
  "octant-sandbox": "Octant's sandbox",
  "protected-files": "protected files",
  "fixed-environment": "a fixed environment",
  "provider-channels-off": "provider telemetry and feedback off",
  "octant-project-trust": "Octant's own Project trust",
  "outside-content-withdrawal": "no web search or reviewer after outside content",
  "forge-asks": "asks before pushes and merges",
};

/** The notice's sentence: "Strict kept: Octant's sandbox, protected files, …". */
export function strictKeptSentence(kept: StrictKeptProtections): string {
  return `Strict kept: ${kept.map((protection) => STRICT_KEPT_LABELS[protection]).join(", ")}.`;
}

/**
 * Whether a turn shows the notice, given the turn before it: a Strict launch
 * after a thread's start, after a launch that was not Strict, or one whose
 * kept protections differ from the previous turn's. Each launch records its
 * own, so a thread says it once per change rather than on every turn.
 */
export function showsStrictNotice(
  kept: StrictKeptProtections | undefined,
  previous: StrictKeptProtections | undefined,
): boolean {
  if (kept === undefined) return false;
  if (previous === undefined) return true;
  return kept.length !== previous.length || kept.some((entry, index) => entry !== previous[index]);
}
