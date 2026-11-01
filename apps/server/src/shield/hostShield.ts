import { randomUUID } from "node:crypto";
import {
  decodeCodeThreadId,
  decodeSpendCeilingReservationId,
  type AutoReviewer,
  decodeWorkThreadId,
  type CodeThread,
  type WorkAccess,
  type WorkThread,
  type ProviderCapabilities,
  type ProviderExecutionPolicy,
  type ProviderInstanceId,
  type ProviderModelId,
  type ShieldDecision,
  type ShieldModelChoice,
  type ShieldWatcherLabel,
  type TurnUsage,
} from "@octant/contracts";
import { shieldReviewsPrompts, workThreadAccessOf } from "@octant/domain/guardrail-policy";
import type { ShieldServerRule } from "@octant/domain/shield-server-policy";
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
  /**
   * A Work thread, which Shield reviews at Auto as it reviews a Code thread:
   * Work and Code share one capability set at the thread's level. Absent,
   * Shield reviews Code threads only.
   */
  readonly readWorkThread?: (threadId: WorkThread["id"]) => WorkThread | undefined;
  /** The level a Work thread's running turn runs at, when one runs. */
  readonly readWorkTurnAccess?: (threadId: string) => WorkAccess | undefined;
  /** A Work thread's own turn prompts, oldest first: what the person wrote. */
  readonly workPersonMessages?: (
    threadId: WorkThread["id"],
    limit: number,
  ) => ReadonlyArray<string>;
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
  /** What the Watcher found in what the thread read: kinds only, never text. */
  readonly watcherLabels: (threadId: string) => ReadonlyArray<ShieldWatcherLabel>;
  /** The thread's own turn prompts, oldest first: what the person wrote. */
  readonly personMessages: (threadId: CodeThread["id"], limit: number) => ReadonlyArray<string>;
  /** The person's chosen Shield model, when they picked one. */
  readonly chosenModel?: () => ShieldModelChoice | undefined;
  /** The person's Auto reviewer for a thread: its Project's, else Settings'. */
  readonly chosenReviewer?: (thread: CodeThread | WorkThread) => AutoReviewer | undefined;
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
  /**
   * Records what one review's model call used under the reviewed thread, so
   * the usage ledger and the spend ceilings count it.
   */
  readonly recordUsage?: (input: {
    readonly threadId: string;
    readonly model: ShieldModelChoice;
    readonly usage: TurnUsage | undefined;
  }) => void;
  /** The servers the person registered, judged by their profiles. */
  /** The servers a thread reaches: its Project's own list, else the account list. */
  readonly servers?: (threadId: string) => ReadonlyArray<ShieldServerRule>;
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
 * Octant Shield as this host wires it, for Work and Code threads. It is the thread's
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
  const readWorkThread = (threadId: string): WorkThread | undefined => {
    if (deps.readWorkThread === undefined) return undefined;
    try {
      return deps.readWorkThread(decodeWorkThreadId(threadId));
    } catch {
      return undefined;
    }
  };
  /**
   * The thread Shield would review, Work or Code, with the posture its
   * running turn may use (or its stored one between turns).
   */
  const subjectOf = (threadId: string) => {
    const code = readThread(threadId);
    if (code !== undefined) {
      return {
        kind: "code-thread" as const,
        thread: code,
        access: {
          executionPolicy: deps.readTurnExecutionPolicy?.(threadId) ?? code.executionPolicy,
          autoApprove: code.autoApprove,
        },
      };
    }
    const work = readWorkThread(threadId);
    if (work === undefined) return undefined;
    return {
      kind: "work-thread" as const,
      thread: work,
      access: workThreadAccessOf(deps.readWorkTurnAccess?.(threadId) ?? work.access),
    };
  };
  const modelFor = (thread: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }): ShieldModelPort | undefined => {
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
        const subject = subjectOf(threadId);
        if (subject === undefined || subject.thread.lifecycle !== "active") return undefined;
        const thread = subject.thread;
        const reviews = shieldReviewsPrompts({
          reviewer: deps.chosenReviewer?.(thread),
          access: subject.access,
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
      watcherLabels: deps.watcherLabels,
      personMessages: (threadId) => {
        const thread = readThread(threadId);
        if (thread !== undefined)
          return deps.personMessages(thread.id, SHIELD_PERSON_MESSAGE_COUNT);
        const work = readWorkThread(threadId);
        return work === undefined
          ? []
          : (deps.workPersonMessages?.(work.id, SHIELD_PERSON_MESSAGE_COUNT) ?? []);
      },
      projectCommands: projectCommandsIn,
      ...(deps.servers === undefined ? {} : { servers: deps.servers }),
    },
    ...(deps.spendCeiling === undefined && deps.recordUsage === undefined
      ? {}
      : {
          spend: shieldSpend(
            deps.spendCeiling,
            deps.recordUsage,
            (threadId) => subjectOf(threadId)?.kind ?? "code-thread",
          ),
        }),
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
  spendCeiling: Pick<SpendCeilingService, "admit" | "settle" | "abandon"> | undefined,
  recordUsage: HostShieldDependencies["recordUsage"],
  threadTypeOf: (threadId: string) => "work-thread" | "code-thread",
): NonNullable<ConstructorParameters<typeof OctantShield>[0]["spend"]> {
  return {
    admit: ({ threadId, projectId, model }) => {
      const reservationId = decodeSpendCeilingReservationId(randomUUID());
      const admission = spendCeiling?.admit({
        reservationId,
        threadId,
        threadType: threadTypeOf(threadId),
        ...(projectId === undefined ? {} : { projectId }),
        turnUpperBoundTokens: SHIELD_CALL_TOKEN_BOUND,
        // A review is spend, not a turn of the thread's own.
        countsAsTurn: false,
      });
      if (admission?.status === "refused") {
        return { status: "refused", reason: admission.refusal.message };
      }
      return {
        status: "admitted",
        // What the call used is recorded under the thread before the
        // reservation goes, so the next admission sees it as committed spend.
        settle: (usage) => {
          try {
            recordUsage?.({ threadId, model, usage });
          } catch {
            // A ledger that refuses the record still releases the reservation.
          }
          spendCeiling?.settle({
            reservationId,
            ...(usage === undefined
              ? {}
              : { observedTokens: usage.inputTokens + usage.outputTokens }),
          });
        },
      };
    },
  };
}

export { shieldRoutesApprovals } from "@octant/domain/guardrail-policy";
