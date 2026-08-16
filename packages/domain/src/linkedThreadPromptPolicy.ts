import {
  LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS,
  MAX_LINKED_THREAD_TARGETS,
  type AggregateVersion,
  type AgentRunAuthority,
  type EventActor,
  type LinkedThreadContextSnapshotId,
  type LinkedThreadLimitSnapshot,
  type LinkedThreadPreview,
  type LinkedThreadPreviewId,
  type LinkedThreadPromptPreviewCommand,
  type LinkedThreadRoutingReceipt,
  type ProviderInstanceId,
  type ProviderModelId,
  type UtcTimestamp,
} from "@octant/contracts";
import { assertLinkedThreadLimits, clampLinkedThreadAuthority } from "./linkedThreadPolicy";

const providerId = (value: string) => value as unknown as ProviderInstanceId;
const modelId = (value: string) => value as unknown as ProviderModelId;
const snapshotId = (value: string) => value as unknown as LinkedThreadContextSnapshotId;

const EXECUTION_RANK: Record<AgentRunAuthority["executionPolicy"], number> = {
  plan: 0,
  "approval-gated": 1,
  "auto-accept-edits": 2,
  "full-access": 3,
};

const CAPABILITY_KEYS = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;

export type LinkedThreadPromptParseResult =
  | {
      readonly kind: "spawn-linked-threads";
      readonly requestedCount: number;
      readonly rawRequestedCount: number;
      readonly countClamped: boolean;
      readonly prompt: string;
      readonly matchedDirective: string;
    }
  | { readonly kind: "unsupported" };

const PROMPT_DIRECTIVES: ReadonlyArray<{ readonly pattern: RegExp }> = [
  { pattern: /^\s*\/(?:review|parallel|spawn)\s+(\d+)\s*(?:parallel\s+)?threads?/i },
  {
    pattern:
      /\b(?:spawn|create|start|launch|open|run)\s+(\d+)\s+(?:parallel\s+|review\s+)?threads?\b/i,
  },
  {
    pattern: /\b(\d+)\s+(?:parallel\s+)?(?:review|continuation|follow-up|spawned)\s+threads?\b/i,
  },
  { pattern: /\b(\d+)\s+parallel\s+threads?\b/i },
  { pattern: /[[【(]\s*(?:parallel|spawn|review)\s*[-:]?\s*(\d+)\s*[\]】)]/i },
];

/**
 * Pure prompt parser for the prompt-driven multi-thread surface. Recognizes an
 * explicit fan-out directive (`/review 3 threads`, `spawn 2 parallel threads`,
 * `3 review threads`, `[parallel: 4]`) and returns a bounded intent with the
 * directive stripped from the per-thread instruction and kept visible in
 * `matchedDirective`. A request exceeding `maxTargets` is clamped and flagged;
 * an ordinary prompt returns `unsupported` and never reaches creation.
 */
export function parseLinkedThreadPrompt(input: {
  readonly prompt: string;
  readonly maxTargets?: number;
}): LinkedThreadPromptParseResult {
  const maxTargets = input.maxTargets ?? MAX_LINKED_THREAD_TARGETS;
  for (const directive of PROMPT_DIRECTIVES) {
    const match = input.prompt.match(directive.pattern);
    if (match === null) continue;
    const rawCount = Number(match[1]);
    if (!Number.isSafeInteger(rawCount) || rawCount < 1) continue;
    const matchedDirective = match[0].trim();
    const requestedCount = Math.min(rawCount, maxTargets);
    const stripped = input.prompt.replace(match[0], " ").replace(/\s+/g, " ").trim();
    const prompt = stripped.length > 0 ? stripped : matchedDirective;
    return {
      kind: "spawn-linked-threads",
      requestedCount,
      rawRequestedCount: rawCount,
      countClamped: rawCount > maxTargets,
      prompt,
      matchedDirective,
    };
  }
  return { kind: "unsupported" };
}

/**
 * A resolved route candidate with the authority facts needed to gate fallback
 * selection. `capabilities` mirrors the effective permission clamp so the pure
 * policy can reject a fallback that would silently widen authority or cost.
 */
export interface LinkedThreadRouteCandidate {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly executionPolicy: AgentRunAuthority["executionPolicy"];
  readonly permissionPersistence: AgentRunAuthority["permissionPersistence"];
  readonly capabilities: {
    readonly filesystem: boolean;
    readonly shell: boolean;
    readonly git: boolean;
    readonly network: boolean;
    readonly tools: boolean;
    readonly subagents: boolean;
  };
}

