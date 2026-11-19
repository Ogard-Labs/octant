import {
  MAX_FINISHED_CHECKS,
  MAX_FINISHED_CHECK_COMMAND_LENGTH,
  MAX_FINISHED_SUMMARY_LENGTH,
  REPORT_FINISHED_TOOL_NAME,
  decodeFinishedReceiptId,
  decodeFinishedReceiptRecorded,
  decodeProjectId,
  decodeUtcTimestamp,
  type FinishedReceiptCheckCommand,
  type FinishedReceiptDiff,
  type FinishedReceiptItem,
  type OctantMode,
  type ProviderExecutionPolicy,
  type ProviderToolDefinition,
  type ThreadGoal,
} from "@octant/contracts";
import { decodeReportFinishedInput } from "@octant/contracts/finished-receipt";
import { isToolAllowedByAllowlist } from "@octant/domain";
import {
  deriveClaimedGoalCriterionItem,
  deriveFinishedReceiptCheckItem,
  evaluateFinishedReport,
  type FinishedCheckExecutionOutcome,
} from "@octant/domain/finished-receipt-policy";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import type { GitObservationPort } from "../code/gitObservationPort";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { ThreadFinishedReceiptStore } from "./finishedReceiptStore";

const CHECK_TIMEOUT_MS = 120_000;
const MAX_TOOL_INPUT_BYTES = 16 * 1024;

export const REPORT_FINISHED_TOOL_DEFINITION: ProviderToolDefinition = {
  name: REPORT_FINISHED_TOOL_NAME,
  description: [
    "Report that this thread's task is finished with proof built by Octant.",
    "Pass a concise summary (at most 1,000 characters) and up to 12 check commands (each at most 200 characters) that you rely on.",
    "Octant runs each check command and any thread goal checks itself in the thread's folder or checkout and records the observed diff.",
    "If any check fails, nothing is recorded as finished and the failed check output is returned to you so you can fix it and report again.",
    "This tool never marks a thread Done; only the person (or a met Code delivery target) marks Done.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        maxLength: MAX_FINISHED_SUMMARY_LENGTH,
        description: "What you completed and verified.",
      },
      checks: {
        type: "array",
        maxItems: MAX_FINISHED_CHECKS,
        items: {
          type: "string",
          maxLength: MAX_FINISHED_CHECK_COMMAND_LENGTH,
        },
        description: "Check commands the host should run once as proof (each at most 200 chars).",
      },
    },
    required: ["summary"],
    additionalProperties: false,
  },
};

export interface ReportFinishedToolOptions {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId: string;
  readonly turnId?: string | undefined;
  /** Child runs report to their parent and are never offered this tool. */
  readonly isChildRun?: boolean | undefined;
  /** Live execution posture; Plan refuses and omits the tool. */
  readonly readPosture: () => ProviderExecutionPolicy | undefined;
  /** Profile tool allowlist when bound to a Code profile. */
  readonly toolConstraints?: ReadonlyArray<string> | undefined;
  readonly profileDisplayName?: string | undefined;
  /** Thread's bound checkout or folder; absent for a Work thread with no folder. */
  readonly folder?: string | undefined;
  readonly extraFolders?: ReadonlyArray<string> | undefined;
  /** Host shell runner used to execute check commands. */
  readonly shell?: NativeHarnessShellPort | undefined;
  /** Asks the person before running a check command below Full access. */
  readonly askPerson?:
    | ((
        summary: string,
        signal?: AbortSignal,
      ) => Promise<"approved" | "denied" | "cancelled" | "expired">)
    | undefined;
  /** Reads the thread's goal so any goal criteria are verified or marked claimed. */
  readonly readGoal?: () => ThreadGoal | undefined;
  /** Observes diff file and line counts in the thread's checkout or folder. */
  readonly observeDiff: (signal?: AbortSignal) => Promise<FinishedReceiptDiff>;
  readonly store: Pick<ThreadFinishedReceiptStore, "record">;
  readonly uuid: () => string;
  readonly clock: () => string;
}

type ToolOutcome = Awaited<ReturnType<AppManagedToolSet["execute"]>>;

function refused(reason: string, message: string): ToolOutcome {
  return { result: { status: "refused", reason, message }, isError: true };
}

function shellRunToOutcome(run: NativeHarnessShellRun): FinishedCheckExecutionOutcome {
  switch (run.status) {
    case "ran":
      return { status: "ran", exitCode: run.exitCode ?? 1, output: run.output };
    case "timed-out":
      return { status: "timed-out", output: run.output };
    case "cancelled":
      return { status: "approval-cancelled", reason: "The turn was cancelled." };
    case "unavailable":
      return {
        status: "unavailable",
        reason: run.refusal?.message ?? "Shell execution is unavailable.",
      };
  }
}

