import {
  CODE_DEFINITION_TOOL_NAME,
  CODE_DIAGNOSTICS_TOOL_NAME,
  CODE_LANGUAGE_TOOL_DEFINITIONS,
  decodeCodeDefinitionToolArguments,
  decodeCodeDiagnosticsToolArguments,
  decodeToolActionRequest,
  type CodeDefinitionToolArguments,
  type CodeDiagnosticsToolArguments,
  type CodeLanguageDefinitionTarget,
  type CodeLanguageDiagnostic,
  type CodeLanguageRange,
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
 * The language server's reads as app-managed tools for a Code turn: the
 * diagnostics of one saved file, and where a name in it is defined.
 * Canonical: docs/design/language-services.md (decision D5).
 *
 * Each call is decoded against its closed-catalog argument schema, wrapped as
 * a `ToolActionRequest` under the thread's authority as it stands, and
 * authorized by the tool-call choke point before the language service runs.
 * The service then checks the read as it checks an editor's, on the turn's
 * window. Both reads are `project-file-reads`, so Plan keeps them and no
 * posture asks; nothing here writes, runs, or reaches the network.
 */

const MAX_TOOL_INPUT_BYTES = 4 * 1024;
const STALE_MESSAGE =
  "This thread no longer holds the authority the read needs. Continue without it and say so.";

export interface CodeLanguageAgentToolsOptions {
  readonly windowId: WindowId;
  /** The thread as the turn started; its checkout is the one the reads name. */
  readonly thread: CodeThread;
  /** The thread as the window sees it when a call runs, or undefined once it cannot. */
  readonly readThread: () => CodeThread | undefined;
  /** The authority the thread holds now; undefined means it speaks for nothing. */
  readonly authority: () => ToolActionAuthority | undefined;
  readonly externalContentIngested: () => boolean;
  readonly language: Pick<CodeLanguageService, "readForAgent">;
  readonly uuid: () => string;
}

type ToolOutcome = { readonly result: unknown; readonly isError: boolean };

export function createCodeLanguageAgentTools(
  options: CodeLanguageAgentToolsOptions,
): AppManagedToolSet {
  const allowlist = options.thread.toolConstraints ?? [];
  const offered = CODE_LANGUAGE_TOOL_DEFINITIONS.filter((definition) =>
    isToolAllowedByAllowlist(allowlist, definition.name),
  );
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
    definitions: offered,
    execute: async ({ name, inputJson, signal }) => {
      if (signal?.aborted === true) return refused("tool-interrupted", "The turn was stopped.");
      if (!offered.some((definition) => definition.name === name)) {
        return refused("tool-unavailable", `${name} is not offered on this turn.`);
      }
      const call = parseCall(name, inputJson);
      if (call === undefined) {
        return refused(
          "invalid-tool-input",
          "Name a file of the checkout by its path relative to the root, such as src/index.ts, and give a line and column counted from 1.",
        );
      }
      const capabilityId = call.kind === "diagnostics" ? "code-diagnostics" : "code-definition";
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
          intent: `${capabilityId}: ${call.args.path}`,
          approval: { kind: "not-required" },
        });
      } catch {
        return refused("tool-authority-stale", STALE_MESSAGE);
      }
      const decision = gate.authorize({
        threadId: String(options.thread.id),
        request,
        arguments: call.args,
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
      if (call.kind === "diagnostics") {
        const input = call.args;
        const answer = await options.language.readForAgent(options.windowId, {
          kind: "diagnostics",
          ...scope,
          path: input.path,
        });
        if (answer.status !== "diagnostics") return unanswered(answer);
        return {
          result: {
            path: input.path,
            diagnostics: answer.diagnostics.map(agentDiagnostic),
            truncated: answer.truncated,
          },
          isError: false,
        };
      }
      const input = call.args;
      const answer = await options.language.readForAgent(options.windowId, {
        kind: "definition",
        ...scope,
        path: input.path,
        position: { line: input.line - 1, character: input.column - 1 },
      });
      if (answer.status !== "definition") return unanswered(answer);
      return {
        result: {
          path: input.path,
          line: input.line,
          column: input.column,
          definitions: answer.targets.map(agentDefinition),
        },
        isError: false,
      };
    },
  };
}

type ParsedCall =
  | { readonly kind: "diagnostics"; readonly args: CodeDiagnosticsToolArguments }
  | { readonly kind: "definition"; readonly args: CodeDefinitionToolArguments };

/** The call's arguments under the same schema the closed catalog decodes them with. */
function parseCall(name: string, inputJson: string): ParsedCall | undefined {
  if (Buffer.byteLength(inputJson, "utf8") > MAX_TOOL_INPUT_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(inputJson);
    if (name === CODE_DIAGNOSTICS_TOOL_NAME) {
      return { kind: "diagnostics", args: decodeCodeDiagnosticsToolArguments(value) };
    }
    if (name === CODE_DEFINITION_TOOL_NAME) {
      return { kind: "definition", args: decodeCodeDefinitionToolArguments(value) };
    }
    return undefined;
  } catch {
    return undefined;
  }
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
    case "diagnostics":
    case "definition":
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