function isRoutePrivilegeCompatible(
  route: LinkedThreadRouteCandidate,
  authority: AgentRunAuthority,
): boolean {
  if (EXECUTION_RANK[route.executionPolicy] > EXECUTION_RANK[authority.executionPolicy]) {
    return false;
  }
  if (
    route.permissionPersistence === "project-default" &&
    authority.permissionPersistence !== "project-default"
  ) {
    return false;
  }
  for (const key of CAPABILITY_KEYS) {
    if (route.capabilities[key] && !authority[key]) return false;
  }
  return true;
}

export type LinkedThreadRouteSelection =
  | {
      readonly kind: "selected";
      readonly providerInstanceId: string;
      readonly modelId: string;
      readonly selectedFallback?: {
        readonly providerInstanceId: string;
        readonly modelId: string;
        readonly reason: string;
      };
      readonly rejectedCandidates: ReadonlyArray<{
        readonly providerInstanceId: string;
        readonly modelId: string;
        readonly rejectedReason: string;
      }>;
      readonly capabilityDegradations: ReadonlyArray<string>;
    }
  | { readonly kind: "denied"; readonly reason: string };

/**
 * Capability-checked route selection for a preview. When the requested (or
 * default) route is available within the requested authority clamp it is
 * selected with no fallback. When it is unavailable, only a fallback candidate
 * whose execution policy, permission persistence, and capabilities stay within
 * the requested clamp may be selected, visibly. A route that would require
 * more authority or higher cost is never selected silently; the selection is
 * denied.
 */
export function selectLinkedThreadRoute(input: {
  readonly requestedAuthority: AgentRunAuthority;
  readonly requestedModelId?: string;
  readonly requestedProviderInstanceId?: string;
  readonly primary: LinkedThreadRouteCandidate;
  readonly fallbackChain: ReadonlyArray<LinkedThreadRouteCandidate>;
}): LinkedThreadRouteSelection {
  const candidates = [input.primary, ...input.fallbackChain];
  const requestModel = input.requestedModelId;
  const requestProvider = input.requestedProviderInstanceId;

  const requestedMatch =
    requestModel === undefined
      ? undefined
      : candidates.find(
          (candidate) =>
            (requestProvider === undefined || candidate.providerInstanceId === requestProvider) &&
            candidate.modelId === requestModel,
        );

  if (requestModel !== undefined && requestedMatch !== undefined) {
    if (!isRoutePrivilegeCompatible(requestedMatch, input.requestedAuthority)) {
      return {
        kind: "denied",
        reason: `Requested route ${requestModel} requires authority beyond the requested clamp; it is not selected silently.`,
      };
    }
    return selectedFrom(requestedMatch, candidates, input.requestedAuthority, requestModel, false);
  }

  if (requestModel !== undefined && requestedMatch === undefined) {
    const fallback = input.fallbackChain.find((candidate) =>
      isRoutePrivilegeCompatible(candidate, input.requestedAuthority),
    );
    if (fallback === undefined) {
      return {
        kind: "denied",
        reason: `Requested model ${requestModel} is unavailable and no capability-checked fallback within the requested authority clamp is offered.`,
      };
    }
    return selectedFrom(fallback, candidates, input.requestedAuthority, requestModel, true);
  }

  if (isRoutePrivilegeCompatible(input.primary, input.requestedAuthority)) {
    return selectedFrom(input.primary, candidates, input.requestedAuthority, undefined, false);
  }

  const fallback = input.fallbackChain.find((candidate) =>
    isRoutePrivilegeCompatible(candidate, input.requestedAuthority),
  );
  if (fallback === undefined) {
    return {
      kind: "denied",
      reason:
        "Primary route is unavailable and no capability-checked fallback remains within the requested authority clamp.",
    };
  }
  return selectedFrom(fallback, candidates, input.requestedAuthority, undefined, true);
}

