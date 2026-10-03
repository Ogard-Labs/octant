import type {
  AgentRunDelegationResult,
  AgentRunDelegationInput,
  agentRunDelegationCapabilities,
} from "../agentRun/agentRunDelegation";
import type { AgentRunParentSummaryRoute } from "../agentRun/agentRunProjection";
import {
  decodeUtcTimestamp,
  MAX_NATIVE_HARNESS_TOOL_DETAIL,
  NATIVE_HARNESS_TOOL_DEFINITIONS,
  NATIVE_HARNESS_TOOL_NAMES,
  decodeNativeHarnessToolArguments,
  lookupClosedToolCatalogEntry,
  nativeHarnessToolCapabilityId,
  type NativeHarnessAskUserArguments,
  type NativeHarnessBashArguments,
  type NativeHarnessContextRemaining,
  type NativeHarnessDelegateArguments,
  type NativeHarnessEditArguments,
  type NativeHarnessGlobArguments,
  type NativeHarnessGoalArguments,
  type NativeHarnessGoalCheckArguments,
  type NativeHarnessGrepArguments,
  type NativeHarnessJournalLookupRequest,
  type NativeHarnessJournalLookupResult,
  type NativeHarnessReadArguments,
  type NativeHarnessSecondOpinionArguments,
  type NativeHarnessTodoItem,
  type NativeHarnessTodoWriteArguments,
  type NativeHarnessToolCall,
  type NativeHarnessToolName,
  type NativeHarnessWebFetchArguments,
  type NativeHarnessWebSearchArguments,
  type NativeHarnessWriteArguments,
  type OctantMode,
  type ProviderToolDefinition,
  type ToolActionAuthority,
  type ToolActionRequest,
} from "@octant/contracts";
import { Schema } from "effect";
import { decodeToolActionRequest } from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { ToolCallAuthorityService } from "../toolCallAuthorityService";
import type { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import { nativeHarnessGoalSummary, type NativeHarnessGoalPort } from "./nativeHarnessGoal";

const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const MAX_SHELL_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
/** A criterion's check is often a whole test suite; it gets longer than an ad hoc command. */
const GOAL_CHECK_TIMEOUT_MS = 600_000;
const MAX_FETCH_TEXT_BYTES = 128 * 1024;
const DEFAULT_DELEGATE_WAIT_MS = 60_000;

export interface NativeHarnessShellRun {
  readonly status: "ran" | "timed-out" | "cancelled" | "unavailable";
  readonly exitCode?: number;
  readonly output: string;
  readonly truncated: boolean;
}

export interface NativeHarnessShellPort {
  run(input: {
    readonly command: string;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<NativeHarnessShellRun>;
}

export interface NativeHarnessWebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type NativeHarnessDelegateStart = AgentRunDelegationResult;

export interface NativeHarnessDelegateChild {
  readonly runId: string;
  readonly role: string;
  readonly task: string;
  readonly lifecycleStatus: string;
  readonly resultAvailable: boolean;
  readonly route?: AgentRunParentSummaryRoute;
  readonly reasoning?: string;
  /** The runs this child waits for, when it was started with `after`. */
  readonly after?: ReadonlyArray<string>;
  /** Why a child is waiting, failed, or was interrupted. */
  readonly reason?: string;
}

export type NativeHarnessDelegateCollect =
  | { readonly status: "completed"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "not-ready"; readonly lifecycleStatus: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Delegation as the tool set sees it. The port owns admission: role→slot
 * routing, the creation posture, authority clamps, and capacity all happen
 * behind it, and a refusal comes back as a value the model can read.
 */
export interface NativeHarnessDelegatePort {
  capabilities(): Promise<ReturnType<typeof agentRunDelegationCapabilities>>;
  start(input: AgentRunDelegationInput): Promise<NativeHarnessDelegateStart>;
  status(): Promise<ReadonlyArray<NativeHarnessDelegateChild>>;
  collect(runId: string): Promise<NativeHarnessDelegateCollect>;
  /**
   * Waits until every named child (every child, when none are named) has
   * finished for good, or the time runs out; reports each one either way.
   */
  wait(input: {
    readonly runIds?: ReadonlyArray<string> | undefined;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    readonly finished: boolean;
    readonly children: ReadonlyArray<NativeHarnessDelegateChild>;
  }>;
}

export interface NativeHarnessWebFetchResult {
  readonly status: number;
  readonly contentType?: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly finalUrl: string;
}

/**
 * What the harness may reach. Every port is optional: a mode or a host that
 * lacks one simply does not offer the tool, it never fakes it.
 */
export interface NativeHarnessToolPorts {
  readonly filesystem?: NativeHarnessFileSystem;
  readonly shell?: NativeHarnessShellPort;
  readonly webSearch?: (input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }) => Promise<ReadonlyArray<NativeHarnessWebSearchResult>>;
  readonly webFetch?: (input: {
    readonly url: string;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
  }) => Promise<NativeHarnessWebFetchResult | { readonly refused: string }>;
  readonly todo?: {
    readonly replace: (items: ReadonlyArray<NativeHarnessTodoItem>) => Promise<void>;
  };
  readonly contextRemaining?: () => NativeHarnessContextRemaining | undefined;
  readonly journalLookup?: (
    request: NativeHarnessJournalLookupRequest,
  ) => Promise<NativeHarnessJournalLookupResult>;
  readonly secondOpinion?: (input: {
    readonly question: string;
    readonly signal?: AbortSignal;
  }) => Promise<string | undefined>;
  readonly delegate?: NativeHarnessDelegatePort;
  /**
   * Asks the person to allow a call the policy would only allow with their
   * say-so, and waits. Absent means such a call is refused outright.
   */
  readonly approvals?: (input: {
    readonly toolName: NativeHarnessToolName;
    readonly summary: string;
    readonly approvalClass: string;
    readonly signal?: AbortSignal;
  }) => Promise<"approved" | "denied" | "expired" | "cancelled">;
  /** The thread's goal, when the host can reach it. */
  readonly goal?: NativeHarnessGoalPort;
  /** Queued notes from the person, handed to the lead inside the next tool result. */
  readonly steering?: () => ReadonlyArray<string>;
  /** Asks the person and waits; resolves with the answer or how the wait ended. */
  readonly askUser?: (input: {
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
  }) => Promise<
    | { readonly status: "answered"; readonly answer: string }
    | { readonly status: "expired" }
    | { readonly status: "cancelled" }
  >;
}

export interface CreateNativeHarnessToolsOptions {
  readonly threadId: string;
  readonly mode: OctantMode;
  /** The single server choke point every proposal passes before a port runs. */
  readonly authority: Pick<ToolCallAuthorityService, "authorize">;
  /** The authority the thread holds right now; absent means the thread speaks for nothing. */
  readonly resolveAuthority: () => ToolActionAuthority | undefined;
  readonly ports: NativeHarnessToolPorts;
  readonly uuid: () => string;
  /** Told about every call, refused ones included, so a surface can show the turn's work. */
  readonly observe?: (call: NativeHarnessToolCall) => void;
  readonly clock?: () => string;
}

const decodeRequest = decodeToolActionRequest;
const MAX_TOOL_SUMMARY_LENGTH = 240;
const isToolName = Schema.is(Schema.Literal(...NATIVE_HARNESS_TOOL_NAMES));

/**
 * The native harness tool set: the nine working tools and three harness reads,
 * offered in one fixed order and trimmed to the mode and the ports at hand.
 *
 * Every call is decoded against its argument schema, wrapped as a
 * `ToolActionRequest` under the thread's current authority, and authorized by
 * the server choke point before any port runs. A deny or a prompt comes back
 * to the model as a value with the policy's own reason, never as a throw and
 * never as a silently different action.
 */
export function createNativeHarnessTools(
  options: CreateNativeHarnessToolsOptions,
): AppManagedToolSet {
  const offered = NATIVE_HARNESS_TOOL_DEFINITIONS.filter((definition) =>
    isOffered(definition.name, options),
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definitions: offered,
    execute: async ({ name, inputJson, signal }) => {
      const startedAt = Date.now();
      const outcome = await run({ name, inputJson, signal });
      const toolName = NATIVE_HARNESS_TOOL_NAMES.find((candidate) => candidate === name);
      if (options.observe !== undefined && toolName !== undefined) {
        let summary: string = toolName;
        try {
          const parsed: unknown = inputJson.trim().length === 0 ? {} : JSON.parse(inputJson);
          summary = intentFor(toolName, parsed);
        } catch {
          // An unparseable input still counts as a call; the name is its summary.
        }
        const detail = detailFor(toolName, inputJson, outcome.result);
        options.observe({
          ...(detail === undefined ? {} : { detail }),
          name: toolName,
          summary:
            summary.length > MAX_TOOL_SUMMARY_LENGTH
              ? summary.slice(0, MAX_TOOL_SUMMARY_LENGTH)
              : summary,
          status:
            outcome.isError === true ? (outcome.refused === true ? "refused" : "failed") : "ok",
          durationMs: Math.max(0, Date.now() - startedAt),
          at: decodeUtcTimestamp(clock()),
        });
      }
      return {
        result: outcome.result,
        ...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
      };
    },
  };

  async function run({
    name,
    inputJson,
    signal,
  }: {
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    readonly result: unknown;
    readonly isError?: boolean;
    readonly refused?: boolean;
  }> {
    if (signal?.aborted) return refused("tool-interrupted");
    if (!isToolName(name) || !offered.some((definition) => definition.name === name)) {
      return refused("tool-unavailable");
    }
    if (Buffer.byteLength(inputJson, "utf8") > MAX_TOOL_INPUT_BYTES) {
      return refused("invalid-tool-input", "The tool input is too large.");
    }
    let raw: unknown;
    try {
      raw = inputJson.trim().length === 0 ? {} : JSON.parse(inputJson);
    } catch {
      return refused("invalid-tool-input", "The tool input is not valid JSON.");
    }
    let args: unknown;
    try {
      args = decodeNativeHarnessToolArguments(name, raw);
    } catch {
      return refused("invalid-tool-input", `The ${name} arguments do not match the tool's schema.`);
    }
    const authority = options.resolveAuthority();
    if (authority === undefined) return refused("tool-authority-stale");
    const capabilityId = nativeHarnessToolCapabilityId(name);
    // The command a person approves is fixed here, before any wait, and is
    // the only one the check may run.
    const approvedCheck =
      name === "goal-check"
        ? criterionCheck(args as NativeHarnessGoalCheckArguments, options.ports.goal)
        : undefined;
    let request: ToolActionRequest;
    try {
      request = decodeRequest({
        actionId: options.uuid(),
        correlationId: options.uuid(),
        capability: { id: capabilityId, version: 1 },
        authority,
        // A check's approval must show the command it will run, which lives
        // on the goal rather than in the call.
        intent:
          name === "goal-check"
            ? `goal-check: ${approvedCheck ?? (args as NativeHarnessGoalCheckArguments).criterionId}`
            : intentFor(name, args),
        approval: { kind: "not-required" },
      });
    } catch {
      return refused("tool-authority-stale");
    }
    const decision = options.authority.authorize({
      threadId: options.threadId,
      request,
      arguments: args,
    });
    if (decision.kind === "deny") {
      return refused(decision.reason, `The ${name} tool was refused by policy.`);
    }
    if (decision.kind === "prompt") {
      if (options.ports.approvals === undefined) {
        return refused(
          "approval-required",
          `The ${name} tool needs approval (${decision.policy.approvalClass}) under the thread's current access posture.`,
        );
      }
      const outcome = await options.ports.approvals({
        toolName: name,
        summary: request.intent,
        approvalClass: decision.policy.approvalClass,
        ...(signal === undefined ? {} : { signal }),
      });
      if (outcome !== "approved") {
        return refused(
          outcome === "denied" ? "approval-denied" : `approval-${outcome}`,
          outcome === "denied"
            ? `The person did not allow ${name} here. Do not retry it; say what you would have done.`
            : outcome === "expired"
              ? `Nobody answered the approval for ${name} in time. Continue without it and say so.`
              : `The turn was cancelled while waiting for approval of ${name}.`,
        );
      }
    }
    let outcome;
    try {
      outcome =
        name === "goal-check"
          ? await checkGoalCriterion(
              (args as NativeHarnessGoalCheckArguments).criterionId,
              approvedCheck,
              options.ports,
              signal,
            )
          : await execute(name, args, options.ports, signal);
    } catch {
      return { ...refused("tool-execution-failed"), refused: false };
    }
    const notes = options.ports.steering?.() ?? [];
    if (notes.length === 0 || typeof outcome.result !== "object" || outcome.result === null) {
      return outcome;
    }
    // The person's note rides inside the tool result so it lands mid-turn.
    return { ...outcome, result: { ...(outcome.result as object), note_from_person: notes } };
  }
}

function isOffered(
  name: string,
  options: CreateNativeHarnessToolsOptions,
): name is NativeHarnessToolName {
  if (!isToolName(name)) return false;
  const entry = lookupClosedToolCatalogEntry({
    id: nativeHarnessToolCapabilityId(name) as never,
    version: 1,
  });
  if (entry === undefined || !entry.modes.includes(options.mode)) return false;
  const ports = options.ports;
  switch (name) {
    case "read":
    case "grep":
    case "glob":
    case "edit":
    case "write":
      return ports.filesystem !== undefined;
    case "bash":
      return ports.shell !== undefined && ports.filesystem !== undefined;
    case "web-fetch":
      return ports.webFetch !== undefined;
    case "web-search":
      return ports.webSearch !== undefined;
    case "todo-write":
      return ports.todo !== undefined;
    case "context-remaining":
      return ports.contextRemaining !== undefined;
    case "journal-lookup":
      return ports.journalLookup !== undefined;
    case "second-opinion":
      return ports.secondOpinion !== undefined;
    case "delegate":
      return ports.delegate !== undefined;
    case "ask-user":
      return ports.askUser !== undefined;
    case "goal":
      return ports.goal !== undefined;
    case "goal-check":
      return (
        ports.goal !== undefined && ports.shell !== undefined && ports.filesystem !== undefined
      );
  }
}

async function execute(
  name: NativeHarnessToolName,
  args: unknown,
  ports: NativeHarnessToolPorts,
  signal: AbortSignal | undefined,
): Promise<{ readonly result: unknown; readonly isError?: boolean }> {
  switch (name) {
    case "read": {
      const input = args as NativeHarnessReadArguments;
      const outcome = await ports.filesystem!.read(input);
      return outcome.kind === "refused" ? refused(outcome.reason) : ok(outcome);
    }
    case "grep": {
      const input = args as NativeHarnessGrepArguments;
      const outcome = await ports.filesystem!.grep(input);
      return outcome.kind === "refused" ? refused(outcome.reason) : ok(outcome);
    }
    case "glob": {
      const input = args as NativeHarnessGlobArguments;
      const outcome = await ports.filesystem!.glob(input);
      return outcome.kind === "refused" ? refused(outcome.reason) : ok(outcome);
    }
    case "edit": {
      const input = args as NativeHarnessEditArguments;
      const outcome = await ports.filesystem!.edit(input);
      return outcome.kind === "refused" ? refused(outcome.reason) : ok(outcome);
    }
    case "write": {
      const input = args as NativeHarnessWriteArguments;
      const outcome = await ports.filesystem!.write(input);
      return outcome.kind === "refused" ? refused(outcome.reason) : ok(outcome);
    }
    case "bash": {
      const input = args as NativeHarnessBashArguments;
      const run = await ports.shell!.run({
        command: input.command,
        cwd: ports.filesystem!.root,
        timeoutMs: input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (run.status === "unavailable") return refused("shell-unavailable");
      if (run.status === "cancelled") return refused("tool-interrupted");
      const bounded = boundedTail(run.output, MAX_SHELL_OUTPUT_BYTES);
      return {
        result: {
          status: run.status,
          ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
          output: bounded.text,
          bounds: bounded.bounds,
        },
        isError: run.status === "timed-out" || (run.exitCode !== undefined && run.exitCode !== 0),
      };
    }
    case "web-fetch": {
      const input = args as NativeHarnessWebFetchArguments;
      const fetched = await ports.webFetch!({
        url: input.url,
        maxBytes: input.maxBytes ?? MAX_FETCH_TEXT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      });
      return "refused" in fetched ? refused("fetch-refused", fetched.refused) : ok(fetched);
    }
    case "web-search": {
      const input = args as NativeHarnessWebSearchArguments;
      const results = await ports.webSearch!({
        query: input.query,
        limit: input.limit ?? 5,
        ...(signal === undefined ? {} : { signal }),
      });
      return ok({ query: input.query, results });
    }
    case "todo-write": {
      const input = args as NativeHarnessTodoWriteArguments;
      await ports.todo!.replace(input.items);
      return ok({ status: "recorded", items: input.items.length });
    }
    case "context-remaining": {
      const remaining = ports.contextRemaining!();
      return remaining === undefined ? refused("context-unavailable") : ok(remaining);
    }
    case "journal-lookup": {
      const request = args as NativeHarnessJournalLookupRequest;
      return ok(await ports.journalLookup!(request));
    }
    case "second-opinion": {
      const input = args as NativeHarnessSecondOpinionArguments;
      const answer = await ports.secondOpinion!({
        question: input.question,
        ...(signal === undefined ? {} : { signal }),
      });
      return answer === undefined ? refused("advisor-unavailable") : ok({ answer });
    }
    case "delegate": {
      const input = args as NativeHarnessDelegateArguments;
      const port = ports.delegate!;
      if (input.operation === "capabilities") return ok(await port.capabilities());
      if (input.operation === "start") {
        const started = await port.start({
          role: input.role,
          task: input.task,
          includeParentContext: input.includeParentContext === true,
          ...(input.providerInstanceId === undefined
            ? {}
            : { providerInstanceId: input.providerInstanceId }),
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
          ...(input.after === undefined ? {} : { after: input.after.map(String) }),
        });
        return started.status === "accepted"
          ? ok(started)
          : refused(started.reason, started.message);
      }
      if (input.operation === "status") {
        return ok({ children: await port.status() });
      }
      if (input.operation === "wait") {
        return ok(
          await port.wait({
            ...(input.runIds === undefined ? {} : { runIds: input.runIds.map(String) }),
            timeoutMs: input.timeoutMs ?? DEFAULT_DELEGATE_WAIT_MS,
            signal,
          }),
        );
      }
      const collected = await port.collect(input.runId);
      return collected.status === "refused" ? refused(collected.reason) : ok(collected);
    }
    case "ask-user": {
      const input = args as NativeHarnessAskUserArguments;
      const outcome = await ports.askUser!({
        prompt: input.prompt,
        options: input.options ?? [],
        ...(signal === undefined ? {} : { signal }),
      });
      if (outcome.status === "answered") return ok({ answer: outcome.answer });
      return refused(
        outcome.status === "expired" ? "question-expired" : "question-cancelled",
        outcome.status === "expired"
          ? "The person did not answer in time. Continue with your best judgment and say what you assumed."
          : "The turn was cancelled while waiting for an answer.",
      );
    }
    case "goal": {
      const input = args as NativeHarnessGoalArguments;
      const port = ports.goal;
      if (port === undefined) return refused("tool-unavailable");
      if (input.operation === "read") {
        const goal = port.read();
        return goal === undefined
          ? refused(
              "no-goal",
              "This thread has no goal. Ask the person to set one if the work needs it.",
            )
          : ok(nativeHarnessGoalSummary(goal));
      }
      const changed = await port.setCriteria(input.criteria);
      return changed.status === "recorded"
        ? ok(nativeHarnessGoalSummary(changed.goal))
        : refused(changed.reason, changed.message);
    }
    case "goal-check":
      // Runs through `checkGoalCriterion` with the command fixed before
      // approval; reaching here would mean a check with nothing approved.
      return refused("tool-unavailable");
  }
}

/**
 * Runs a criterion's own check in the checkout and records what it showed.
 * Met means the command ran and exited zero; anything else is recorded as
 * unmet with the reason, so a failed check is visible evidence too.
 */
async function checkGoalCriterion(
  criterionId: string,
  approvedCheck: string | undefined,
  ports: NativeHarnessToolPorts,
  signal: AbortSignal | undefined,
): Promise<{ readonly result: unknown; readonly isError?: boolean }> {
  const { goal: port, shell, filesystem } = ports;
  if (port === undefined || shell === undefined || filesystem === undefined) {
    return refused("tool-unavailable");
  }
  const goal = port.read();
  if (goal === undefined) return refused("no-goal", "This thread has no goal.");
  if (goal.status === "complete") return refused("goal-complete", "The goal is already complete.");
  const criterion = (goal.criteria ?? []).find((candidate) => candidate.id === criterionId);
  if (criterion === undefined) {
    return refused("criterion-not-found", `The goal has no criterion ${criterionId}.`);
  }
  if (criterion.check === undefined) {
    return refused(
      "needs-person",
      `${criterionId} has no check command, so a person confirms it. Ask them with ask-user if it matters now.`,
    );
  }
  if (criterion.check !== approvedCheck) {
    return refused(
      "criterion-changed",
      `${criterionId}'s check changed while it waited for approval; nothing ran. Read the goal and check it again.`,
    );
  }
  const run = await shell.run({
    command: criterion.check,
    cwd: filesystem.root,
    timeoutMs: GOAL_CHECK_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (run.status === "unavailable") return refused("shell-unavailable");
  if (run.status === "cancelled") return refused("tool-interrupted");
  const met = run.status === "ran" && run.exitCode === 0;
  const changed = await port.recordCheck({
    criterionId,
    checked: { text: criterion.text, check: criterion.check },
    outcome: met ? "met" : "unmet",
    evidence: {
      kind: "test",
      referenceId: `goal-check:${criterionId}:${new Date().toISOString()}`,
      summary: (run.status === "timed-out"
        ? `${criterion.check} timed out`
        : `${criterion.check} exited ${run.exitCode ?? "without a code"}`
      ).slice(0, 512),
      observedAt: decodeUtcTimestamp(new Date().toISOString()),
    },
  });
  const bounded = boundedTail(run.output, MAX_SHELL_OUTPUT_BYTES);
  if (changed.status !== "recorded") return refused(changed.reason, changed.message);
  return ok({
    criterionId,
    outcome: met ? "met" : "unmet",
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    output: bounded.text,
    bounds: bounded.bounds,
    goal: nativeHarnessGoalSummary(changed.goal),
  });
}

function criterionCheck(
  args: NativeHarnessGoalCheckArguments,
  goal: NativeHarnessGoalPort | undefined,
): string | undefined {
  return goal?.read()?.criteria?.find((criterion) => criterion.id === args.criterionId)?.check;
}

/**
 * What a surface can show under a call: an edit as a unified diff of the
 * replaced text, a write as its first lines, a command as the tail of its
 * output. Bounded, and never the whole file.
 */
function detailFor(
  name: NativeHarnessToolName,
  inputJson: string,
  result: unknown,
): string | undefined {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    args = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    args = {};
  }
  const bound = (text: string) =>
    text.length > MAX_NATIVE_HARNESS_TOOL_DETAIL
      ? `${text.slice(0, MAX_NATIVE_HARNESS_TOOL_DETAIL - 2)}…`
      : text;
  if (name === "edit" && typeof args.oldText === "string" && typeof args.newText === "string") {
    const path = typeof args.path === "string" ? args.path : "file";
    const removed = args.oldText.split("\n").map((line) => `-${line}`);
    const added = args.newText.split("\n").map((line) => `+${line}`);
    return bound(
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,${removed.length} +1,${added.length} @@`,
        ...removed,
        ...added,
      ].join("\n"),
    );
  }
  if (name === "write" && typeof args.content === "string") {
    const path = typeof args.path === "string" ? args.path : "file";
    const lines = args.content.split("\n");
    const added = lines.slice(0, 40).map((line) => `+${line}`);
    return bound(
      [
        `--- /dev/null`,
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...added,
        ...(lines.length > 40 ? [`… ${lines.length - 40} more lines`] : []),
      ].join("\n"),
    );
  }
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const text =
      typeof record.output === "string"
        ? record.output
        : typeof record.message === "string"
          ? record.message
          : typeof record.error === "string"
            ? record.error
            : undefined;
    if (text === undefined || text.trim().length === 0) return undefined;
    const tail = text.length > 2_000 ? `…${text.slice(-2_000)}` : text;
    return bound(tail);
  }
  return undefined;
}

function intentFor(name: NativeHarnessToolName, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const detail =
    typeof record.path === "string"
      ? record.path
      : typeof record.command === "string"
        ? record.command
        : typeof record.url === "string"
          ? record.url
          : typeof record.query === "string"
            ? record.query
            : typeof record.pattern === "string"
              ? record.pattern
              : "";
  const text = detail.length === 0 ? name : `${name}: ${detail}`;
  return text.length > 2_048 ? text.slice(0, 2_048) : text;
}

function boundedTail(
  text: string,
  maxBytes: number,
): {
  readonly text: string;
  readonly bounds: {
    truncated: boolean;
    returnedBytes: number;
    omittedBytes?: number;
    nextOffset?: number;
  };
} {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, bounds: { truncated: false, returnedBytes: total } };
  // The end of a command's output is what usually carries the answer.
  const buffer = Buffer.from(text, "utf8");
  const tail = buffer.subarray(total - maxBytes).toString("utf8");
  return {
    text: tail,
    bounds: {
      truncated: true,
      returnedBytes: Buffer.byteLength(tail, "utf8"),
      omittedBytes: total - maxBytes,
      nextOffset: total - maxBytes,
    },
  };
}

function ok(result: unknown) {
  return { result, isError: false } as const;
}

function refused(error: string, message?: string) {
  return {
    result: { error, ...(message === undefined ? {} : { message }) },
    isError: true,
    refused: true,
  } as const;
}

export function nativeHarnessToolDefinitionsFor(
  mode: OctantMode,
  ports: NativeHarnessToolPorts,
): ReadonlyArray<ProviderToolDefinition> {
  return NATIVE_HARNESS_TOOL_DEFINITIONS.filter((definition) =>
    isOffered(definition.name, {
      mode,
      ports,
      threadId: "",
      authority: { authorize: () => ({ kind: "deny" }) as never },
      resolveAuthority: () => undefined,
      uuid: () => "",
    }),
  );
}
