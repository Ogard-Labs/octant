import {
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
  type NativeHarnessGrepArguments,
  type NativeHarnessJournalLookupRequest,
  type NativeHarnessJournalLookupResult,
  type NativeHarnessReadArguments,
  type NativeHarnessSecondOpinionArguments,
  type NativeHarnessTodoItem,
  type NativeHarnessTodoWriteArguments,
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

const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const MAX_SHELL_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_FETCH_TEXT_BYTES = 128 * 1024;

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

export type NativeHarnessDelegateStart =
  | { readonly status: "accepted"; readonly runId: string; readonly lifecycleStatus: string }
  | { readonly status: "refused"; readonly reason: string; readonly message?: string };

export interface NativeHarnessDelegateChild {
  readonly runId: string;
  readonly role: string;
  readonly task: string;
  readonly lifecycleStatus: string;
  readonly resultAvailable: boolean;
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
  start(input: {
    readonly role: "research" | "implementation" | "review" | "custom";
    readonly task: string;
    readonly includeParentContext: boolean;
  }): Promise<NativeHarnessDelegateStart>;
  status(): Promise<ReadonlyArray<NativeHarnessDelegateChild>>;
  collect(runId: string): Promise<NativeHarnessDelegateCollect>;
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
}

const decodeRequest = decodeToolActionRequest;
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
  return {
    definitions: offered,
    execute: async ({ name, inputJson, signal }) => {
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
        return refused(
          "invalid-tool-input",
          `The ${name} arguments do not match the tool's schema.`,
        );
      }
      const authority = options.resolveAuthority();
      if (authority === undefined) return refused("tool-authority-stale");
      const capabilityId = nativeHarnessToolCapabilityId(name);
      let request: ToolActionRequest;
      try {
        request = decodeRequest({
          actionId: options.uuid(),
          correlationId: options.uuid(),
          capability: { id: capabilityId, version: 1 },
          authority,
          intent: intentFor(name, args),
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
        return refused(
          "approval-required",
          `The ${name} tool needs approval (${decision.policy.approvalClass}) under the thread's current access posture.`,
        );
      }
      try {
        return await execute(name, args, options.ports, signal);
      } catch {
        return refused("tool-execution-failed");
      }
    },
  };
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
      if (input.operation === "start") {
        const started = await port.start({
          role: input.role,
          task: input.task,
          includeParentContext: input.includeParentContext === true,
        });
        return started.status === "accepted"
          ? ok(started)
          : refused(started.reason, started.message);
      }
      if (input.operation === "status") {
        return ok({ children: await port.status() });
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
  }
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
