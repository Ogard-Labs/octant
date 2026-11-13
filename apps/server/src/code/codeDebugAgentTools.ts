import {
  decodeToolActionRequest,
  type CodeThread,
  type ToolActionAuthority,
  type ToolActionRequest,
  type WindowId,
} from "@octant/contracts";
import {
  CODE_DEBUG_TOOL_DEFINITION,
  CODE_DEBUG_TOOL_NAME,
  MAX_CODE_DEBUG_AGENT_CONFIGURATIONS,
  MAX_CODE_DEBUG_AGENT_FRAMES,
  MAX_CODE_DEBUG_AGENT_OUTPUT_ENTRIES,
  MAX_CODE_DEBUG_AGENT_OUTPUT_TEXT_LENGTH,
  MAX_CODE_DEBUG_AGENT_SCOPES,
  MAX_CODE_DEBUG_AGENT_THREADS,
  MAX_CODE_DEBUG_AGENT_VALUE_LENGTH,
  MAX_CODE_DEBUG_AGENT_VARIABLES,
  decodeCodeDebugToolArguments,
  type CodeDebugConfiguration,
  type CodeDebugConfigurationDigest,
  type CodeDebugRefusalReason,
  type CodeDebugRunningSession,
  type CodeDebugSessionId,
  type CodeDebugSessionRequest,
  type CodeDebugSessionResult,
  type CodeDebugSessionToolArguments,
  type CodeDebugStartResult,
  type CodeDebugToolArguments,
  type CodeDebugVariable,
} from "@octant/contracts/code-debug";
import { isToolAllowedByAllowlist } from "@octant/domain";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import { redactHostSecretsInValue } from "../process/secretRedaction";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { digestOf, type CodeDebugCaller, type CodeDebugService } from "./codeDebugService";

/**
 * The debugger as one app-managed tool for a Code turn, `octant_debug`: list
 * what can be started, start it, set breakpoints, step, read the stopped
 * program, and stop. Canonical: docs/design/language-services.md § Debugger
 * authority (decision DB8).
 *
 * It is offered only on a turn outside Plan, on a host where a session could
 * start: one with an adapter effective in Code. Each call is decoded against
 * its closed-catalog schema and authorized at the tool-call choke point at
 * the level the turn runs at, then by the debug service as a window's request
 * is. Plan refuses every operation. At Full access nothing asks. Below it the
 * person is asked once per session, in the thread, before the session starts
 * (or before the agent first touches a session the person started). The card
 * shows the configuration, so no confirmation on record is needed first, and
 * the answer covers controlling and reading that session and every
 * expression in it, on a marked thread too. What a session shows is the
 * program's own data: it is redacted as tool output is, cut to the tool's
 * bounds, journaled as outside content, and passed by Octant Shield's Watcher
 * before the model sees it.
 */

const MAX_TOOL_INPUT_BYTES = 16 * 1024;
/** As the language tool's: a Code turn drops any result over 64 KiB whole. */
const MAX_RESULT_LIST_BYTES = 48 * 1024;
/** How long a start or a step waits for the program to stop before answering. */
const SETTLE_AFTER_CONTROL_MS = 5_000;
const SETTLE_POLL_MS = 50;
const MAX_SHOWN_ARGUMENT_LENGTH = 512;
/** A card is cut at 2 KiB from its end, so what runs comes first and each part is bounded. */
const MAX_SHOWN_PATH_LENGTH = 256;
const MAX_SHOWN_ENVIRONMENT_NAMES_LENGTH = 384;
const STALE_MESSAGE =
  "This thread no longer holds the authority a debug session needs. Continue without it and say so.";
const INVALID_INPUT_MESSAGE =
  "Give an operation and only its own arguments: start takes a configuration digest that configurations listed; breakpoints takes a path and its lines; scopes takes a frame id from stack; variables takes a reference from scopes; evaluate takes an expression.";

/**
 * Which sessions a person's answer covers. Held by the host for as long as
 * it runs, never journaled: a session does not outlive the host either.
 */
