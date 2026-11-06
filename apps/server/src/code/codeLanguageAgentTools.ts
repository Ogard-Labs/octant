import {
  CODE_LANGUAGE_TOOL_DEFINITION,
  CODE_LANGUAGE_TOOL_NAME,
  MAX_CODE_LANGUAGE_AGENT_REFERENCES,
  decodeCodeLanguageToolArguments,
  decodeToolActionRequest,
  type CodeLanguageDefinitionTarget,
  type CodeLanguageDiagnostic,
  type CodeLanguageRange,
  type CodeLanguageToolArguments,
  type CodeThread,
  type ToolActionAuthority,
  type ToolActionRequest,
  type WindowId,
} from "@octant/contracts";
import { isToolAllowedByAllowlist } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import type { CodeLanguageAgentReadResult, CodeLanguageService } from "./codeLanguageService";

/**
 * The language server's reads as one app-managed tool for a Code turn,
 * `octant_code`: the diagnostics of one saved file, where a name in it is
 * defined, and where that name is used. Canonical:
 * docs/design/language-services.md (decision D5).
 *
 * It is offered only where a read can be answered: some server an agent may
 * start covers a file of the turn's checkout. Each call is decoded against
 * its closed-catalog argument schema, wrapped as a `ToolActionRequest` under
 * the thread's authority as it stands, and authorized by the tool-call choke
 * point before the language service runs. The service then checks the read
 * as it checks an editor's, on the turn's window. Every operation is
 * `project-file-reads`, so Plan keeps them and no posture asks; nothing here
 * writes, runs, or reaches the network.
 */

const MAX_TOOL_INPUT_BYTES = 4 * 1024;
/**
 * The most bytes one result's list of places or diagnostics may serialize to.
 * A Code turn replaces any tool result over 64 KiB with a bare
 * `tool-result-too-large` (codeTurnRunner), which tells the model nothing and
 * repeats on a retry, so a count bound alone is not enough: 200 references to
 * one 310-character path already serialize to about 72 KiB. 48 KiB leaves a
 * 16 KiB margin for the rest of the result, whose largest part is the echoed
 * path, itself under the 4 KiB input bound.
 */
const MAX_RESULT_LIST_BYTES = 48 * 1024;
const STALE_MESSAGE =
  "This thread no longer holds the authority the read needs. Continue without it and say so.";

export interface CodeLanguageAgentToolsOptions {
  readonly windowId: WindowId;
  /** The thread as the turn started; its checkout is the one the reads name. */
  readonly thread: CodeThread;
  /** The turn's checkout root and extra folders, the files the reads can name. */
  readonly folders: ReadonlyArray<string>;
  /** The thread as the window sees it when a call runs, or undefined once it cannot. */
  readonly readThread: () => CodeThread | undefined;
  /** The authority the thread holds now; undefined means it speaks for nothing. */
  readonly authority: () => ToolActionAuthority | undefined;
  readonly externalContentIngested: () => boolean;
  readonly language: Pick<CodeLanguageService, "readForAgent" | "servesAgentsIn">;
  readonly uuid: () => string;
}

type ToolOutcome = { readonly result: unknown; readonly isError: boolean };

/**
 * The tool for one Code turn, or nothing when a profile leaves it out or no
 * server an agent may start covers a file of the checkout. A repository no
 * server reads would only ever be answered `no-language-server` or
 * `turned-off`, so the model is not handed a tool that cannot help it.
 */
