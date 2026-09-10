import type {
  DiscoveryCandidate,
  DiscoveryCommand,
  DiscoverySnapshot,
  FirstRunOnboardingStatus,
  ProviderDriverKind,
} from "@octant/contracts";
import { isImageProfileDriverKind } from "./providerPolicy";

export type DiscoveryPolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string };

/**
 * Connect is allowed only when the candidate appears in the latest snapshot
 * with the same driver/binary path. Configured-instance filtering is owned by
 * the UI/server inventory layer, not this pure policy helper.
 */
export function canConnectCandidate(
  candidate: DiscoveryCandidate,
  snapshot: DiscoverySnapshot,
): DiscoveryPolicyDecision {
  const found = snapshot.candidates.find(
    (entry) =>
      entry.driverKind === candidate.driverKind && entry.binaryPath === candidate.binaryPath,
  );
  if (found === undefined) {
    return { kind: "denied", reason: "Candidate not found in discovery snapshot." };
  }
  return { kind: "allowed" };
}

export function isDuplicateInstallation(
  candidate: DiscoveryCandidate,
  existing: ReadonlyArray<DiscoveryCandidate>,
): boolean {
  return existing.some(
    (other) =>
      other.driverKind === candidate.driverKind && other.binaryPath === candidate.binaryPath,
  );
}

export function groupByDriverKind(
  candidates: ReadonlyArray<DiscoveryCandidate>,
): ReadonlyMap<string, ReadonlyArray<DiscoveryCandidate>> {
  const groups = new Map<string, DiscoveryCandidate[]>();
  for (const candidate of candidates) {
    const list = groups.get(candidate.driverKind) ?? [];
    list.push(candidate);
    groups.set(candidate.driverKind, list);
  }
  return groups;
}

export function isScanStale(snapshot: DiscoverySnapshot, maxAgeMs: number, now: number): boolean {
  const scannedAt = new Date(snapshot.scannedAt).getTime();
  return now - scannedAt > maxAgeMs;
}

/** CLI drivers that can be auto-detected by scanning PATH and platform locations. */
const AUTO_DETECTABLE_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  "codex",
  "claude",
  "opencode",
  "kilo",
  "pi",
  "oh-my-pi",
  "devin",
  "mistral-vibe",
  "ollama",
  "kimi-code",
  "grok",
  "goose",
  "glm",
  "gemini",
  "copilot",
  "cline",
  "qwen",
]);

const MANUAL_ENDPOINT_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  "openai-compatible",
  "anthropic-compatible",
  "azure-foundry",
]);

export function canAutoDetectDriverKind(driverKind: ProviderDriverKind): boolean {
  return AUTO_DETECTABLE_DRIVERS.has(driverKind);
}

export function requiresManualEndpoint(driverKind: ProviderDriverKind): boolean {
  return MANUAL_ENDPOINT_DRIVERS.has(driverKind);
}

export function isUnclassifiedDriverKind(driverKind: ProviderDriverKind): boolean {
  return (
    !canAutoDetectDriverKind(driverKind) &&
    !requiresManualEndpoint(driverKind) &&
    !isImageProfileDriverKind(driverKind)
  );
}

export function isConnectCommand(
  command: DiscoveryCommand,
): command is Extract<DiscoveryCommand, { kind: "connect" }> {
  return command.kind === "connect";
}

export function selectPreferredCandidate(
  candidates: ReadonlyArray<DiscoveryCandidate>,
): DiscoveryCandidate | undefined {
  return candidates[0];
}

/**
 * Driver kinds first run may create enabled when a scan is eligible.
 * Every other auto-detected runtime stays disabled until the user switches it
 * on. This list is the product default, not a readiness ranking.
 */
const FIRST_RUN_ENABLED_DRIVER_KINDS: ReadonlySet<ProviderDriverKind> = new Set([
  "claude",
  "codex",
]);

/**
 * Whether this scan may create Claude Code or Codex CLI enabled.
 *
 * Eligibility is a one-shot host fact: first-run onboarding still pending,
 * and no provider instance of any driver has been recorded yet. An empty
 * registry after completed or skipped onboarding must not reopen this
 * policy, and a pending host that already recorded a provider choice must
 * not enable a later detection. Callers decide this once per scan so both
 * supported defaults can enable together.
 */
export function isFirstRunDiscoveryEnablementEligible(input: {
  readonly firstRunOnboarding: FirstRunOnboardingStatus;
  readonly existingInstanceCount: number;
}): boolean {
  return input.firstRunOnboarding === "pending" && input.existingInstanceCount === 0;
}

/**
 * Initial enabled state for an auto-registered discovery candidate.
 *
 * Enabled is independent of candidate readiness: detection does not assert
 * authentication, reachability, or compatibility.
 */
export function initialEnabledForDiscovery(input: {
  readonly driverKind: ProviderDriverKind;
  readonly firstRunEnablementEligible: boolean;
}): boolean {
  return input.firstRunEnablementEligible && FIRST_RUN_ENABLED_DRIVER_KINDS.has(input.driverKind);
}

export function shouldAutoRegisterCandidate(input: {
  candidate: DiscoveryCandidate;
  existingInstances: ReadonlyArray<{ driverKind: ProviderDriverKind; binaryPath: string }>;
}): DiscoveryPolicyDecision {
  const { candidate, existingInstances } = input;

  if (!canAutoDetectDriverKind(candidate.driverKind)) {
    return {
      kind: "denied",
      reason: "Driver kind cannot be auto-detected from discovery scan.",
    };
  }

  if (existingInstances.some((instance) => instance.driverKind === candidate.driverKind)) {
    return {
      kind: "denied",
      reason: "An instance already exists for this driver family.",
    };
  }

  return { kind: "allowed" };
}