export interface CodeDebugAgentSessionApprovals {
  readonly covers: (threadId: CodeThread["id"], sessionId: CodeDebugSessionId) => boolean;
  readonly remember: (threadId: CodeThread["id"], sessionId: CodeDebugSessionId) => void;
}

/** One covered session per thread, as a thread holds one session at a time. */
export function createCodeDebugAgentSessionApprovals(): CodeDebugAgentSessionApprovals {
  const covered = new Map<string, string>();
  return {
    covers: (threadId, sessionId) => covered.get(String(threadId)) === String(sessionId),
    remember: (threadId, sessionId) => {
      covered.set(String(threadId), String(sessionId));
    },
  };
}

export interface CodeDebugAgentToolsOptions {
  readonly windowId: WindowId;
  /** The thread as the turn started; its checkout is the one sessions run in. */
  readonly thread: CodeThread;
  /** The thread as the turn's window sees it when a call runs, the turn's posture included. */
  readonly readThread: () => CodeThread | undefined;
  readonly authority: () => ToolActionAuthority | undefined;
  readonly externalContentIngested: () => boolean;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly debug: Pick<
    CodeDebugService,
    "offersSessions" | "configurations" | "start" | "session" | "threadSession"
  >;
  readonly approvals: CodeDebugAgentSessionApprovals;
  /** Asks the person in the thread. */
  readonly askPerson: (
    summary: string,
    signal?: AbortSignal,
  ) => Promise<"approved" | "denied" | "cancelled" | "expired">;
  readonly uuid: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

type ToolOutcome = {
  readonly result: unknown;
  readonly isError: boolean;
  /** Set when the result carries what the program holds or printed. */
  readonly programData?: true;
};

type Startable = {
  readonly configurationDigest: CodeDebugConfigurationDigest;
  readonly configuration: CodeDebugConfiguration;
  readonly source: "confirmed" | "launch-file";
};

/**
 * The tool for one Code turn, or nothing when a profile leaves it out, the
 * turn runs in Plan, or no session could start on this host. A tool that
 * could only be refused is not shown.
 */
export function createCodeDebugAgentTools(
  options: CodeDebugAgentToolsOptions,
): AppManagedToolSet | undefined {
  const allowlist = options.thread.toolConstraints ?? [];
  if (!isToolAllowedByAllowlist(allowlist, CODE_DEBUG_TOOL_NAME)) return undefined;
  if (options.thread.executionPolicy === "plan") return undefined;
  if (!options.debug.offersSessions) return undefined;

  const caller: CodeDebugCaller = { scopeId: options.windowId, principal: "agent" };
  const scope = { threadId: options.thread.id, checkoutId: options.thread.checkoutId };
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  // What the gate's next decision may take as already approved; set per call.
  let approvalSatisfied = false;
  const gate = new ToolCallAuthorityService({
    resolveGrantedAuthority: () => options.authority(),
    resolveLiveFacts: () => {
      const current = options.readThread() ?? options.thread;
      return {
        // The set is composed only for a provider that carries app-managed tools.
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: false },
        executionPolicy: current.executionPolicy,
        approvalSatisfied,
        externalContentIngested: options.externalContentIngested(),
        ...(current.toolConstraints === undefined
          ? {}
          : { toolConstraints: current.toolConstraints }),
        ...(current.profileDisplayName === undefined
          ? {}
          : { profileDisplayName: current.profileDisplayName }),
      };
    },
  });

  const ask = (sessionId: CodeDebugSessionId, request: CodeDebugSessionRequest) =>
    options.debug.session(caller, { ...scope, sessionId, request });