function selectedFrom(
  selected: LinkedThreadRouteCandidate,
  candidates: ReadonlyArray<LinkedThreadRouteCandidate>,
  authority: AgentRunAuthority,
  requestedModelId: string | undefined,
  fromFallback: boolean,
): LinkedThreadRouteSelection {
  const capabilityDegradations: string[] = [];
  if (fromFallback) {
    capabilityDegradations.push(
      `Selected capability-checked fallback ${selected.modelId}; primary route was unavailable.`,
    );
  }
  const rejectedCandidates = candidates
    .filter((candidate) => candidate !== selected)
    .map((candidate) => {
      if (!isRoutePrivilegeCompatible(candidate, authority)) {
        return {
          providerInstanceId: candidate.providerInstanceId,
          modelId: candidate.modelId,
          rejectedReason: "Rejected because it would widen authority or persistence.",
        };
      }
      return {
        providerInstanceId: candidate.providerInstanceId,
        modelId: candidate.modelId,
        rejectedReason:
          requestedModelId !== undefined && candidate.modelId !== requestedModelId
            ? "Not the requested route."
            : "Not selected by the capability-checked chain.",
      };
    });
  const base: Extract<LinkedThreadRouteSelection, { kind: "selected" }> = {
    kind: "selected",
    providerInstanceId: selected.providerInstanceId,
    modelId: selected.modelId,
    rejectedCandidates: rejectedCandidates.slice(0, 8),
    capabilityDegradations,
  };
  if (selected.providerInstanceId !== candidates[0]?.providerInstanceId || fromFallback) {
    return {
      ...base,
      selectedFallback: {
        providerInstanceId: selected.providerInstanceId,
        modelId: selected.modelId,
        reason: `Requested route was unavailable; capability-checked fallback ${selected.modelId} selected.`,
      },
    };
  }
  return base;
}

export type LinkedThreadPreviewBuildResult =
  | { readonly kind: "ready"; readonly preview: LinkedThreadPreview }
  | {
      readonly kind: "limited";
      readonly preview: LinkedThreadPreview;
      readonly notice: string;
    }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Assemble a structured multi-thread preview from a parsed prompt, a
 * capability-checked route selection, an authority clamp, and admission
 * limits. The preview is inert (`proposed`), records the explicit
 * no-implicit-transfer policy, and never contains thread ids or a creation
 * receipt. A fallback or count clamp produces a `limited` outcome with a
 * visible notice; a widening authority clamp or an unadmittable limit produces
 * `denied` with no side effect.
 */
export function buildLinkedThreadPreview(input: {
  readonly command: LinkedThreadPromptPreviewCommand;
  readonly selection: LinkedThreadRouteSelection;
  readonly routingReceipt: LinkedThreadRoutingReceipt;
  readonly limits: LinkedThreadLimitSnapshot;
  readonly authorityCeiling: AgentRunAuthority;
  readonly proposedBy: EventActor;
  readonly previewId: LinkedThreadPreviewId;
  readonly now: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly maxTargets?: number;
}): LinkedThreadPreviewBuildResult {
  if (input.selection.kind === "denied") {
    return { kind: "denied", reason: input.selection.reason };
  }
  const selection = input.selection satisfies Extract<
    LinkedThreadRouteSelection,
    { readonly kind: "selected" }
  >;
  const parsed = parseLinkedThreadPrompt({
    prompt: input.command.prompt,
    maxTargets: input.maxTargets ?? MAX_LINKED_THREAD_TARGETS,
  });
  if (parsed.kind === "unsupported") {
    return {
      kind: "unsupported",
      reason: "The prompt does not request one or more linked threads.",
    };
  }

  let effectiveAuthority: AgentRunAuthority;
  try {
    effectiveAuthority = clampLinkedThreadAuthority({
      requestedAuthority: input.command.requestedAuthority,
      targetCeiling: input.authorityCeiling,
      targetScope: input.command.targetScope,
    });
  } catch {
    return {
      kind: "denied",
      reason: "Requested authority exceeds the linked-thread ceiling and cannot be clamped.",
    };
  }

  let admittedLimits: LinkedThreadLimitSnapshot;
  try {
    admittedLimits = assertLinkedThreadLimits({
      ...input.limits,
      requestedCount: parsed.requestedCount,
      nestingDepth: input.command.nestingDepth,
    });
  } catch (error) {
    return {
      kind: "denied",
      reason:
        error instanceof Error
          ? error.message
          : "Linked-thread admission limits cannot admit this request.",
    };
  }
  if (
    admittedLimits.providerCapacity.status !== "available" ||
    admittedLimits.providerCapacity.providerInstanceId !== input.selection.providerInstanceId
  ) {
    return {
      kind: "denied",
      reason: "Provider capacity cannot admit the selected linked-thread route.",
    };
  }

  const routingReceipt = withSelectedRoute(
    input.routingReceipt,
    selection,
    input.command.contextSnapshotId,
  );
  const degradations = [...selection.capabilityDegradations];
  if (parsed.countClamped) {
    degradations.push(
      `Requested ${parsed.rawRequestedCount} parallel threads; linked-thread limit caps this preview at ${parsed.requestedCount}.`,
    );
  }
  if (!sameAuthority(effectiveAuthority, input.command.requestedAuthority)) {
    degradations.push("Requested authority was clamped to the linked-thread ceiling.");
  }

  const threads = Array.from({ length: parsed.requestedCount }, (_, index) => ({
    targetIndex: index + 1,
    label: `Reviewer ${index + 1}`,
    prompt: parsed.prompt,
    providerInstanceId: providerId(selection.providerInstanceId),
    modelId: modelId(selection.modelId),
    effectiveAuthority,
    fallbackCandidates: selection.rejectedCandidates.map((candidate) => ({
      providerInstanceId: providerId(candidate.providerInstanceId),
      modelId: modelId(candidate.modelId),
      rejectedReason: candidate.rejectedReason,
    })),
    capabilityDegradations: degradations,
    ...(selection.selectedFallback === undefined
      ? {}
      : {
          selectedFallback: {
            providerInstanceId: providerId(selection.selectedFallback.providerInstanceId),
            modelId: modelId(selection.selectedFallback.modelId),
            reason: selection.selectedFallback.reason,
          },
        }),
  }));

  const preview: LinkedThreadPreview = {
    previewId: input.previewId,
    requestId: input.command.requestId,
    requestFingerprint: input.command.requestFingerprint,
    prompt: parsed.prompt,
    matchedDirective: parsed.matchedDirective,
    sourceThreadId: input.command.sourceThreadId,
    sourceScope: input.command.sourceScope,
    sourceVersion: input.command.sourceVersion,
    contextSnapshotId: snapshotId(input.command.contextSnapshotId),
    targetScope: input.command.targetScope,
    requestedCount: parsed.requestedCount,
    threads,
    requestedAuthority: input.command.requestedAuthority,
    effectiveAuthority,
    routingReceipt,
    transferPolicy: LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS,
    status: "proposed",
    nestingDepth: input.command.nestingDepth,
    proposedBy: input.proposedBy,
    proposedAt: input.now,
    expiresAt: input.expiresAt,
    version: 1 as AggregateVersion,
  };

  if (selection.selectedFallback !== undefined || parsed.countClamped) {
    return {
      kind: "limited",
      preview,
      notice:
        "A capability-checked fallback or limit clamp applies to this preview; review it before confirming.",
    };
  }
  return { kind: "ready", preview };
}

