import { randomUUID } from "node:crypto";
import {
  decodeCodeThreadId,
  decodeSpendCeilingReservationId,
  type CodeThread,
  type ProviderCapabilities,
  type ProviderDriverKind,
  type ProviderExecutionPolicy,
  type ProviderInstanceId,
  type ProviderModelId,
  type ShieldDecision,
  type ShieldModelChoice,
} from "@octant/contracts";
import { isAcpAgentKind } from "@octant/contracts";
import { isNativeHarnessDriverKind } from "@octant/domain";
import { shieldReviewsPrompts } from "@octant/domain/guardrail-policy";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { SpendCeilingService } from "../spendCeilingService";
import { OctantShield, type ShieldModelPort, type ShieldReviewPort } from "./octantShield";
import { createShieldModelPort, projectCommandsIn, resolveShieldModel } from "./shieldModel";

/** How many of the person's own messages the Judge reads. */
const SHIELD_PERSON_MESSAGE_COUNT = 12;
/** What one Shield call may spend, reserved against the ceilings before it runs. */
const SHIELD_CALL_TOKEN_BOUND = 4_096;

export interface HostShieldDependencies {
  readonly readCodeThread: (threadId: CodeThread["id"]) => CodeThread | undefined;
  /** The posture the thread's running turn may use, when one runs. */
  readonly readTurnExecutionPolicy?: (threadId: string) => ProviderExecutionPolicy | undefined;
  readonly providerCapabilities: (
    providerInstanceId: ProviderInstanceId,
  ) => Pick<ProviderCapabilities, "harnessAutoReview"> | undefined;
  /**
   * Whether this provider instance's runtime sends its approval prompts to
   * Octant, so Shield can answer them. A runtime that decides inside itself
   * without asking cannot be reviewed.
   */
  readonly routesApprovals: (providerInstanceId: ProviderInstanceId) => boolean;
  readonly catalog: (
    providerInstanceId: ProviderInstanceId,
  ) => ReadonlyArray<{ readonly id: ProviderModelId; readonly displayName: string }> | undefined;
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  readonly tainted: (threadId: string) => boolean;
  /** The thread's own turn prompts, oldest first: what the person wrote. */
  readonly personMessages: (threadId: CodeThread["id"], limit: number) => ReadonlyArray<string>;
  /** The person's chosen Shield model, when they picked one. */
  readonly chosenModel?: () => ShieldModelChoice | undefined;
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
  /** A folder outside every Project, where Shield's one-shot sessions start. */
  readonly scratchRoot: string;
  readonly clock?: () => string;
}

export interface HostShield extends ShieldReviewPort {
  readonly shield: OctantShield;
  /** Whether Shield can run for a thread on this provider instance at all. */
  readonly availableFor: (providerInstanceId: ProviderInstanceId) => boolean;
  /** Where decisions show on a thread's transcript; set once the Code runtime exists. */
  readonly showDecisionsWith: (
    record: (input: {
      readonly threadId: string;
      readonly summary: string;
      readonly decision: ShieldDecision;
    }) => void,
  ) => void;
}

/**
 * Octant Shield as this host wires it, for Code threads. It is the thread's
 * reviewer at Auto on a prompting posture when the person chose it, or when
 * the thread's provider has no reviewer of its own; the provider's own
 * reviewer keeps answering where it exists and was not overruled.
 */