  /**
   * The session's state once it has stopped or ended after `sinceRevision`,
   * or as it stands when the deadline passes or the turn is stopped.
   */
  const settled = async (
    sessionId: CodeDebugSessionId,
    input: {
      readonly sinceRevision: number;
      readonly deadlineMs: number;
      readonly afterOutput: number;
      readonly signal: AbortSignal | undefined;
    },
  ): Promise<CodeDebugSessionResult> => {
    const deadline = Date.now() + input.deadlineMs;
    for (;;) {
      const answer = await ask(sessionId, { kind: "state", afterOutput: input.afterOutput });
      if (answer.status !== "state") return answer;
      const rested =
        answer.state.status === "ended" ||
        (answer.state.status === "stopped" && answer.revision > input.sinceRevision);
      if (rested || Date.now() >= deadline || input.signal?.aborted === true) return answer;
      await wait(SETTLE_POLL_MS);
    }
  };

  const startable = async (): Promise<
    | {
        readonly status: "listed";
        readonly configurations: ReadonlyArray<Startable>;
        readonly session: CodeDebugRunningSession | undefined;
      }
    | { readonly status: "refused"; readonly reason: CodeDebugRefusalReason }
  > => {
    const listing = await options.debug.configurations(caller, scope);
    if (listing.status !== "listed") return listing;
    const found = new Map<string, Startable>();
    for (const approved of listing.approved) {
      found.set(String(approved.configurationDigest), {
        configurationDigest: approved.configurationDigest,
        configuration: approved.configuration,
        source: "confirmed",
      });
    }
    // A repository's proposal needs no confirmation first: at Full access
    // nothing asks, and below it the start's own card shows the person what
    // would run.
    if (listing.launchFile.status === "read") {
      for (const proposal of listing.launchFile.proposals) {
        if (proposal.status !== "proposed") continue;
        const configurationDigest = digestOf(proposal.configuration);
        if (found.has(String(configurationDigest))) continue;
        found.set(String(configurationDigest), {
          configurationDigest,
          configuration: proposal.configuration,
          source: "launch-file",
        });
      }
    }
    return {
      status: "listed",
      configurations: [...found.values()].slice(0, MAX_CODE_DEBUG_AGENT_CONFIGURATIONS),
      session: listing.session,
    };
  };

