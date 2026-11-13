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

/**
 * How many path-shaped words of one input are judged. An input that names more
 * is treated as naming a protected file: the unread rest could hide one, so
 * its output is withheld rather than judged safe.
 */
const MAX_JUDGED_PATHS = 256;
const PATH_SHAPED = /^(?:\/|~(?:\/|$)|\$HOME(?:\/|$)|\$\{HOME\}(?:\/|$))/;

/**
 * Whether a tool call's input names a protected secret file: a shell command
 * or a JSON input, read word by word. Only absolute and home-rooted paths can
 * be judged; a relative path depends on a working directory the record does
 * not know. This decides what the record keeps and nothing else: the secret
 * guard still refuses or allows the call exactly as it did.
 *
 * A path may contain spaces (`~/Library/Application Support/...`), which the
 * word split cuts apart, so each whole string value and each quote-aware shell
 * word is judged as well as the plain words.
 */
export function textNamesProtectedPath(
  text: string,
  protectedPath: (path: string) => boolean,
): boolean {
  let judged = 0;
  for (const value of decodedStrings(text)) {
    const candidates = [
      value.trim(),
      ...shellWords(value),
      ...value.split(/[\s"'`=,;:()[\]<>|&]+/),
    ];
    for (const word of candidates) {
      if (!PATH_SHAPED.test(word)) continue;
      if (protectedPath(word)) return true;
      judged += 1;
      if (judged >= MAX_JUDGED_PATHS) return true;
    }
  }
  return false;
}

/**
 * A command's words as a POSIX shell reads them: '...' and "..." keep their
 * spaces, and a backslash keeps the next character. Only for judging paths;
 * expansions are left as written.
 */
function shellWords(command: string): ReadonlyArray<string> {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command.charAt(index);
      } else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\" && index + 1 < command.length) {
      index += 1;
      word += command.charAt(index);
      started = true;
    } else if (/[\s;|&<>()]/.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * A JSON input's string values as the tool receives them. Judged raw, a
 * command's newline is the two characters `\\n` and stays glued to the path
 * before it, so `cat ~/.docker/config.json` followed by a second line named
 * no protected file. Text that is not JSON is judged as it is.
 */
function decodedStrings(text: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [text];
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
  return strings;
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
    // Each call's verdict on its whole input, held here for the life of the
    // turn because the store may evict the input's row (the thread's byte
    // total) before the call returns. An output is kept only for a call whose
    // verdict is "safe": an input that was cut, arrived while recording was
    // off, named more paths than are judged, or never arrived leaves the
    // output unjudged, and an unjudged output is withheld like a protected one.
    const verdicts = new Map<string, "safe" | "withheld">();
    const judge = (toolCallId: string, text: string, truncated: boolean) => {
      let safe = false;
      try {
        safe =
          options.enabled() &&
          !truncated &&
          verdicts.get(toolCallId) !== "withheld" &&
          !namesProtectedPath(text);
      } catch {
        // A judgement that failed is no verdict, so the output stays withheld.
      }
      verdicts.set(toolCallId, safe ? "safe" : "withheld");
    };
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
          ...(call.part === "output"
            ? { withholdOutput: verdicts.get(call.toolCallId) !== "safe" }
            : {}),
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
        if (event.part === "input") judge(event.toolCallId, event.text, event.truncated === true);
        write({
          toolCallId: event.toolCallId,
          part: event.part,
          text: event.text,
          truncated: event.truncated === true,
        });
      },
      appTool: (call) => {
        toolNames.set(call.toolCallId, call.toolName);
        // Judged whole before the cut, so a path past it still counts.
        judge(call.toolCallId, call.inputJson, false);
        write({ toolCallId: call.toolCallId, part: "input", ...bounded(call.inputJson) });
        write({ toolCallId: call.toolCallId, part: "output", ...bounded(call.resultJson) });
      },
    };
  };
}
