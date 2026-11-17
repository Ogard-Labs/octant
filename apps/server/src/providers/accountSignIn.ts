import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  decodeProviderAuthenticationAttempt,
  type ProviderFailure,
  type ProviderInstanceId,
} from "@octant/contracts";
import type {
  ProviderAuthenticationProgress,
  ProviderDriver,
} from "@octant/provider-sdk/driver";

/**
 * Signing a Claude Code or Codex subscription account in from Settings.
 *
 * The host runs the account's own, unmodified sign-in command (`claude auth
 * login`, `codex login`) under that account's directory, exactly as the person
 * would in a terminal. The CLI opens the browser and keeps whatever it
 * receives; Octant reads only the sign-in page address the CLI prints, and,
 * when the person pastes the code a Claude sign-in page shows, hands that code
 * to the CLI's input. Measured on 17 Nov 2026 (Claude Code 2.1.322, Codex
 * 0.169.0) with no terminal attached: both open the browser themselves and
 * print a fallback address; Claude's fallback page shows a code to paste.
 */

/** How long a sign-in may wait for the person before the CLI is stopped. */
export const ACCOUNT_SIGN_IN_LIFETIME_MS = 10 * 60_000;
/** How long the CLI has to print its sign-in page address. */
const SIGN_IN_PAGE_WAIT_MS = 20_000;
const OUTPUT_LIMIT = 16_384;
const SIGN_IN_PAGE = /https:\/\/[^\s"'<>]+/;

export interface AccountSignInProcess {
  readonly onOutput: (listener: (chunk: string) => void) => void;
  readonly onExit: (listener: (code: number | null) => void) => void;
  readonly writeLine: (line: string) => void;
  readonly stop: () => void;
}

export type AccountSignInSpawn = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) => AccountSignInProcess;

export interface AccountSignInCommand {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  /** The provider's sign-in page can show a code for the person to paste back. */
  readonly codeEntry: boolean;
}

interface Attempt {
  readonly instanceId: string;
  readonly process: AccountSignInProcess;
  readonly timer: ReturnType<typeof setTimeout>;
  output: string;
  exitCode: number | null | undefined;
}

const attempts = new Map<string, Attempt>();

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}
let stopsOnHostExit = false;

function forget(attemptId: string): void {
  const attempt = attempts.get(attemptId);
  if (attempt === undefined) return;
  clearTimeout(attempt.timer);
  attempts.delete(attemptId);
  if (attempt.exitCode === undefined) attempt.process.stop();
}

function stopAll(): void {
  for (const attemptId of [...attempts.keys()]) forget(attemptId);
}