  const run = async (
    call: CodeDebugToolArguments,
    signal: AbortSignal | undefined,
  ): Promise<ToolOutcome> => {
    const current = options.readThread();
    const authority = options.authority();
    if (current === undefined || authority === undefined) {
      return refusedCall("tool-authority-stale", STALE_MESSAGE);
    }
    const held = options.debug.threadSession(caller, scope);
    if (held.status === "refused") return serviceRefusal(held.reason);
    const running = held.status === "running" ? held.session : undefined;
    // How the thread's last session ended, for a `state` read once it is
    // gone: the agent tells a clean exit from a failed one without the
    // session. Only a session the person answered for, or any at Full access.
    const ended = held.status === "none" && call.operation === "state" ? held.last : undefined;

    const capabilityId = call.operation === "evaluate" ? "code-debug-evaluate" : "code-debug";
    let request: ToolActionRequest;
    try {
      request = decodeToolActionRequest({
        actionId: options.uuid(),
        correlationId: options.uuid(),
        capability: { id: capabilityId, version: 1 },
        authority,
        intent: `${capabilityId} ${call.operation}`,
        approval: { kind: "not-required" },
      });
    } catch {
      return refusedCall("tool-authority-stale", STALE_MESSAGE);
    }
    // A listing runs nothing, so it has nothing to ask about; Plan still
    // refuses it with every other operation. A start is never covered ahead
    // of time. Anything else is covered once the person answered for the
    // session that is running.
    approvalSatisfied =
      call.operation === "configurations" ||
      (call.operation !== "start" &&
        running !== undefined &&
        options.approvals.covers(options.thread.id, running.sessionId)) ||
      (ended !== undefined && options.approvals.covers(options.thread.id, ended.sessionId));
    const decision = gate.authorize({
      threadId: String(options.thread.id),
      request,
      arguments: call,
    });
    if (decision.kind === "deny") {
      return decision.reason === "plan-mode-denied"
        ? refusedCall("plan-read-only", "Plan is read-only, so it runs and debugs no program.")
        : refusedCall(
            "tool-refused",
            decision.reason.startsWith("Profile ")
              ? decision.reason
              : `The debug operation was refused by policy (${decision.reason}).`,
          );
    }
    const asks = decision.kind === "prompt";

    if (call.operation === "configurations") {
      const listed = await startable();
      if (listed.status === "refused") return serviceRefusal(listed.reason);
      // A person may have typed a key as an argument. The listing is the
      // Project's own record, so it marks nothing, but it is redacted as
      // every other result is. It is bounded by bytes as well as count: four
      // configurations of 64 long arguments pass every per-configuration
      // limit yet exceed the turn's 64 KiB result limit, which would drop the
      // whole listing and leave no digest to start.
      const shown = withinBudget(
        listed.configurations.map((entry) => redactHostSecretsInValue(agentConfiguration(entry))),
        MAX_CODE_DEBUG_AGENT_CONFIGURATIONS,
      );
      return {
        result: {
          configurations: shown.entries,
          ...(shown.cut
            ? { truncated: true, omitted: listed.configurations.length - shown.entries.length }
            : {}),
          ...(listed.session === undefined
            ? {}
            : { session: redactHostSecretsInValue({ name: listed.session.name }) }),
        },
        isError: false,
      };
    }

    if (call.operation === "start") {
      if (running !== undefined) {
        return refusedCall(
          "thread-has-session",
          `This thread already runs the debug session "${running.name}". Stop it first.`,
        );
      }
      const listed = await startable();
      if (listed.status === "refused") return serviceRefusal(listed.reason);
      const chosen = listed.configurations.find(
        (candidate) => String(candidate.configurationDigest) === String(call.configuration),
      );
      if (chosen === undefined) {
        return refusedCall(
          "unknown-configuration",
          "No configuration this turn may start has that digest. Call configurations for the list.",
        );
      }
      if (asks) {
        const answer = await options.askPerson(startSummary(chosen), signal);
        if (answer !== "approved") return notApproved(answer);
      }
      const started = await options.debug.start(
        caller,
        {
          ...scope,
          configuration: chosen.configuration,
          breakpoints: (call.breakpoints ?? []).map(fileBreakpoints),
        },
        // The card showed exactly this configuration, so the answer stands in
        // for a confirmation on record, for this session only.
        { answeredInThread: asks },
      );
      if (started.status !== "started") return notStarted(started);
      // Only an answer the person gave covers the session. One started
      // unasked at Full access holds none, so a later turn narrowed below
      // Full access asks before it touches it.
      if (asks) options.approvals.remember(options.thread.id, started.sessionId);
      const state = await settled(started.sessionId, {
        sinceRevision: -1,
        deadlineMs: SETTLE_AFTER_CONTROL_MS,
        afterOutput: 0,
        signal,
      });
      return sessionAnswer(state, { started: chosen.configuration.name });
    }

    if (running === undefined && ended !== undefined && !asks) {
      // The host's own facts about the end; nothing the program held or printed.
      return {
        result: {
          session: "ended",
          endReason: ended.endReason,
          ...(ended.exitCode === undefined ? {} : { exitCode: ended.exitCode }),
          output: [],
        },
        isError: false,
      };
    }
    if (running === undefined) {
      return refusedCall(
        "no-session",
        "This thread runs no debug session. Start one with the start operation.",
      );
    }
    if (asks) {
      const answer = await options.askPerson(
        `Let the agent control the debug session "${running.name}"? It may step the program, read its variables and output, evaluate expressions in it, and stop it.`,
        signal,
      );
      if (answer !== "approved") return notApproved(answer);
      options.approvals.remember(options.thread.id, running.sessionId);
    }
    return sessionOperation(running.sessionId, call, signal);
  };

