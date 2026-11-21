import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { redactHostRuntimeText } from "./redaction";

/**
 * Last-resort process error net shared by the server (`host`) and the Electron
 * main process (`desktop`).
 *
 * Once an unhandled error event (`uncaughtException` or `unhandledRejection`)
 * reaches the process boundary, in-memory state is undefined. The net logs a
 * bounded, secret-redacted cause synchronously and ends the process with a
 * non-zero exit code so its supervisor (desktop, launchd, systemd) restarts it
 * cleanly rather than leaving it hung or corrupted.
 *
 * This is the only shipped module permitted to register `uncaughtException` or
 * `unhandledRejection` listeners; `bun run style:check` refuses ad-hoc
 * registrations everywhere else.
 */
export type ProcessErrorNetProcess = "host" | "desktop";
export type ProcessErrorNetKind = "uncaughtException" | "unhandledRejection";

export interface ProcessErrorNetEvent {
  readonly kind: ProcessErrorNetKind;
  readonly process: ProcessErrorNetProcess;
  readonly timestamp: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  /** Formatted redacted summary plus bounded stack frames ready for stderr or crash records. */
  readonly line: string;
}

export interface ProcessErrorNetTarget {
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

export interface ProcessErrorNetStdioStream {
  on(event: "error", listener: (error: unknown) => void): unknown;
  off(event: "error", listener: (error: unknown) => void): unknown;
}

export interface ReviewedBenignTeardownError {
  readonly id: string;
  readonly reason: string;
  readonly matches: (error: unknown) => boolean;
}

/**
 * Closed, reviewed list of benign teardown errors that may settle asynchronously
 * after the process has already begun an explicit shutdown.
 *
 * Every entry applies ONLY when `isShuttingDown()` is true; outside explicit
 * shutdown, every unhandled error event exits non-zero. Child-process stream
 * errors such as `stdin` `EPIPE` are deliberately excluded here — they must
 * route to their owning transport's cleanup rather than reaching this net.
 */
export const REVIEWED_BENIGN_TEARDOWN_ERRORS: ReadonlyArray<ReviewedBenignTeardownError> = [
  {
    id: "ipc-channel-closed",
    reason:
      "Node/Electron child IPC channel closed while an in-flight teardown message settled after process shutdown began.",
    matches: (error) => errorCodeOf(error) === "ERR_IPC_CHANNEL_CLOSED",
  },
  {
    id: "electron-destroyed-object",
    reason:
      "Electron native window or frame wrapper was already destroyed while a late shutdown callback settled.",
    matches: (error) =>
      error instanceof Error &&
      (error.message.includes("Object has been destroyed") ||
        error.message.includes("Render frame was disposed")),
  },
];

export interface ProcessErrorNetOptions {
  readonly processName: ProcessErrorNetProcess;
  /** Additional redactor (for example, the server's broker-issued secret set). */
  readonly redact?: (text: string) => string;
  /** Home directory replaced with `~` in logged messages and stack frames. Defaults to `homedir()`. */
  readonly homeDirectory?: string;
  /** Returns true only while the process is already performing an explicit shutdown. */
  readonly isShuttingDown?: () => boolean;
  /** Best-effort synchronous hook invoked before exit (for example, writing a local crash record). */
  readonly onFatal?: (event: ProcessErrorNetEvent) => void;
  /** Diagnostic hook invoked when a reviewed benign teardown error is absorbed during shutdown. */
  readonly onIgnoredTeardownError?: (event: ProcessErrorNetEvent, reason: string) => void;
  /** Writes the formatted diagnostic text. Defaults to a synchronous, EPIPE-safe write to fd 2. */
  readonly writeLine?: (line: string) => void;
  /** Terminates the process. Defaults to `process.exit(code)`. */
  readonly exit?: (code: number) => void;
  /** Process emitter to attach to. Defaults to `process`. */
  readonly target?: ProcessErrorNetTarget;
  /**
   * Process-owned standard output/error streams whose own `EPIPE` (closed parent
   * terminal or pipe) is absorbed on the stream itself without ignoring `EPIPE`
   * globally in `uncaughtException`. Defaults to `[process.stdout, process.stderr]`.
   */
  readonly stdioStreams?: ReadonlyArray<ProcessErrorNetStdioStream>;
  readonly now?: () => Date;
  readonly exitCode?: number;
}

export interface ProcessErrorNetHandle {
  readonly uninstall: () => void;
}

const MESSAGE_LIMIT = 300;
const STACK_FRAME_LIMIT = 3;
const STACK_LINE_LIMIT = 180;

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function sweepText(
  text: string,
  homeDirectory: string | undefined,
  redact: ((text: string) => string) | undefined,
  limit: number,
): string {
  const custom = redact === undefined ? text : redact(text);
  const home = homeDirectory === undefined ? undefined : withoutTrailingSlashes(homeDirectory);
  const local = home === undefined || home.length < 2 ? custom : custom.split(home).join("~");
  return redactHostRuntimeText(local).slice(0, limit);
}

function safeWriteStderrSync(text: string): void {
  try {
    writeSync(2, Buffer.from(`${text}\n`, "utf8"));
  } catch {
    // A closed or non-writable stderr pipe must never throw inside the crash path.
  }
}

function formatEvent(
  kind: ProcessErrorNetKind,
  processName: ProcessErrorNetProcess,
  error: unknown,
  timestamp: string,
  homeDirectory: string | undefined,
  redact: ((text: string) => string) | undefined,
): ProcessErrorNetEvent {
  const code = errorCodeOf(error);
  const rawMessage =
    error instanceof Error
      ? `${error.name || "Error"}: ${error.message || "(no message)"}`
      : typeof error === "string"
        ? error
        : String(error);
  const message = sweepText(
    rawMessage.replace(/[\r\n]+/g, " ").trim() || "Unknown error",
    homeDirectory,
    redact,
    MESSAGE_LIMIT,
  );
  const stackLines =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
          .split("\n")
          .slice(1)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(0, STACK_FRAME_LIMIT)
          .map((line) => sweepText(line, homeDirectory, redact, STACK_LINE_LIMIT))
      : [];
  const codeSuffix =
    code === undefined ? "" : ` (code=${sweepText(code, homeDirectory, redact, 64)})`;
  const header = `[octant:${processName}] fatal ${kind} (${timestamp}): ${message}${codeSuffix}`;
  // Total output stays within 4 lines so the desktop's 5-line / 1,000-char
  // stderr tail retains both the summary header and the top stack frames.
  const line = stackLines.length === 0 ? header : `${header}\n${stackLines.join("\n")}`;
  return {
    kind,
    process: processName,
    timestamp,
    message,
    ...(code === undefined ? {} : { code }),
    ...(stackLines.length === 0 ? {} : { stack: stackLines.join("\n") }),
    line,
  };
}

function reviewedBenignTeardownReason(error: unknown): string | undefined {
  for (const rule of REVIEWED_BENIGN_TEARDOWN_ERRORS) {
    if (rule.matches(error)) return `${rule.id}: ${rule.reason}`;
  }
  return undefined;
}

export function installProcessErrorNet(options: ProcessErrorNetOptions): ProcessErrorNetHandle {
  const target: ProcessErrorNetTarget = options.target ?? process;
  const writeLine = options.writeLine ?? safeWriteStderrSync;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? (() => new Date());
  const exitCode = options.exitCode ?? 1;
  const homeDirectory = options.homeDirectory ?? safeHomedir();
  const stdioStreams: ReadonlyArray<ProcessErrorNetStdioStream> = options.stdioStreams ?? [
    process.stdout,
    process.stderr,
  ];

  let fatalHandled = false;

  const handle = (kind: ProcessErrorNetKind, error: unknown): void => {
    if (fatalHandled) return;
    let shuttingDown = false;
    try {
      shuttingDown = options.isShuttingDown?.() === true;
    } catch {
      shuttingDown = false;
    }
    if (shuttingDown) {
      const benignReason = reviewedBenignTeardownReason(error);
      if (benignReason !== undefined) {
        try {
          const event = formatEvent(
            kind,
            options.processName,
            error,
            now().toISOString(),
            homeDirectory,
            options.redact,
          );
          writeLine(
            `[octant:${options.processName}] ignored teardown ${kind} (${event.timestamp}): ${event.message}`,
          );
          options.onIgnoredTeardownError?.(event, benignReason);
        } catch {
          // Diagnostic reporting during teardown must never re-enter the net.
        }
        return;
      }
    }

    fatalHandled = true;
    try {
      const event = formatEvent(
        kind,
        options.processName,
        error,
        now().toISOString(),
        homeDirectory,
        options.redact,
      );
      try {
        writeLine(event.line);
      } catch {
        // Logging failure must never stop the process from exiting.
      }
      try {
        options.onFatal?.(event);
      } catch {
        // Fatal hooks are best-effort; exiting non-zero remains mandatory.
      }
    } catch {
      // Even if formatting/redaction threw, still exit non-zero below.
    }
    exit(exitCode);
  };

  const onUncaughtException = (error: unknown): void => handle("uncaughtException", error);
  const onUnhandledRejection = (reason: unknown): void => handle("unhandledRejection", reason);
  const onStdioError = (error: unknown): void => {
    // A closed terminal or parent pipe emits EPIPE on process.stdout/stderr
    // during diagnostic logging. Absorb only that stream's own EPIPE so logging
    // never crashes the process while child-stream EPIPE still routes normally.
    if (errorCodeOf(error) === "EPIPE") return;
    handle("uncaughtException", error);
  };

  target.on("uncaughtException", onUncaughtException);
  target.on("unhandledRejection", onUnhandledRejection);
  for (const stream of stdioStreams) {
    stream.on("error", onStdioError);
  }

  return {
    uninstall: () => {
      target.off("uncaughtException", onUncaughtException);
      target.off("unhandledRejection", onUnhandledRejection);
      for (const stream of stdioStreams) {
        stream.off("error", onStdioError);
      }
    },
  };
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}
