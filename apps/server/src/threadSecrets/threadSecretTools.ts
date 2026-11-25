import {
  decodeThreadSecretRequestInput,
  decodeThreadSecretRunInput,
  THREAD_SECRET_ENVIRONMENT_PREFIX,
  type ThreadSecretFailure,
  type ThreadSecretRequestResult,
  type ThreadSecretRunResult,
} from "@octant/contracts/thread-secrets";
import { Either } from "effect";
import type { PreparedThreadCommand } from "../harness/nativeHarnessComposition";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import { STDERR_MARK } from "../harness/nativeHarnessShell";
import { redactHostSecrets, secretForms } from "../process/secretRedaction";
import type { ThreadSecretCaller, ThreadSecretService } from "./threadSecretService";

/** How the host runs one of this thread's commands: the thread's own rules, then its own shell. */
export interface ThreadSecretCommands {
  readonly prepare: (input: {
    readonly command: string;
    readonly hostNote: string;
    readonly signal: AbortSignal;
  }) => Promise<PreparedThreadCommand>;
  readonly shell: NativeHarnessShellPort | undefined;
  readonly cwd: string;
  readonly extraRoots?: ReadonlyArray<string> | undefined;
}

type ToolReply = { readonly result: unknown; readonly isError: boolean };

export interface ThreadSecretOperations {
  readonly requestSecret: (input: unknown, signal?: AbortSignal) => Promise<ToolReply>;
  readonly runWithSecret: (input: unknown, signal?: AbortSignal) => Promise<ToolReply>;
  /** The turn ended: what it alone was given ends with it. */
  readonly close: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 24 * 1024;
/** A shorter piece of a value says nothing of it. */
const MINIMUM_CUT_LENGTH = 4;

const FAILURE_NOTES: Readonly<Partial<Record<ThreadSecretFailure, string>>> = {
  expired: "This thread has no such active secret. Ask for it with request-secret.",
  unavailable:
    "That secret is not given to commands here: it was granted as a handle, is in use, or the thread changed. Ask for it with delivery file.",
  "refused-by-strict": "Strict does not allow that secret's lifetime. Ask for it again.",
  revoked: "The person ended that secret. Do not ask again unless they say so.",
  locked: "The person's secret store is locked. Say so and wait for them to unlock it.",
};

/**
 * The credential tool's thread-secret operations for one turn. Every refusal
 * is a value the agent can act on; nothing here returns a secret.
 */
export function threadSecretOperations(options: {
  readonly service: ThreadSecretService;
  readonly caller: ThreadSecretCaller;
  /** Absent where the host runs no command for the thread. */
  readonly commands?: ThreadSecretCommands | undefined;
  /** Read at each call: a turn can be narrowed to Plan while it runs. */
  readonly planning: () => boolean;
  /** The Project's folder is on another computer, where nothing of this host's is sent. */
  readonly onServer: boolean;
}): ThreadSecretOperations {
  const { service, caller } = options;
  const signalOf = (signal: AbortSignal | undefined): AbortSignal =>
    signal === undefined ? caller.signal : AbortSignal.any([signal, caller.signal]);
  return {
    requestSecret: async (input, signal) => {
      const decoded = decodeThreadSecretRequestInput(input);
      if (Either.isLeft(decoded)) return invalid;
      if (options.planning()) return replyRefused("plan", "Plan takes no secrets.");
      const result = await service.request(caller, decoded.right, signalOf(signal));
      return requested(result);
    },
    runWithSecret: async (input, signal) => {
      const decoded = decodeThreadSecretRunInput(input);
      if (Either.isLeft(decoded)) return invalid;
      if (options.planning()) return replyRefused("plan", "Plan runs no commands with secrets.");
      if (options.onServer)
        return replyRefused(
          "server-project",
          "This Project's folder is on a server, where a secret would show in the server's process list.",
        );
      const { commands } = options;
      if (commands?.shell === undefined)
        return replyRefused("no-shell", "Octant runs no commands for this thread here.");
      return run({
        ...decoded.right,
        service,
        caller,
        commands,
        shell: commands.shell,
        signal: signalOf(signal),
      });
    },
    close: () => service.turnEnded(caller.threadId, caller.turnId),
  };
}

async function run(input: {
  readonly command: string;
  readonly secrets: ReadonlyArray<string>;
  readonly timeoutMs?: number | undefined;
  readonly service: ThreadSecretService;
  readonly caller: ThreadSecretCaller;
  readonly commands: ThreadSecretCommands;
  readonly shell: NativeHarnessShellPort;
  readonly signal: AbortSignal;
}): Promise<ToolReply> {
  const { service, caller, commands, signal, secrets, command } = input;
  // Nobody is asked about a command that could not be given its secrets.
  const early = service.refusesLoan(caller, secrets, signal);
  if (early !== undefined) return replyRefused(early);
  const prepared = await commands.prepare({
    command,
    hostNote: `Octant gives it ${secrets
      .map((name) => `${THREAD_SECRET_ENVIRONMENT_PREFIX}${name}`)
      .join(", ")}`,
    signal,
  });
  if (prepared.status === "refused")
    return replyRefused(
      "not-approved",
      prepared.message ?? `The command was not run (${prepared.reason}).`,
    );
  try {
    // After the approval, so a wait for it holds no value and spends no secret.
    const loan = await service.lend({ caller, names: secrets, signal });
    if (loan.status === "refused") return replyRefused(loan.failure);
    try {
      const ran = await input.shell.run({
        command,
        cwd: commands.cwd,
        ...(commands.extraRoots === undefined || commands.extraRoots.length === 0
          ? {}
          : { extraRoots: commands.extraRoots }),
        environment: loan.environment,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        callId: prepared.callId,
        ...(prepared.confirmedHosts === undefined
          ? {}
          : { confirmedHosts: prepared.confirmedHosts }),
        outputRetention: "newest",
        // Spent and recorded as it starts: a command the host refuses spends nothing.
        beforeLaunch: () => prepared.admitStart() && loan.start(),
        signal,
      });
      return ranReply(ran, Object.values(loan.environment));
    } finally {
      loan.done();
    }
  } finally {
    // The shell records what it ran; this only ends the call's own approval.
    prepared.finish({ started: false });
  }
}

function ranReply(run: NativeHarnessShellRun, values: ReadonlyArray<string>): ToolReply {
  if (run.status === "unavailable")
    return replyRefused(
      "no-shell",
      run.refusal?.message ?? "Octant could not run the command here.",
    );
  // Redacted before anything is cut, since a cut value is no longer found.
  const redacted = redactHostSecrets(
    run.truncated ? withoutCutValue(run.output, values) : run.output,
  );
  const { text, cut } = newest(redacted);
  const result: ThreadSecretRunResult = {
    status: run.status,
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    output: text,
    truncated: run.truncated || cut,
  };
  return { result, isError: run.status !== "ran" || run.exitCode !== 0 };
}

/**
 * Takes a value's remains off the edges of output that was cut. Each stream is
 * cut on its own, and a host keeps its newest or its first end, so every edge
 * is read. A stream that may have lost its beginning loses the rest of that
 * line too: an encoded value's remains look like nothing in particular. What
 * follows is read as a beginning as well, since the host can put a line of its
 * own before a stream's.
 */
function withoutCutValue(output: string, values: ReadonlyArray<string>): string {
  const forms = values.flatMap((value) => [value, ...secretForms(value)]);
  return output
    .split(STDERR_MARK)
    .map((stream) => {
      // A cut inside a character leaves its replacement, which no value matches.
      const text = stream.replace(/^\uFFFD+|\uFFFD+$/gu, "");
      return withoutEnd(withoutStart(text.slice(text.indexOf("\n") + 1), forms), forms);
    })
    .join(STDERR_MARK);
}

function withoutStart(text: string, forms: ReadonlyArray<string>): string {
  let cut = 0;
  for (const form of forms)
    for (let length = Math.min(form.length, text.length); length > cut; length -= 1)
      if (length >= MINIMUM_CUT_LENGTH && text.startsWith(form.slice(-length))) cut = length;
  return text.slice(cut);
}

function withoutEnd(text: string, forms: ReadonlyArray<string>): string {
  let cut = 0;
  for (const form of forms)
    for (let length = Math.min(form.length, text.length); length > cut; length -= 1)
      if (length >= MINIMUM_CUT_LENGTH && text.endsWith(form.slice(0, length))) cut = length;
  return cut === 0 ? text : text.slice(0, -cut);
}

function newest(text: string): { readonly text: string; readonly cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return { text, cut: false };
  return {
    // A character the cut split is dropped.
    text: bytes.subarray(-MAX_OUTPUT_BYTES).toString("utf8").replace(/^�+/u, ""),
    cut: true,
  };
}

const invalid: ToolReply = { result: { status: "invalid" }, isError: true };

function requested(result: ThreadSecretRequestResult): ToolReply {
  return { result, isError: result.status !== "saved" };
}

type Refusal = Extract<ThreadSecretRunResult, { readonly status: "refused" }>["failure"];

function replyRefused(failure: Refusal, note?: string): ToolReply {
  const result: ThreadSecretRunResult = {
    status: "refused",
    failure,
    note:
      note ??
      FAILURE_NOTES[failure as ThreadSecretFailure] ??
      "That secret cannot be used now. Say what is blocked.",
  };
  return { result, isError: true };
}