/** The last line the CLI wrote, as a person-readable reason, without control characters. */
function lastLine(output: string): string {
  const lines = output
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .filter((line) => line.length > 0);
  const line = lines.at(-1);
  return line === undefined ? "" : line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const spawnSignIn: AccountSignInSpawn = (binaryPath, args, environment) => {
  const child = spawn(binaryPath, [...args], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    onOutput: (listener) => {
      child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
    },
    onExit: (listener) => {
      child.on("error", () => listener(null));
      child.on("exit", (code) => listener(code));
    },
    writeLine: (line) => {
      child.stdin?.write(`${line}\n`);
    },
    stop: () => {
      child.kill("SIGTERM");
    },
  };
};

export type AccountSignInStart =
  | {
      readonly status: "started";
      readonly attemptId: string;
      readonly signInUrl: string;
      readonly expiresAt: string;
    }
  | { readonly status: "failed"; readonly message: string };

/**
 * Starts the account's sign-in and resolves once the CLI printed its sign-in
 * page. A sign-in already running for the same account is stopped first.
 */
export function startAccountSignIn(
  command: AccountSignInCommand,
  spawnProcess: AccountSignInSpawn = spawnSignIn,
  now: () => number = Date.now,
): Promise<AccountSignInStart> {
  if (!stopsOnHostExit) {
    stopsOnHostExit = true;
    process.once("exit", stopAll);
  }
  for (const [attemptId, attempt] of attempts) {
    if (attempt.instanceId === String(command.instanceId)) forget(attemptId);
  }
  const attemptId = randomUUID();
  const expiresAt = new Date(now() + ACCOUNT_SIGN_IN_LIFETIME_MS).toISOString();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: AccountSignInStart) => {
      if (settled) return;
      settled = true;
      clearTimeout(pageWait);
      if (result.status === "failed") forget(attemptId);
      resolve(result);
    };
    let child: AccountSignInProcess;
    try {
      child = spawnProcess(command.binaryPath, command.args, command.environment);
    } catch {
      resolve({ status: "failed", message: "The sign-in command could not be started." });
      return;
    }
    const attempt: Attempt = {
      instanceId: String(command.instanceId),
      process: child,
      timer: setTimeout(() => forget(attemptId), ACCOUNT_SIGN_IN_LIFETIME_MS),
      output: "",
      exitCode: undefined,
    };
    attempts.set(attemptId, attempt);
    const pageWait = setTimeout(
      () => settle({ status: "failed", message: "The sign-in command did not offer a sign-in page." }),
      SIGN_IN_PAGE_WAIT_MS,
    );
    child.onOutput((chunk) => {
      if (attempt.output.length < OUTPUT_LIMIT) attempt.output += chunk;
      const page = SIGN_IN_PAGE.exec(attempt.output)?.[0];
      if (page !== undefined) settle({ status: "started", attemptId, signInUrl: page, expiresAt });
    });
    child.onExit((code) => {
      attempt.exitCode = code;
      settle({
        status: "failed",
        message: lastLine(attempt.output) || "The sign-in command stopped before it began.",
      });
    });
  });
}

export type AccountSignInCheck =
  | { readonly status: "completed" }
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Where a sign-in stands. A pasted code goes to the CLI's input once; the
 * result shows on a later check, after the CLI has finished with it.
 */
export function checkAccountSignIn(input: {
  readonly instanceId: ProviderInstanceId;
  readonly attemptId: string;
  readonly code?: string;
}): AccountSignInCheck {
  const attempt = attempts.get(input.attemptId);
  if (attempt === undefined || attempt.instanceId !== String(input.instanceId)) {
    return { status: "failed", message: "This sign-in has ended. Start it again." };
  }
  if (attempt.exitCode === undefined) {
    if (input.code !== undefined) attempt.process.writeLine(input.code);
    return { status: "pending" };
  }
  const { exitCode, output } = attempt;
  forget(input.attemptId);
  return exitCode === 0
    ? { status: "completed" }
    : { status: "failed", message: lastLine(output) || "Sign-in did not finish." };
}

/** The driver with Settings sign-in through the account's own CLI command. */
export function withAccountSignIn(
  driver: ProviderDriver,
  command: AccountSignInCommand,
  spawnProcess?: AccountSignInSpawn,
): ProviderDriver {
  const matches = (instanceId: ProviderInstanceId) =>
    String(instanceId) === String(command.instanceId);
  return {
    ...driver,
    beginAuthentication: ({ instanceId }) =>
      !matches(instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.flatMap(
            Effect.promise(() => startAccountSignIn(command, spawnProcess)),
            (started) =>
              started.status === "failed"
                ? Effect.fail(failure("unauthenticated", started.message))
                : Effect.succeed(
                    decodeProviderAuthenticationAttempt({
                      attemptId: started.attemptId,
                      signInUrl: started.signInUrl,
                      expiresAt: started.expiresAt,
                      ...(command.codeEntry ? { codeEntry: true } : {}),
                    }),
                  ),
          ),
    completeAuthentication: ({ instanceId, attemptId, code }) => {
      if (!matches(instanceId)) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      const check = checkAccountSignIn({
        instanceId,
        attemptId,
        ...(code === undefined ? {} : { code }),
      });
      return check.status === "failed"
        ? Effect.fail(failure("unauthenticated", check.message))
        : Effect.succeed<ProviderAuthenticationProgress>(check.status);
    },
  };
}