export function createCodeLanguageAgentTools(
  options: CodeLanguageAgentToolsOptions,
): AppManagedToolSet | undefined {
  const allowlist = options.thread.toolConstraints ?? [];
  if (!isToolAllowedByAllowlist(allowlist, CODE_LANGUAGE_TOOL_NAME)) return undefined;
  if (!options.language.servesAgentsIn(options.folders)) return undefined;
  const gate = new ToolCallAuthorityService({
    resolveGrantedAuthority: () => options.authority(),
    resolveLiveFacts: () => {
      const current = options.readThread() ?? options.thread;
      return {
        // The set is composed only for a provider that carries app-managed tools.
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: false },
        executionPolicy: current.executionPolicy,
        approvalSatisfied: false,
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

  return {
    definitions: [CODE_LANGUAGE_TOOL_DEFINITION],
    execute: async ({ name, inputJson, signal }) => {
      if (signal?.aborted === true) return refused("tool-interrupted", "The turn was stopped.");
      if (name !== CODE_LANGUAGE_TOOL_NAME) {
        return refused("tool-unavailable", `${name} is not offered on this turn.`);
      }
      const call = parseCall(inputJson);
      if (call === undefined) {
        return refused(
          "invalid-tool-input",
          "Give an operation (diagnostics, definition, or references), a file of the checkout by its path relative to the root, such as src/index.ts, and for definition and references a line and column counted from 1.",
        );
      }
      const capabilityId = "code-language";
      const current = options.readThread();
      const authority = options.authority();
      if (current === undefined || authority === undefined) {
        return refused("tool-authority-stale", STALE_MESSAGE);
      }
      let request: ToolActionRequest;
      try {
        request = decodeToolActionRequest({
          actionId: options.uuid(),
          correlationId: options.uuid(),
          capability: { id: capabilityId, version: 1 },
          authority,
          intent: `${capabilityId} ${call.operation}: ${call.path}`,
          approval: { kind: "not-required" },
        });
      } catch {
        return refused("tool-authority-stale", STALE_MESSAGE);
      }
      const decision = gate.authorize({
        threadId: String(options.thread.id),
        request,
        arguments: call,
      });
      // A read never asks, so a prompt here is a policy this tool does not
      // expect; it is refused rather than answered.
      if (decision.kind !== "allow") {
        return refused(
          "tool-refused",
          decision.kind === "deny" && decision.reason.startsWith("Profile ")
            ? decision.reason
            : `The read was refused by policy (${decision.reason}).`,
        );
      }
      const scope = {
        threadId: options.thread.id,
        checkoutId: options.thread.checkoutId,
      };
      if (call.operation === "diagnostics") {
        const answer = await options.language.readForAgent(options.windowId, {
          kind: "diagnostics",
          ...scope,
          path: call.path,
        });
        if (answer.status !== "diagnostics") return unanswered(answer);
        const diagnostics = withinBudget(answer.diagnostics.map(agentDiagnostic));
        return {
          result: {
            path: call.path,
            diagnostics: diagnostics.entries,
            truncated: answer.truncated || diagnostics.cut,
          },
          isError: false,
        };
      }
      const position = { line: call.line - 1, character: call.column - 1 };
      if (call.operation === "definition") {
        const answer = await options.language.readForAgent(options.windowId, {
          kind: "definition",
          ...scope,
          path: call.path,
          position,
        });
        if (answer.status !== "definition") return unanswered(answer);
        return {
          result: {
            path: call.path,
            line: call.line,
            column: call.column,
            definitions: answer.targets.map(agentDefinition),
          },
          isError: false,
        };
      }
      const answer = await options.language.readForAgent(options.windowId, {
        kind: "references",
        ...scope,
        path: call.path,
        position,
        includeDeclaration: call.includeDeclaration === true,
      });
      if (answer.status !== "references") return unanswered(answer);
      const references = withinBudget(
        answer.targets.slice(0, MAX_CODE_LANGUAGE_AGENT_REFERENCES + 1).map(agentDefinition),
        MAX_CODE_LANGUAGE_AGENT_REFERENCES,
      );
      return {
        result: {
          path: call.path,
          line: call.line,
          column: call.column,
          references: references.entries,
          truncated: answer.truncated || references.cut,
        },
        isError: false,
      };
    },
  };
}

/** The call's arguments under the same schema the closed catalog decodes them with. */
function parseCall(inputJson: string): CodeLanguageToolArguments | undefined {
  if (Buffer.byteLength(inputJson, "utf8") > MAX_TOOL_INPUT_BYTES) return undefined;
  try {
    return decodeCodeLanguageToolArguments(JSON.parse(inputJson));
  } catch {
    return undefined;
  }
}

/**
 * The leading entries that fit both `maxCount` and the result's byte budget;
 * `cut` says either bound left one out.
 */
function withinBudget<Entry>(
  entries: ReadonlyArray<Entry>,
  maxCount: number = entries.length,
): { readonly entries: ReadonlyArray<Entry>; readonly cut: boolean } {
  const kept: Array<Entry> = [];
  let bytes = 0;
  for (const entry of entries) {
    // One byte more for the comma that separates it from the entry before.
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (kept.length === maxCount || bytes + size > MAX_RESULT_LIST_BYTES) {
      return { entries: kept, cut: true };
    }
    kept.push(entry);
    bytes += size;
  }
  return { entries: kept, cut: false };
}

function agentRange(range: CodeLanguageRange) {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function agentDiagnostic(diagnostic: CodeLanguageDiagnostic) {
  return {
    ...agentRange(diagnostic.range),
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
  };
}

function agentDefinition(target: CodeLanguageDefinitionTarget) {
  return target.kind === "checkout-location"
    ? { path: target.path, ...agentRange(target.range) }
    : { outsideCheckout: target.label };
}

/** Every answer that is not the read's result, as a refusal the model can act on. */
function unanswered(answer: CodeLanguageAgentReadResult): ToolOutcome {
  switch (answer.status) {
    case "unsupported":
      return answer.support === "unknown"
        ? refused(
            "language-server-starting",
            "The language server has not yet said whether it can find where names are used. Call the tool again in a few seconds.",
          )
        : refused(
            "references-unsupported",
            "This file's language server cannot find where names are used. Search the checkout for the name instead.",
          );
    case "stale":
      return refused(
        "file-changed",
        "The file or its language server changed while the server answered. Call the tool again.",
      );
    case "diagnostics":
    case "definition":
    case "references":
    case "capabilities":
      return refused("tool-execution-failed", "The language server answered another read.");
    case "too-large":
      return refused("too-large", "The file is too large for the language server.");
    case "unsaved-edits":
      return refused(
        "unsaved-edits",
        "The file is open in an editor with text that is not saved, so the server's answer would not match the saved file. Read it again once it is saved, or continue without it.",
      );
    case "unavailable":
      return answer.reason === "starting"
        ? refused(
            "language-server-starting",
            "The language server is starting for this checkout. Call the tool again in a few seconds.",
          )
        : answer.reason === "crashed"
          ? refused(
              "language-server-crashed",
              "The language server stopped. The person can restart it from the editor; continue without it.",
            )
          : refused(
              "language-server-timed-out",
              "The language server did not answer in time. Try once more, or continue without it.",
            );
    case "refused":
      return refused(answer.reason, REFUSAL_MESSAGES[answer.reason]);
  }
}

const REFUSAL_MESSAGES: Readonly<
  Record<Extract<CodeLanguageAgentReadResult, { status: "refused" }>["reason"], string>
> = {
  "thread-inactive": "This thread is not active, so it cannot read its checkout.",
  "checkout-unavailable": "This thread's checkout is unavailable right now.",
  "checkout-mismatch": "This thread's window is now on another checkout.",
  "file-outside-thread": "The file is not one this thread can read.",
  "path-outside-checkout": "The path is not a file inside this thread's checkout.",
  "no-reach": "This thread cannot read its checkout from here.",
  "turned-off": "Language services are turned off in Settings › Code.",
  "no-language-server": "No language server reads this kind of file.",
  "confinement-unavailable":
    "The host cannot confine a language server, so none runs. Continue without it.",
  "unsupported-platform": "Language services run only on macOS and Linux hosts.",
  "plan-read-only":
    "The language server for this file runs repository tooling, which Plan refuses.",
  "local-host-required":
    "The language server for this file runs repository tooling, which only the person at the machine can start.",
  "approval-required": "The language server for this file needs the person's approval to start.",
};

function refused(error: string, message: string): ToolOutcome {
  return { result: { error, message }, isError: true };
}