  const sessionOperation = async (
    sessionId: CodeDebugSessionId,
    call: Exclude<CodeDebugToolArguments, { readonly operation: "configurations" | "start" }>,
    signal: AbortSignal | undefined,
  ): Promise<ToolOutcome> => {
    switch (call.operation) {
      case "stop":
        return sessionAnswer(await ask(sessionId, { kind: "stop" }));
      case "breakpoints":
        return sessionAnswer(
          await ask(sessionId, { kind: "set-breakpoints", file: fileBreakpoints(call) }),
        );
      case "state":
        return sessionAnswer(
          await settled(sessionId, {
            // Any stop counts: the agent asks where the program is now.
            sinceRevision: -1,
            deadlineMs: (call.waitSeconds ?? 0) * 1_000,
            afterOutput: call.afterOutput ?? 0,
            signal,
          }),
        );
      case "threads":
        return sessionAnswer(await ask(sessionId, { kind: "threads" }));
      case "scopes":
        return sessionAnswer(await ask(sessionId, { kind: "scopes", frameId: call.frame }));
      case "variables":
        return sessionAnswer(
          await ask(sessionId, {
            kind: "variables",
            variablesReference: call.reference,
            ...(call.start === undefined ? {} : { start: call.start }),
          }),
          { variablesStart: call.start ?? 0 },
        );
      case "evaluate":
        return sessionAnswer(
          await ask(sessionId, {
            kind: "evaluate",
            expression: call.expression,
            context: "repl",
            ...(call.frame === undefined ? {} : { frameId: call.frame }),
          }),
        );
      case "stack":
      case "continue":
      case "step-over":
      case "step-in":
      case "step-out":
      case "pause": {
        const before = await ask(sessionId, { kind: "state" });
        if (before.status !== "state") return sessionAnswer(before);
        let programThreadId = call.thread;
        if (programThreadId === undefined && before.state.status === "stopped") {
          programThreadId = before.state.programThreadId;
        }
        if (programThreadId === undefined && call.operation === "pause") {
          const threads = await ask(sessionId, { kind: "threads" });
          if (threads.status !== "threads") return sessionAnswer(threads);
          programThreadId = threads.threads[0]?.id;
        }
        if (programThreadId === undefined) {
          return refusedCall(
            "not-stopped",
            "The program is not stopped. Pause it, or wait for a breakpoint with state and waitSeconds.",
          );
        }
        if (call.operation === "stack") {
          return sessionAnswer(await ask(sessionId, { kind: "stack-trace", programThreadId }));
        }
        const done = await ask(sessionId, { kind: CONTROL_KINDS[call.operation], programThreadId });
        if (done.status !== "done") return sessionAnswer(done);
        const last = before.output.at(-1)?.sequence;
        return sessionAnswer(
          await settled(sessionId, {
            sinceRevision: before.revision,
            deadlineMs: SETTLE_AFTER_CONTROL_MS,
            // Only what the program printed because of this step.
            afterOutput: last ?? 0,
            signal,
          }),
        );
      }
    }
  };

  const tools = {
    definitions: [CODE_DEBUG_TOOL_DEFINITION],
    execute: async ({
      name,
      inputJson,
      signal,
    }: Parameters<AppManagedToolSet["execute"]>[0]): Promise<ToolOutcome> => {
      if (signal?.aborted === true) return refusedCall("tool-interrupted", "The turn was stopped.");
      if (name !== CODE_DEBUG_TOOL_NAME) {
        return refusedCall("tool-unavailable", `${name} is not offered on this turn.`);
      }
      const call = parseCall(inputJson);
      if (call === undefined) return refusedCall("invalid-tool-input", INVALID_INPUT_MESSAGE);
      const outcome = await run(call, signal);
      // Redacted before anything else reads it: a stopped program's variables
      // and output can hold the same keys a command's output can.
      return outcome.programData === true
        ? { ...outcome, result: redactHostSecretsInValue(outcome.result) }
        : outcome;
    },
  };
  return {
    definitions: tools.definitions,
    execute: async (call) => {
      const { programData, ...outcome } = await tools.execute(call);
      if (programData !== true) return outcome;
      // The same marking every other app-managed tool's outside content gets.
      return taintAppManagedToolResults({
        tools: { definitions: tools.definitions, execute: async () => outcome },
        threadId: options.thread.id,
        recordExternalContentIngestion: options.recordExternalContentIngestion,
        uuid: options.uuid,
      }).execute(call);
    },
  };
}

