import { createHash } from "node:crypto";
import type { ComputerUseNativeAdapter } from "./computerUseRuntime";

export interface ComputerUseProcessPort {
  readonly run: (input: {
    readonly executable: string;
    readonly arguments: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly reconcile?: () => Promise<void>;
}

export class MacOsComputerUseAdapterError extends Error {
  override readonly name = "MacOsComputerUseAdapterError";

  constructor(
    readonly category: "unavailable" | "invalid" | "process-died",
    message: string,
  ) {
    super(message);
  }
}

export function createMacOsComputerUseAdapter(options: {
  readonly process: ComputerUseProcessPort;
  readonly platform?: NodeJS.Platform;
}): ComputerUseNativeAdapter {
  const platform = options.platform ?? process.platform;
  const requireMacOs = (): void => {
    if (platform !== "darwin") {
      throw new MacOsComputerUseAdapterError(
        "unavailable",
        "Native computer use is available only on the authoritative macOS host.",
      );
    }
  };
  return {
    observe: async (request, signal) => {
      requireMacOs();
      if (request.target === undefined) {
        throw new MacOsComputerUseAdapterError(
          "invalid",
          "Computer-use accessibility target is required.",
        );
      }
      const result = await options.process.run({
        executable: "/usr/bin/osascript",
        arguments: ["-l", "JavaScript", "-e", OBSERVE_SCRIPT, "--", request.target],
        signal,
      });
      if (result.exitCode !== 0) {
        throw new MacOsComputerUseAdapterError(
          "process-died",
          "Native computer-use helper ended before observation completed.",
        );
      }
      const observed = decodeObservation(result.stdout);
      return {
        targetApp: observed.targetApp,
        ...(observed.windowTitle === undefined ? {} : { windowTitle: observed.windowTitle }),
        ...(observed.role === "AXSecureTextField"
          ? { sensitiveFieldKind: "password" as const }
          : {}),
        reference: opaqueReference(
          "observation",
          request.sessionId,
          request.actionId,
          observed.targetApp,
          observed.role,
        ),
      };
    },
    execute: async (request, observation, signal) => {
      requireMacOs();
      if (request.target === undefined || !SUPPORTED_ACTIONS.has(request.kind)) {
        throw new MacOsComputerUseAdapterError(
          "invalid",
          "Computer-use action is not supported by the macOS host adapter.",
        );
      }
      const result = await options.process.run({
        executable: "/usr/bin/osascript",
        arguments: [
          "-l",
          "JavaScript",
          "-e",
          ACTION_SCRIPT,
          "--",
          request.kind,
          observation.targetApp,
          request.target,
        ],
        ...(request.value === undefined ? {} : { stdin: request.value }),
        signal,
      });
      if (result.exitCode !== 0) {
        throw new MacOsComputerUseAdapterError(
          "process-died",
          "Native computer-use helper ended before action completion.",
        );
      }
      return {
        reference: opaqueReference(
          "action",
          request.sessionId,
          request.actionId,
          observation.targetApp,
          request.kind,
        ),
      };
    },
    cleanup: async () => true,
  };
}

const SUPPORTED_ACTIONS = new Set(["click", "type-text", "key-press", "scroll", "observe-window"]);

interface BoundedObservation {
  readonly targetApp: string;
  readonly windowTitle?: string;
  readonly role: string;
}

function decodeObservation(value: string): BoundedObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MacOsComputerUseAdapterError("invalid", "Native observation response is invalid.");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.targetApp !== "string" ||
    parsed.targetApp.trim().length === 0 ||
    parsed.targetApp.length > 256 ||
    typeof parsed.role !== "string" ||
    parsed.role.trim().length === 0 ||
    parsed.role.length > 128 ||
    (parsed.windowTitle !== undefined &&
      (typeof parsed.windowTitle !== "string" || parsed.windowTitle.length > 1024))
  ) {
    throw new MacOsComputerUseAdapterError("invalid", "Native observation response is invalid.");
  }
  return {
    targetApp: parsed.targetApp.trim(),
    role: parsed.role.trim(),
    ...(typeof parsed.windowTitle === "string" && parsed.windowTitle.trim() !== ""
      ? { windowTitle: parsed.windowTitle.trim() }
      : {}),
  };
}

function opaqueReference(kind: string, ...parts: ReadonlyArray<string>): string {
  return `computer-use-${kind}-${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Fixed JXA programs are passed as code; all request data is supplied as argv or stdin.
// The helper returns bounded accessibility metadata and never reads field values.
const OBSERVE_SCRIPT = String.raw`
function run(argv) {
  const selector = argv[0];
  if (typeof selector !== "string" || selector.length === 0) throw new Error("invalid target");
  const system = Application("System Events");
  const processes = system.applicationProcesses.whose({ frontmost: { "=": true } })();
  if (processes.length !== 1) throw new Error("frontmost app unavailable");
  const process = processes[0];
  const windows = process.windows();
  if (windows.length === 0) throw new Error("window unavailable");
  const window = windows[0];
  const elements = window.entireContents();
  const expected = selector.startsWith("AXIdentifier:") ? selector.slice(13) : selector;
  const target = elements.find((element) => {
    try { return element.attributes.byName("AXIdentifier").value() === expected; }
    catch (_) { return false; }
  });
  if (!target) throw new Error("target unavailable");
  return JSON.stringify({
    targetApp: process.name(),
    windowTitle: window.name() || undefined,
    role: target.role(),
  });
}`;

const ACTION_SCRIPT = String.raw`
ObjC.import("Foundation");
function stdinText() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
}
function run(argv) {
  const [kind, appName, selector] = argv;
  const system = Application("System Events");
  const matches = system.applicationProcesses.whose({ name: { "=": appName } })();
  if (matches.length !== 1 || !matches[0].frontmost()) throw new Error("app authority changed");
  const process = matches[0];
  const windows = process.windows();
  if (windows.length === 0) throw new Error("window unavailable");
  const expected = selector.startsWith("AXIdentifier:") ? selector.slice(13) : selector;
  const target = windows[0].entireContents().find((element) => {
    try { return element.attributes.byName("AXIdentifier").value() === expected; }
    catch (_) { return false; }
  });
  if (!target) throw new Error("target unavailable");
  if (kind === "click") target.actions.byName("AXPress").perform();
  else if (kind === "type-text") target.value = stdinText();
  else if (kind === "key-press") system.keystroke(stdinText());
  else if (kind === "scroll") system.keyCode(125);
  else if (kind !== "observe-window") throw new Error("unsupported action");
  return JSON.stringify({ ok: true });
}`;