/**
 * Observe a checkout or folder's diff counts through the existing Git
 * observation port, returning `unavailable` when the thread has no folder or
 * the folder is not a readable Git checkout.
 */
export async function observeFolderFinishedDiff(input: {
  readonly folder: string | undefined;
  readonly git: Pick<GitObservationPort, "observe">;
  readonly signal?: AbortSignal | undefined;
}): Promise<FinishedReceiptDiff> {
  if (input.folder === undefined) {
    return { status: "unavailable", reason: "This thread has no folder." };
  }
  try {
    const observation = await input.git.observe(input.folder, input.signal);
    if (observation.status === "ready") {
      return {
        status: "observed",
        changedFiles: observation.changedPaths.length,
        insertions: observation.insertions,
        deletions: observation.deletions,
      };
    }
    return { status: "unavailable", reason: "No Git diff is available for this folder." };
  } catch {
    return { status: "unavailable", reason: "Diff counts could not be read for this folder." };
  }
}

/**
 * `octant_report_finished` for a Work or Code lead outside Plan.
 *
 * Chat threads, Plan turns, and child runs are never offered the tool and are
 * refused if they call it anyway. Every check command runs once under the
 * thread's guardrail level: no prompt at Full access, and the thread's normal
 * approval below it. A failing check prevents recording and returns the last
 * 2,000 characters of its output in the same turn.
 */