const CONTROL_KINDS = {
  continue: "continue",
  "step-over": "next",
  "step-in": "step-in",
  "step-out": "step-out",
  pause: "pause",
} as const;

function parseCall(inputJson: string): CodeDebugToolArguments | undefined {
  if (Buffer.byteLength(inputJson, "utf8") > MAX_TOOL_INPUT_BYTES) return undefined;
  try {
    return decodeCodeDebugToolArguments(JSON.parse(inputJson));
  } catch {
    return undefined;
  }
}

function fileBreakpoints(file: {
  readonly path: Extract<CodeDebugSessionToolArguments, { operation: "breakpoints" }>["path"];
  readonly lines: ReadonlyArray<number>;
}) {
  return {
    path: file.path,
    breakpoints: [...new Set(file.lines)].map((line) => ({ line })),
  };
}

function agentConfiguration(startable: Startable) {
  const { configuration } = startable;
  return {
    configuration: startable.configurationDigest,
    name: configuration.name,
    program: configuration.program,
    args: configuration.args.map((argument) => cut(argument, MAX_SHOWN_ARGUMENT_LENGTH).text),
    ...(configuration.cwd === undefined ? {} : { cwd: configuration.cwd }),
    // Names only: a value may be a secret the person typed for the program.
    env: configuration.env.map((entry) => entry.key),
    stopOnEntry: configuration.stopOnEntry,
    source: startable.source,
  };
}

/**
 * What the person reads before a session starts, and the only thing they
 * confirm: the program, its arguments, its folder, and the names of its
 * environment variables. Values are never shown (one may be a secret the
 * person typed for the program), and the arguments are redacted as the
 * listing's are.
 */
function startSummary(startable: Startable): string {
  const { configuration } = startable;
  const shown = (text: string, maximum: number) => {
    const bounded = cut(text, maximum);
    return bounded.cut ? `${bounded.text}… (cut)` : bounded.text;
  };
  const args = redactHostSecretsInValue(configuration.args.join(" "));
  const names = configuration.env.map((entry) => String(entry.key)).join(", ");
  return [
    `Let the agent start the debug session "${configuration.name}"?`,
    `Program: ${shown(String(configuration.program), MAX_SHOWN_PATH_LENGTH)}`,
    `Arguments: ${args.length === 0 ? "none" : shown(args, MAX_SHOWN_ARGUMENT_LENGTH)}`,
    `Working directory: ${
      configuration.cwd === undefined
        ? "the checkout's root"
        : shown(String(configuration.cwd), MAX_SHOWN_PATH_LENGTH)
    }`,
    `Environment variables (values not shown): ${
      names.length === 0 ? "none" : shown(names, MAX_SHOWN_ENVIRONMENT_NAMES_LENGTH)
    }`,
    startable.source === "confirmed"
      ? "From: a configuration confirmed in Run and debug."
      : "From: the repository's launch file; nobody has confirmed it.",
    "It runs under the debugger in this thread's checkout, confined as this thread's terminal is. This one answer covers the session: the agent may step it, read its variables and output, evaluate expressions in it, and stop it. You can stop it in Run and debug.",
  ].join("\n");
}

/**
 * Redacts the whole text before bounding it: a cut through a credential
 * removes the syntax the redactor reads (a URL password cut just before its
 * `@` is no longer a URL password), so cutting first would leave it visible.
 */
function cut(text: string, maximum: number): { readonly text: string; readonly cut: boolean } {
  const redacted = redactHostSecretsInValue(text);
  return redacted.length > maximum
    ? { text: redacted.slice(0, maximum), cut: true }
    : { text: redacted, cut: false };
}

/** The leading entries that fit both the count and the result's byte budget. */
function withinBudget<Entry>(
  entries: ReadonlyArray<Entry>,
  maxCount: number,
): { readonly entries: ReadonlyArray<Entry>; readonly cut: boolean } {
  const kept: Array<Entry> = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (kept.length === maxCount || bytes + size > MAX_RESULT_LIST_BYTES) {
      return { entries: kept, cut: true };
    }
    kept.push(entry);
    bytes += size;
  }
  return { entries: kept, cut: false };
}