export function createHostShield(deps: HostShieldDependencies): HostShield {
  let showDecision:
    | ((input: {
        readonly threadId: string;
        readonly summary: string;
        readonly decision: ShieldDecision;
      }) => void)
    | undefined;
  const readThread = (threadId: string): CodeThread | undefined => {
    try {
      return deps.readCodeThread(decodeCodeThreadId(threadId));
    } catch {
      return undefined;
    }
  };
  const modelFor = (thread: CodeThread): ShieldModelPort | undefined => {
    const model = resolveShieldModel({
      chosen: deps.chosenModel?.(),
      thread: { providerInstanceId: thread.providerInstanceId, modelId: thread.modelId },
      catalog: deps.catalog,
    });
    const driver = deps.resolveDriver(model.providerInstanceId);
    return driver === undefined
      ? undefined
      : createShieldModelPort({ model, driver, scratchRoot: deps.scratchRoot, uuid: randomUUID });
  };
  const availableFor = (providerInstanceId: ProviderInstanceId): boolean => {
    if (!deps.routesApprovals(providerInstanceId)) return false;
    const chosen = deps.chosenModel?.();
    return deps.resolveDriver(chosen?.providerInstanceId ?? providerInstanceId) !== undefined;
  };
  const shield = new OctantShield({
    facts: {
      reviewing: (threadId) => {
        const thread = readThread(threadId);
        if (thread === undefined || thread.lifecycle !== "active") return undefined;
        const executionPolicy = deps.readTurnExecutionPolicy?.(threadId) ?? thread.executionPolicy;
        const reviews = shieldReviewsPrompts({
          access: { executionPolicy, autoApprove: thread.autoApprove },
          capabilities: {
            providerReview:
              deps.providerCapabilities(thread.providerInstanceId)?.harnessAutoReview ===
              "supported",
            providerSandbox: false,
            shield: availableFor(thread.providerInstanceId)
              ? { available: true }
              : { available: false, reason: "No Shield model is reachable." },
          },
        });
        if (!reviews) return undefined;
        return {
          projectId: String(thread.projectId),
          level: "provider-review",
          model: modelFor(thread),
        };
      },
      tainted: deps.tainted,
      personMessages: (threadId) => {
        const thread = readThread(threadId);
        return thread === undefined
          ? []
          : deps.personMessages(thread.id, SHIELD_PERSON_MESSAGE_COUNT);
      },
      projectCommands: projectCommandsIn,
    },
    ...(deps.spendCeiling === undefined ? {} : { spend: shieldSpend(deps.spendCeiling) }),
    clock: deps.clock ?? (() => new Date().toISOString()),
  });
  return {
    shield,
    availableFor,
    review: (request) => shield.review(request),
    recordOnTranscript: (input) => {
      try {
        showDecision?.(input);
      } catch {
        // A transcript that cannot show the decision does not change it; the
        // approval journal still holds it.
      }
    },
    showDecisionsWith: (record) => {
      showDecision = record;
    },
  };
}

function shieldSpend(
  spendCeiling: Pick<SpendCeilingService, "admit" | "settle" | "abandon">,
): NonNullable<ConstructorParameters<typeof OctantShield>[0]["spend"]> {
  return {
    admit: ({ threadId, projectId }) => {
      const reservationId = decodeSpendCeilingReservationId(randomUUID());
      const admission = spendCeiling.admit({
        reservationId,
        threadId,
        threadType: "code-thread",
        ...(projectId === undefined ? {} : { projectId }),
        turnUpperBoundTokens: SHIELD_CALL_TOKEN_BOUND,
        // A review is spend, not a turn of the thread's own.
        countsAsTurn: false,
      });
      if (admission.status === "refused") {
        return { status: "refused", reason: admission.refusal.message };
      }
      return { status: "admitted", settle: () => spendCeiling.settle({ reservationId }) };
    },
  };
}

/**
 * Runtimes whose approval prompts reach Octant before the call runs, so
 * Shield can answer them: the Octant Harness, whose tool calls pass Octant's
 * approval path, Claude Code (`canUseTool`), Codex (app-server approval
 * requests), OpenCode (`permission.asked`), every ACP agent
 * (`session/request_permission`), and Pi (its extension's confirmation).
 */
export function shieldRoutesApprovals(driverKind: ProviderDriverKind): boolean {
  if (isNativeHarnessDriverKind(driverKind)) return true;
  if (isAcpAgentKind(driverKind)) return true;
  return (
    driverKind === "claude" ||
    driverKind === "codex" ||
    driverKind === "opencode" ||
    driverKind === "pi"
  );
}