export function createReportFinishedTool(options: ReportFinishedToolOptions): AppManagedToolSet {
  const mode = options.mode;
  const disallowedByProfile =
    options.toolConstraints !== undefined &&
    options.toolConstraints.length > 0 &&
    !isToolAllowedByAllowlist(options.toolConstraints, REPORT_FINISHED_TOOL_NAME);

  if (mode === "chat" || options.isChildRun === true || disallowedByProfile) {
    return {
      definitions: [],
      execute: async () =>
        refused(
          mode === "chat"
            ? "chat-not-supported"
            : options.isChildRun === true
              ? "child-run-not-supported"
              : "profile-disallows-tool",
          mode === "chat"
            ? "Chat threads cannot report finished with proof."
            : options.isChildRun === true
              ? "Child runs report to their parent and cannot use octant_report_finished."
              : `${options.profileDisplayName ?? "This profile"} does not allow ${REPORT_FINISHED_TOOL_NAME}.`,
        ),
    };
  }

  const initialPosture = options.readPosture();
  // Omit the tool when the turn starts in Plan; keep execute refusing live too
  // in case a runtime retains tool definitions across turns.
  const definitions: ReadonlyArray<ProviderToolDefinition> =
    initialPosture === "plan" ? [] : [REPORT_FINISHED_TOOL_DEFINITION];

  return {
    definitions,
    execute: async ({ inputJson, signal }) => {
      if (signal?.aborted) {
        return refused("tool-interrupted", "The turn was cancelled.");
      }
      const livePosture = options.readPosture();
      if (livePosture === "plan") {
        return refused(
          "plan-mode-refused",
          "Plan mode is read-only and cannot run checks or report finished.",
        );
      }
      if (Buffer.byteLength(inputJson, "utf8") > MAX_TOOL_INPUT_BYTES) {
        return refused("input-too-large", "octant_report_finished input exceeds the size limit.");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(inputJson);
      } catch {
        return refused("invalid-json", "octant_report_finished input must be valid JSON.");
      }
      let input;
      try {
        input = decodeReportFinishedInput(raw);
      } catch {
        return refused(
          "invalid-input",
          `Provide a non-empty summary (at most ${String(MAX_FINISHED_SUMMARY_LENGTH)} characters) and at most ${String(MAX_FINISHED_CHECKS)} check commands (each at most ${String(MAX_FINISHED_CHECK_COMMAND_LENGTH)} characters).`,
        );
      }

      // Deduplicate named checks while preserving caller order.
      const namedChecks: FinishedReceiptCheckCommand[] = [];
      const seenNamed = new Set<string>();
      for (const command of input.checks ?? []) {
        if (!seenNamed.has(command)) {
          seenNamed.add(command);
          namedChecks.push(command);
        }
      }

      // Cache results by exact command within this single report so a goal
      // criterion naming the same command as a named check runs once.
      const outcomesByCommand = new Map<string, FinishedCheckExecutionOutcome>();
      const runCommandOnce = async (
        command: FinishedReceiptCheckCommand,
      ): Promise<FinishedCheckExecutionOutcome> => {
        const cached = outcomesByCommand.get(command);
        if (cached !== undefined) return cached;

        if (signal?.aborted) {
          const outcome: FinishedCheckExecutionOutcome = {
            status: "approval-cancelled",
            reason: "The turn was cancelled.",
          };
          outcomesByCommand.set(command, outcome);
          return outcome;
        }
        if (options.folder === undefined) {
          const outcome: FinishedCheckExecutionOutcome = {
            status: "unavailable",
            reason: "This thread has no folder to run checks in.",
          };
          outcomesByCommand.set(command, outcome);
          return outcome;
        }
        if (options.shell === undefined) {
          const outcome: FinishedCheckExecutionOutcome = {
            status: "unavailable",
            reason: "Check execution is unavailable in this environment.",
          };
          outcomesByCommand.set(command, outcome);
          return outcome;
        }

        const currentPosture = options.readPosture();
        if (currentPosture === "plan") {
          const outcome: FinishedCheckExecutionOutcome = {
            status: "approval-denied",
            reason: "Plan mode is read-only and cannot run checks.",
          };
          outcomesByCommand.set(command, outcome);
          return outcome;
        }
        if (currentPosture !== "full-access") {
          if (options.askPerson === undefined) {
            const outcome: FinishedCheckExecutionOutcome = {
              status: "approval-denied",
              reason: "Approval is required below Full access, and no person is available.",
            };
            outcomesByCommand.set(command, outcome);
            return outcome;
          }
          const answer = await options.askPerson(`Run check: ${command}`, signal);
          if (answer !== "approved") {
            const outcome: FinishedCheckExecutionOutcome =
              answer === "denied"
                ? { status: "approval-denied", reason: "The person denied running this check." }
                : {
                    status: "approval-cancelled",
                    reason:
                      answer === "expired"
                        ? "Approval expired before running this check."
                        : "Approval was cancelled before running this check.",
                  };
            outcomesByCommand.set(command, outcome);
            return outcome;
          }
        }

        const run = await options.shell.run({
          command,
          cwd: options.folder,
          ...(options.extraFolders === undefined || options.extraFolders.length === 0
            ? {}
            : { extraRoots: options.extraFolders }),
          timeoutMs: CHECK_TIMEOUT_MS,
          callId: options.uuid(),
          ...(signal === undefined ? {} : { signal }),
        });
        const outcome = shellRunToOutcome(run);
        outcomesByCommand.set(command, outcome);
        return outcome;
      };

      const items: FinishedReceiptItem[] = [];
      for (const command of namedChecks) {
        const outcome = await runCommandOnce(command);
        items.push(
          deriveFinishedReceiptCheckItem({
            kind: "check",
            label: command,
            command,
            outcome,
          }),
        );
      }

      const goal = options.readGoal?.();
      for (const criterion of goal?.criteria ?? []) {
        if (criterion.check === undefined) {
          items.push(deriveClaimedGoalCriterionItem({ id: criterion.id, text: criterion.text }));
        } else {
          const outcome = await runCommandOnce(criterion.check);
          items.push(
            deriveFinishedReceiptCheckItem({
              kind: "goal-criterion",
              criterionId: criterion.id,
              label: criterion.text,
              command: criterion.check,
              outcome,
            }),
          );
        }
      }

      const evaluation = evaluateFinishedReport(items);
      if (!evaluation.accepted) {
        return {
          result: {
            status: "failed",
            recorded: false,
            failedChecks: evaluation.failedItems.map((item) => ({
              kind: item.kind,
              label: item.label,
              ...(item.command === undefined ? {} : { command: item.command }),
              ...(item.criterionId === undefined ? {} : { criterionId: item.criterionId }),
              ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
              ...(item.reason === undefined ? {} : { reason: item.reason }),
              outputTail: item.outputTail ?? "",
            })),
            message:
              "One or more checks failed, so nothing was recorded as finished. Fix the failing checks and call octant_report_finished again.",
          },
          isError: true,
        };
      }

      const diff = await options.observeDiff(signal);
      const recorded = decodeFinishedReceiptRecorded({
        receiptId: decodeFinishedReceiptId(options.uuid()),
        threadId: options.threadId,
        mode,
        projectId: decodeProjectId(options.projectId),
        ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
        summary: input.summary,
        items,
        diff,
        recordedAt: decodeUtcTimestamp(options.clock()),
      });
      const projected = options.store.record(recorded);

      return {
        result: {
          status: "recorded",
          receiptId: projected.receipt.receiptId,
          receiptStatus: projected.status,
          provenCount: projected.provenCount,
          claimedCount: projected.claimedCount,
          unavailableCount: projected.unavailableCount,
          diff: projected.receipt.diff,
          note: "Finished receipt recorded with host proof. Only the person or a met Code delivery target marks a thread Done.",
        },
      };
    },
  };
}