function agentVariable(variable: CodeDebugVariable) {
  const value = cut(variable.value, MAX_CODE_DEBUG_AGENT_VALUE_LENGTH);
  return {
    name: variable.name,
    value: value.text,
    ...(variable.truncated || value.cut ? { truncated: true } : {}),
    ...(variable.type === undefined ? {} : { type: variable.type }),
    // Above zero, `variables` with this reference lists what the value holds.
    ...(variable.variablesReference > 0 ? { reference: variable.variablesReference } : {}),
  };
}

/** A session answer as the model reads it, cut to the tool's bounds. */
function sessionAnswer(
  answer: CodeDebugSessionResult,
  context: { readonly started?: string; readonly variablesStart?: number } = {},
): ToolOutcome {
  switch (answer.status) {
    case "state": {
      const output = withinBudget(
        answer.output.map((entry) => {
          const text = cut(entry.text, MAX_CODE_DEBUG_AGENT_OUTPUT_TEXT_LENGTH);
          return {
            sequence: entry.sequence,
            category: entry.category,
            text: text.text,
            ...(text.cut ? { truncated: true } : {}),
          };
        }),
        MAX_CODE_DEBUG_AGENT_OUTPUT_ENTRIES,
      );
      const last = output.entries.at(-1)?.sequence;
      const { state } = answer;
      return {
        result: {
          ...(context.started === undefined ? {} : { started: context.started }),
          session: state.status,
          ...(state.status === "stopped"
            ? {
                thread: state.programThreadId,
                reason: state.reason,
                ...(state.description === undefined ? {} : { description: state.description }),
              }
            : {}),
          ...(state.status === "ended"
            ? {
                endReason: state.endReason,
                ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
              }
            : {}),
          output: output.entries,
          // Pass as afterOutput to read what follows.
          ...(last === undefined ? {} : { lastOutput: last }),
          ...(output.cut ? { moreOutput: true } : {}),
          ...(answer.outputDropped ? { outputDropped: true } : {}),
        },
        isError: false,
        programData: true,
      };
    }
    case "breakpoints":
      return { result: { breakpoints: answer.breakpoints }, isError: false };
    case "threads": {
      const threads = withinBudget(answer.threads, MAX_CODE_DEBUG_AGENT_THREADS);
      return {
        result: { threads: threads.entries, ...(threads.cut ? { truncated: true } : {}) },
        isError: false,
        programData: true,
      };
    }
    case "stack": {
      const frames = withinBudget(
        answer.frames.map((frame) => ({
          frame: frame.id,
          name: frame.name,
          ...(frame.location.kind === "checkout"
            ? {
                path: frame.location.path,
                line: frame.location.line,
                column: frame.location.column,
              }
            : frame.location.kind === "outside-checkout"
              ? { outsideCheckout: frame.location.label }
              : {}),
        })),
        MAX_CODE_DEBUG_AGENT_FRAMES,
      );
      return {
        result: {
          frames: frames.entries,
          ...(frames.cut || answer.truncated ? { truncated: true } : {}),
        },
        isError: false,
        programData: true,
      };
    }
    case "scopes": {
      const scopes = withinBudget(
        answer.scopes.map((scope) => ({
          name: scope.name,
          reference: scope.variablesReference,
          ...(scope.expensive ? { expensive: true } : {}),
        })),
        MAX_CODE_DEBUG_AGENT_SCOPES,
      );
      return {
        result: { scopes: scopes.entries, ...(scopes.cut ? { truncated: true } : {}) },
        isError: false,
        programData: true,
      };
    }
    case "variables": {
      const variables = withinBudget(
        answer.variables.map(agentVariable),
        MAX_CODE_DEBUG_AGENT_VARIABLES,
      );
      const more = variables.cut || answer.truncated;
      return {
        result: {
          variables: variables.entries,
          ...(more
            ? {
                truncated: true,
                // Pass as start to list what follows.
                next: (context.variablesStart ?? 0) + variables.entries.length,
              }
            : {}),
        },
        isError: false,
        programData: true,
      };
    }
    case "evaluated":
      return {
        result: { result: agentVariable(answer.result) },
        isError: false,
        programData: true,
      };
    case "done":
      return { result: { done: true }, isError: false };
    case "ended":
      return { result: { session: "ended", endReason: answer.endReason }, isError: false };
    case "source":
    case "exception":
      // Neither is an operation of this tool.
      return refusedCall("tool-execution-failed", "The debug session answered another request.");
    case "unavailable":
      return {
        // With the adapter's own words (a failed expression's error, say) the
        // answer is the program's side speaking, so it is returned as a
        // result and marked as one: a refusal is never marked.
        result: {
          error:
            answer.reason === "timed-out"
              ? "debug-adapter-timed-out"
              : answer.reason === "ended"
                ? "session-ended"
                : "debug-adapter-failed",
          message:
            answer.reason === "timed-out"
              ? "The debug adapter did not answer in time. Read state, or stop the session."
              : answer.reason === "ended"
                ? "The session ended before the adapter answered."
                : "The debug adapter refused the request.",
          ...(answer.message === undefined
            ? {}
            : { adapterMessage: cut(answer.message, MAX_CODE_DEBUG_AGENT_VALUE_LENGTH).text }),
        },
        ...(answer.message === undefined
          ? { isError: true }
          : { isError: false, programData: true as const }),
      };
    case "refused":
      return serviceRefusal(answer.reason);
  }
}

