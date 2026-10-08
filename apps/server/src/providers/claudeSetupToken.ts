import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnHostPty } from "../code/terminalProcessPort";
import { sanitizeClaudeEnvironment } from "./claudeEnvironment";
import { isClaudeHelperToken } from "./claudeHelperSignIn";

/**
 * Runs the installed `claude setup-token` and reads the long-lived token it
 * prints, so nobody copies a secret by hand.
 *
 * The command is an interactive terminal program: it opens the person's
 * browser for one approval and then prints the token under "Your OAuth token
 * (valid for …):". It needs a terminal, so it runs on a host-owned
 * pseudo-terminal, outside any sandbox, with a width that keeps the token on
 * one line. The output is held in memory only, never logged, and dropped once
 * the token is read; the token never appears in the command's arguments.
 */
export interface SetupTokenTerminal {
  readonly onData: (listener: (data: string) => void) => () => void;
  readonly onExit: (listener: () => void) => () => void;
  readonly kill: () => void;
}

export type SpawnSetupTokenTerminal = (input: {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly columns: number;
  readonly rows: number;
}) => SetupTokenTerminal;

export type ClaudeSetupTokenOutcome =
  | { readonly kind: "captured"; readonly token: string }
  | { readonly kind: "refused"; readonly reason: string };

export const SETUP_TOKEN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT_CHARACTERS = 256 * 1024;
const TERMINAL_COLUMNS = 4_096;
const TERMINAL_ROWS = 200;

// CSI, OSC, and two-byte escapes: the program draws with colour and redraws
// its spinner in place, so the raw stream interleaves control sequences with
// the text this reads.
const ESCAPE_SEQUENCES =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
// The token counts only once whitespace follows it: a pseudo-terminal can hand
// the line over in pieces, and a piece that ends mid-token, or mid-way through
// the colour reset after it, would otherwise read as a whole, wrong token.
const TOKEN_LINE = /Your OAuth token \(valid for[^)]*\):\s*(\S+)\s/;

/** The token in the program's printed output, or `undefined` while it is not there yet. */
export function readSetupTokenOutput(output: string): string | undefined {
  const text = output.replace(ESCAPE_SEQUENCES, "").replace(/\r/g, "\n");
  const match = TOKEN_LINE.exec(text);
  const candidate = match?.[1];
  return candidate !== undefined && isClaudeHelperToken(candidate) ? candidate : undefined;
}

export function runClaudeSetupToken(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawn: SpawnSetupTokenTerminal;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ClaudeSetupTokenOutcome> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let terminal: SetupTokenTerminal | undefined;
    const cleanups: Array<() => void> = [];
    const settle = (outcome: ClaudeSetupTokenOutcome) => {
      if (settled) return;
      settled = true;
      output = "";
      for (const cleanup of cleanups.splice(0)) cleanup();
      try {
        terminal?.kill();
      } catch {
        // The program may already have exited after printing.
      }
      resolve(outcome);
    };
    try {
      terminal = input.spawn({
        binaryPath: input.binaryPath,
        args: ["setup-token"],
        cwd: input.cwd,
        environment: input.environment,
        columns: TERMINAL_COLUMNS,
        rows: TERMINAL_ROWS,
      });
    } catch {
      resolve({ kind: "refused", reason: "Claude Code could not be started." });
      return;
    }
    const started = terminal;
    cleanups.push(
      started.onData((data) => {
        output = (output + data).slice(-OUTPUT_LIMIT_CHARACTERS);
        const token = readSetupTokenOutput(output);
        if (token !== undefined) settle({ kind: "captured", token });
      }),
    );
    cleanups.push(
      started.onExit(() => {
        // The program has finished, so the end of its output ends the token.
        const token = readSetupTokenOutput(`${output}\n`);
        settle(
          token === undefined
            ? { kind: "refused", reason: "Claude did not finish connecting. Try again." }
            : { kind: "captured", token },
        );
      }),
    );
    const timer = setTimeout(
      () => settle({ kind: "refused", reason: "Connecting Claude timed out. Try again." }),
      input.timeoutMs ?? SETUP_TOKEN_TIMEOUT_MS,
    );
    cleanups.push(() => clearTimeout(timer));
    if (input.signal !== undefined) {
      const onAbort = () => settle({ kind: "refused", reason: "Connecting Claude was cancelled." });
      if (input.signal.aborted) onAbort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => input.signal?.removeEventListener("abort", onAbort));
    }
  });
}

/** The live spawn: the installed binary on a host pseudo-terminal, in its own process group. */
export const spawnSetupTokenOnHostPty: SpawnSetupTokenTerminal = (input) => {
  const environment = Object.fromEntries(
    Object.entries(input.environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const pty = spawnHostPty(input.binaryPath, input.args, {
    name: "xterm-256color",
    cwd: input.cwd,
    env: environment,
    cols: input.columns,
    rows: input.rows,
  });
  return {
    onData: (listener) => {
      const disposable = pty.onData(listener);
      return () => disposable.dispose();
    },
    onExit: (listener) => {
      const disposable = pty.onExit(() => listener());
      return () => disposable.dispose();
    },
    kill: () => {
      try {
        process.kill(-pty.pid, "SIGTERM");
      } catch {
        // The program already exited after printing.
      }
    },
  };
};

/**
 * Connects the installed binary from an empty folder of its own, with the same
 * sanitized environment a subscription launch gets and no credential in it.
 */
export async function runInstalledClaudeSetupToken(
  binaryPath: string,
  signal: AbortSignal,
): Promise<ClaudeSetupTokenOutcome> {
  let cwd: string;
  try {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "octant-claude-connect-")));
  } catch {
    return { kind: "refused", reason: "Octant could not prepare the Claude sign-in." };
  }
  try {
    return await runClaudeSetupToken({
      binaryPath,
      cwd,
      environment: sanitizeClaudeEnvironment("subscription", process.env),
      spawn: spawnSetupTokenOnHostPty,
      signal,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
