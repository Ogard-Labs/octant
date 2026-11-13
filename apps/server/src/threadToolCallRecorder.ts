import {
  MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS,
  type ProviderRuntimeEvent,
  type ThreadToolCallRecordMode,
} from "@octant/contracts";
import type { SqliteConnection } from "./persistence/sqlitePort";
import { writeThreadToolCallPart } from "./persistence/threadToolCallRecordStore";
import { isProtectedSecretPath } from "./process/secretGuard";
import { redactHostSecrets } from "./process/secretRedaction";

/** Keeps one turn's tool-call records. It never throws: a record is evidence, not the turn. */
export interface ThreadToolCallRecorder {
  /** Folds a runtime event. Every kind but a tool's start and its content is ignored. */
  readonly observe: (event: ProviderRuntimeEvent) => void;
  /** A tool Octant itself ran for the turn, whose input and result it holds whole. */
  readonly appTool: (call: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly inputJson: string;
    readonly resultJson: string;
  }) => void;
}

export type ThreadToolCallRecorders = (turn: {
  readonly mode: ThreadToolCallRecordMode;
  readonly threadId: string;
  /** A Chat attempt id or a Work turn's request id. */
  readonly turnId: string;
  /** The turn's tool-step limit: a call with no row keeps no record. `undefined` is no limit. */
  readonly callLimit: number | undefined;
}) => ThreadToolCallRecorder;

/** How many path-shaped words of one input are judged; the rest of a longer input is not read. */
const MAX_JUDGED_PATHS = 256;
const PATH_SHAPED = /^(?:\/|~(?:\/|$)|\$HOME(?:\/|$)|\$\{HOME\}(?:\/|$))/;

/**
 * Whether a tool call's input names a protected secret file: a shell command
 * or a JSON input, read word by word. Only absolute and home-rooted paths can
 * be judged; a relative path depends on a working directory the record does
 * not know. This decides what the record keeps and nothing else: the secret
 * guard still refuses or allows the call exactly as it did.
 */
export function textNamesProtectedPath(
  text: string,
  protectedPath: (path: string) => boolean,
): boolean {
  let judged = 0;
  for (const word of decodedStrings(text).split(/[\s"'`=,;:()[\]<>|&]+/)) {
    if (!PATH_SHAPED.test(word)) continue;
    if (protectedPath(word)) return true;
    judged += 1;
    if (judged >= MAX_JUDGED_PATHS) return false;
  }
  return false;
}

/**
 * A JSON input's string values as the tool receives them. Judged raw, a
 * command's newline is the two characters `\\n` and stays glued to the path
 * before it, so `cat ~/.docker/config.json` followed by a second line named
 * no protected file. Text that is not JSON is judged as it is.
 */
function decodedStrings(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const strings: string[] = [];
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) pending.push(...value);
    else if (typeof value === "object" && value !== null)
      pending.push(...Object.keys(value), ...Object.values(value));
  }
  return strings.join("\n");
}

/**
 * Makes the recorder for each Chat attempt or Work turn. `enabled` is the
 * host setting, read at every write so turning it off stops a running turn's
 * records too.
 */
export function threadToolCallRecorders(options: {
  readonly connection: SqliteConnection;
  readonly enabled: () => boolean;
  readonly clock: () => string;
  /** Test seam. Production asks the secret guard's list in force. */
  readonly namesProtectedPath?: (text: string) => boolean;
}): ThreadToolCallRecorders {
  const namesProtectedPath =
    options.namesProtectedPath ??
    ((text: string) => textNamesProtectedPath(text, (path) => isProtectedSecretPath(path)));
  return (turn) => {
    // `tool-call-content` names only the call; its start named the tool.
    const toolNames = new Map<string, string>();
    const write = (call: {
      readonly toolCallId: string;
      readonly part: "input" | "output";
      readonly text: string;
      readonly truncated: boolean;
    }) => {
      try {
        if (!options.enabled() || call.text === "") return;
        const toolName = toolNames.get(call.toolCallId);
        writeThreadToolCallPart(options.connection, {
          mode: turn.mode,
          threadId: turn.threadId,
          turnId: turn.turnId,
          callsPerTurn: turn.callLimit,
          toolCallId: call.toolCallId,
          ...(toolName === undefined ? {} : { toolName }),
          part: call.part,
          text: call.text,
          truncated: call.truncated,
          recordedAt: options.clock(),
          // The driver boundary already redacted a runtime's events; a tool
          // Octant ran reaches the store only through here.
          redact: redactHostSecrets,
          namesProtectedPath,
        });
      } catch {
        // The turn's own result does not depend on its record.
      }
    };
    const bounded = (text: string) =>
      text.length <= MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS
        ? { text, truncated: false }
        : { text: text.slice(0, MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS), truncated: true };
    return {
      observe: (event) => {
        if (event.kind === "tool-start") {
          toolNames.set(event.toolCallId, event.toolName);
          return;
        }
        if (event.kind !== "tool-call-content") return;
        write({
          toolCallId: event.toolCallId,
          part: event.part,
          text: event.text,
          truncated: event.truncated === true,
        });
      },
      appTool: (call) => {
        toolNames.set(call.toolCallId, call.toolName);
        write({ toolCallId: call.toolCallId, part: "input", ...bounded(call.inputJson) });
        write({ toolCallId: call.toolCallId, part: "output", ...bounded(call.resultJson) });
      },
    };
  };
}