function notApproved(answer: "denied" | "cancelled" | "expired"): ToolOutcome {
  return answer === "denied"
    ? refusedCall("approval-denied", "The person declined. Continue without the debugger.")
    : refusedCall(
        `approval-${answer}`,
        "The person did not answer. Continue without the debugger, or ask them and try again.",
      );
}

function notStarted(answer: Exclude<CodeDebugStartResult, { status: "started" }>): ToolOutcome {
  if (answer.status === "refused") return serviceRefusal(answer.reason);
  if (answer.status === "busy") {
    return answer.reason === "thread-has-session"
      ? refusedCall(
          "thread-has-session",
          "This thread already runs a debug session. Stop it first.",
        )
      : refusedCall("host-limit", "This host already runs as many debug sessions as it allows.");
  }
  return refusedCall(
    answer.reason,
    answer.reason === "adapter-unverified"
      ? "The installed debug adapter no longer matches what the person reviewed, so nothing ran."
      : answer.reason === "adapter-refused"
        ? "The debug adapter refused to start the program, or did not answer in time."
        : "The debug session could not be launched.",
  );
}

const REFUSAL_MESSAGES: Readonly<Record<CodeDebugRefusalReason, string>> = {
  "no-reach": "This thread cannot reach its checkout from here.",
  "thread-inactive": "This thread is not active, so it debugs nothing.",
  "checkout-mismatch": "This thread's window is now on another checkout.",
  "checkout-unavailable": "This thread's checkout is unavailable right now.",
  "no-debug-adapter": "No debug adapter that is installed and switched on runs this configuration.",
  "unsupported-platform": "Debug sessions run only on macOS and Linux hosts.",
  "mode-prohibited": "Only a Code thread debugs a program.",
  "plan-read-only": "Plan is read-only, so it runs and debugs no program.",
  "local-host-required": "Only this host's own windows and this thread's agent debug a program.",
  "approval-required":
    "The person has neither confirmed this configuration as it stands nor answered for this session.",
  "configuration-invalid":
    "The configuration's program or folder is no longer a file or folder inside the checkout.",
  "confinement-unavailable": "This host cannot confine a debug session, so none runs.",
  "no-session": "This thread runs no debug session. Start one with the start operation.",
};

function serviceRefusal(reason: CodeDebugRefusalReason): ToolOutcome {
  return refusedCall(reason, REFUSAL_MESSAGES[reason]);
}

function refusedCall(error: string, message: string): ToolOutcome {
  return { result: { error, message }, isError: true };
}