function withSelectedRoute(
  receipt: LinkedThreadRoutingReceipt,
  selection: Extract<LinkedThreadRouteSelection, { kind: "selected" }>,
  contextSnapshotId: string,
): LinkedThreadRoutingReceipt {
  return {
    ...receipt,
    selectedProviderInstanceId: providerId(selection.providerInstanceId),
    selectedModelId: modelId(selection.modelId),
    executionResolution: {
      ...receipt.executionResolution,
      providerInstanceId: providerId(selection.providerInstanceId),
      modelId: modelId(selection.modelId),
    },
    fallbackCandidates: selection.rejectedCandidates.map((candidate) => ({
      providerInstanceId: providerId(candidate.providerInstanceId),
      modelId: modelId(candidate.modelId),
      rejectedReason: candidate.rejectedReason,
    })),
    capabilityDegradations: [...selection.capabilityDegradations],
    contextSnapshotId: snapshotId(contextSnapshotId),
    ...(selection.selectedFallback === undefined
      ? {}
      : {
          selectedFallback: {
            providerInstanceId: providerId(selection.selectedFallback.providerInstanceId),
            modelId: modelId(selection.selectedFallback.modelId),
            reason: selection.selectedFallback.reason,
          },
        }),
  };
}

function sameAuthority(left: AgentRunAuthority, right: AgentRunAuthority): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type LinkedThreadPreviewTransition = "confirm" | "deny" | "expire";

/**
 * Pure transition gate for a prompt preview. Only an undecided `proposed`
 * preview with a matching optimistic version may be confirmed or denied before
 * its deadline; an undecided preview that has passed its deadline may only
 * expire. Decided previews are terminal and never revert to `proposed`.
 */
export function classifyLinkedThreadPreviewTransition(input: {
  readonly currentStatus: LinkedThreadPreview["status"];
  readonly transition: LinkedThreadPreviewTransition;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly now: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}): "allow" | "deny" {
  if (input.currentStatus !== "proposed") return "deny";
  if (input.expectedVersion !== input.currentVersion) return "deny";
  if (input.now >= input.expiresAt) {
    return input.transition === "expire" ? "allow" : "deny";
  }
  if (input.transition === "expire") return "deny";
  return "allow";
}
