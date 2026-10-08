import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_REPOSITORY_TEST_ARTIFACT_BYTES,
  MAX_REPOSITORY_TEST_OUTPUT_BYTES,
} from "@octant/contracts";
import type { RepositoryTestProcessResult } from "./repositoryTestRunner";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";
import {
  makeSeatbeltConfinementLive,
  SeatbeltConfinementError,
  seatbeltAllowLiteralMetadataRule,
  seatbeltAllowLiteralReadRule,
  seatbeltAllowMachLookupRule,
  seatbeltAllowRegexReadWriteRule,
  type SeatbeltConfinementPort,
} from "../process/seatbeltProfile";
import type { OsNetworkEgress } from "../process/threadEgressPolicy";

interface ProcessStream {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
}

interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: ProcessStream;
  readonly stderr: ProcessStream;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/**
 * The temporary directory a confined launch may write when none is named.
 * Callers that hand a confined command a path to write share this resolution
 * so the path is inside the launch's writable temporary root.
 */
export function defaultTemporaryDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  // An empty or relative TMPDIR is set often enough (stripped environments,
  // launchers) and a confined launch refuses a temporary root that is not
  // absolute, so the first usable value wins rather than the first one set.
  for (const name of ["TMPDIR", "TMP", "TEMP"] as const) {
    const value = environment[name];
    if (value !== undefined && isAbsolute(value)) return value;
  }
  return "/tmp";
}

interface RepositoryTestProcessPortOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => SpawnedProcess;
  readonly killProcessGroup?: (groupId: number, signal: NodeJS.Signals) => void;
  readonly gracefulTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly processGroupExists?: (pid: number) => boolean;
  readonly confinement?: SeatbeltConfinementPort;
  readonly sandboxPath?: string;
  readonly temporaryDirectory?: string;
  readonly networkEgress?: OsNetworkEgress;
  readonly seatbeltHomeDirectory?: string;
  readonly seatbeltUsersDirectory?: string;
  /**
   * Exact host paths a confined child must read even though they sit beneath a
   * denied ancestor. The Apple toolchain is the caller: `xcode-select` reads
   * the developer-directory links under `/private/var`, and without them every
   * Apple command reports "Xcode is unavailable on this host".
   */
  readonly literalReadPaths?: ReadonlyArray<string>;
  /**
   * Directories a confined child may read and write even though they sit
   * beneath the private-home deny. The Android toolchain is the caller: the
   * AVD store, adb keys, and emulator locks all live under `~/.android`, and
   * without the grant `emulator -list-avds` exits 0 with an empty list on a
   * host that has devices.
   */
  readonly additionalWritePaths?: ReadonlyArray<string>;
  /**
   * Whether confined commands may drive the iOS Simulator. Only the Apple
   * toolchain port turns this on; the repository-test runner does not need it.
   */
  readonly allowSimulatorControl?: boolean;
  /**
   * Where `executeShellScript` takes the scripts it runs with `/bin/sh`. Only
   * the harness `bash` ports name one: a repository test, Apple, or Android
   * launch never needs a shell. It must lie outside every root a confined
   * launch may write, so no command can rewrite a script waiting to run.
   */
  readonly harnessShellScriptDirectory?: string;
}

/**
 * One harness shell command: a script file the harness wrote in its own
 * subdirectory of the port's script directory, run as `/bin/sh <script>` and
 * nothing else.
 */
export interface HarnessShellScriptInput {
  readonly script: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface RepositoryTestProcessInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /**
   * Exact host paths this launch must read even though they sit beneath a
   * denied ancestor, unioned with the port-wide set. A launch that needs a
   * node names it here so a launch that does not never receives the grant
   * (0133). macOS only.
   */
  readonly literalReadPaths?: ReadonlyArray<string>;
  /**
   * Exact host nodes this launch may stat even though they sit beneath a
   * denied ancestor. Traversal into a re-allowed subpath asks the kernel for
   * each ancestor's metadata first, and a launch that needs it names the
   * nodes here rather than gaining read of their siblings. macOS only.
   */
  readonly literalMetadataPaths?: ReadonlyArray<string>;
  /**
   * POSIX regexes over resolved absolute paths this launch may read and
   * write, for host state minted per boot whose name no literal can name
   * ahead of time. `xcodebuild test` is the caller: the test runner's unix
   * socket lands under `/private/var/tmp/com.apple.launchd.<session>/`.
   * macOS only.
   */
  readonly regexReadWritePaths?: ReadonlyArray<string>;
  /**
   * Named Mach services this launch may look up. `xcodebuild test` is the
   * caller: it keeps a no-idle-sleep assertion over XPC and aborts without
   * the lookup. macOS only.
   */
  readonly machLookupNames?: ReadonlyArray<string>;
  /**
   * Whether this launch may allocate a pseudo-terminal. `xcodebuild test`
   * runs the test bundle behind a PTY for output capture; denied, the run
   * dies with "Pseudo Terminal Setup Error". Unlike a terminal launch,
   * which inherits its slave descriptor, this process allocates the pair
   * itself, so the grant covers the master node and the numbered slaves.
   * macOS only.
   */
  readonly allowPseudoTty?: boolean;
  /**
   * Whether this launch may spawn processes into a new session job.
   * `xcodebuild test` installs and launches the test runner as its own job;
   * denied `job-creation`, the launch reports it could not launch the runner.
   * macOS only.
   */
  readonly allowJobCreation?: boolean;
  /**
   * Whether this launch may signal processes outside its own group.
   * `xcodebuild test` terminates a stale copy of the target app before
   * installing and stops it again at teardown; denied `signal`, the old
   * instance survives and the session hangs waiting on the runner. macOS
   * only.
   */
  readonly allowSignal?: boolean;
  /**
   * Directories this launch may read and write on top of the port-wide set,
   * for host state only one kind of launch should reach. The Apple screenshot
   * is the caller: its raw capture lands in a host-private directory no other
   * confined launch is granted, and only this launch may write it there.
   */
  readonly additionalWriteRoots?: ReadonlyArray<string>;
  /** Read-only directories needed by this launch outside its checkout. */
  readonly additionalReadRoots?: ReadonlyArray<string>;
  /**
   * Host-private directories this launch is denied outright, after its broad
   * grants: a checkout bound to an ancestor of one would otherwise re-allow
   * it through the `cwd` read root. The launch that owns the directory still
   * reaches it when it also carries the path in `additionalWriteRoots`.
   */
  readonly isolatedRoots?: ReadonlyArray<string>;
}

export interface RepositoryTestArtifactReadInput {
  readonly checkoutRoot: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
}

const SAFE_INHERITED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 1_024;
const MAX_TIMEOUT_MS = 60 * 60 * 1_000;
const HARNESS_SHELL = "/bin/sh";

export class RepositoryTestProcessPort {
  readonly #platform: NodeJS.Platform;
  readonly #spawn: NonNullable<RepositoryTestProcessPortOptions["spawn"]>;
  readonly #killProcessGroup: NonNullable<RepositoryTestProcessPortOptions["killProcessGroup"]>;
  readonly #gracefulTimeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #receiptDirectory: string | undefined;
  readonly #processIdentity: ((pid: number) => Promise<string | undefined>) | undefined;
  readonly #processGroupExists: (pid: number) => boolean;
  readonly #confinement: SeatbeltConfinementPort;
  readonly #temporaryDirectory: string;
  readonly #networkEgress: OsNetworkEgress;
  readonly #literalReadPaths: ReadonlyArray<string>;
  readonly #additionalWritePaths: ReadonlyArray<string>;
  readonly #allowSimulatorControl: boolean;
  readonly #harnessShellScriptDirectory: string | undefined;

  constructor(options: RepositoryTestProcessPortOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#spawn =
      options.spawn ??
      ((executable, args, spawnOptions) =>
        nodeSpawn(executable, [...args], spawnOptions) as unknown as SpawnedProcess);
    this.#killProcessGroup =
      options.killProcessGroup ?? ((groupId, signal) => process.kill(groupId, signal));
    this.#gracefulTimeoutMs = options.gracefulTimeoutMs ?? 1_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? MAX_REPOSITORY_TEST_OUTPUT_BYTES;
    this.#receiptDirectory = options.receiptDirectory;
    this.#processIdentity = options.processIdentity;
    this.#processGroupExists = options.processGroupExists ?? defaultProcessGroupExists;
    this.#temporaryDirectory = options.temporaryDirectory ?? defaultTemporaryDirectory();
    this.#networkEgress = options.networkEgress ?? "allow";
    this.#literalReadPaths = options.literalReadPaths ?? [];
    this.#additionalWritePaths = options.additionalWritePaths ?? [];
    this.#allowSimulatorControl = options.allowSimulatorControl === true;
    this.#harnessShellScriptDirectory = options.harnessShellScriptDirectory;
    this.#confinement =
      options.confinement ??
      makeSeatbeltConfinementLive({
        platform: this.#platform,
        ...(options.sandboxPath === undefined ? {} : { sandboxPath: options.sandboxPath }),
        ...(options.seatbeltHomeDirectory === undefined
          ? {}
          : { homeDirectory: options.seatbeltHomeDirectory }),
        ...(options.seatbeltUsersDirectory === undefined
          ? {}
          : { usersDirectory: options.seatbeltUsersDirectory }),
      });
  }

  async execute(
    input: RepositoryTestProcessInput,
    signal?: AbortSignal,
  ): Promise<RepositoryTestProcessResult> {
    if (!supportsOwnedProcessGroups(this.#platform)) return unavailable(false);
    if (signal?.aborted) return cancelledBeforeSpawn();
    let validated: ReturnType<typeof validateProcessInput>;
    try {
      validated = validateProcessInput(input, this.#maxOutputBytes);
    } catch {
      return unavailable(false);
    }
    return this.#launch(input, validated, signal);
  }

  /**
   * The harness `bash` entry point. `execute` refuses a shell as argv[0] so a
   * test command stays one structured argv nothing reinterprets; this is the
   * one place a shell runs, and only what the harness shell needs: the fixed
   * `/bin/sh`, one regular-file script in its own subdirectory of the port's
   * script directory, no other argument, and every other check `execute`
   * makes. The launch may read that one subdirectory and write none of it, so
   * neither this command nor a concurrent one can swap the script another
   * call is about to run. A port without a script directory refuses it.
   */
  async executeShellScript(
    input: HarnessShellScriptInput,
    signal?: AbortSignal,
  ): Promise<RepositoryTestProcessResult> {
    const scriptDirectory = this.#harnessShellScriptDirectory;
    if (scriptDirectory === undefined || !supportsOwnedProcessGroups(this.#platform))
      return unavailable(false);
    if (signal?.aborted) return cancelledBeforeSpawn();
    let launchInput: RepositoryTestProcessInput;
    try {
      validateLaunchInput({ ...input, argv: [HARNESS_SHELL, input.script] }, this.#maxOutputBytes);
      const script = await resolveHarnessScript(scriptDirectory, input.script, [
        input.cwd,
        this.#temporaryDirectory,
        ...this.#additionalWritePaths,
      ]);
      launchInput = {
        ...input,
        argv: [HARNESS_SHELL, script],
        additionalReadRoots: [dirname(script)],
      };
      validateLaunchInput(launchInput, this.#maxOutputBytes);
    } catch {
      return unavailable(false);
    }
    if (signal?.aborted) return cancelledBeforeSpawn();
    return this.#launch(
      launchInput,
      { executable: HARNESS_SHELL, args: launchInput.argv.slice(1) },
      signal,
    );
  }

  async #launch(
    input: RepositoryTestProcessInput,
    validated: { readonly executable: string; readonly args: readonly string[] },
    signal: AbortSignal | undefined,
  ): Promise<RepositoryTestProcessResult> {
    let launch: { readonly command: string; readonly args: readonly string[] };
    try {
      const executable = isAbsolute(validated.executable)
        ? validated.executable
        : await resolveTestExecutable(validated.executable);
      if (executable === undefined) return unavailable(false);
      const binaryDirectory = dirname(executable);
      const binaryParentDirectory = dirname(binaryDirectory);
      const launchReadRules =
        this.#platform === "darwin"
          ? [...this.#literalReadPaths, ...(input.literalReadPaths ?? [])].map(
              seatbeltAllowLiteralReadRule,
            )
          : [];
      if (this.#platform === "darwin") {
        for (const path of input.literalMetadataPaths ?? []) {
          launchReadRules.push(seatbeltAllowLiteralMetadataRule(path));
        }
        for (const pattern of input.regexReadWritePaths ?? []) {
          launchReadRules.push(seatbeltAllowRegexReadWriteRule(pattern));
        }
        for (const name of input.machLookupNames ?? []) {
          launchReadRules.push(seatbeltAllowMachLookupRule(name));
        }
        if (input.allowPseudoTty === true) {
          launchReadRules.push(
            "(allow pseudo-tty)",
            '(allow file-write* file-ioctl (literal "/dev/ptmx"))',
            '(allow file-write* file-ioctl (regex #"^/dev/ttys[0-9]+$"))',
          );
        }
        if (input.allowJobCreation === true) {
          launchReadRules.push("(allow job-creation)");
        }
        if (input.allowSignal === true) {
          launchReadRules.push("(allow signal)");
        }
      }
      const additionalWriteRoots = [
        ...this.#additionalWritePaths,
        ...(input.additionalWriteRoots ?? []),
      ];
      launch = this.#confinement.prepare({
        executable,
        args: validated.args,
        boundRoot: input.cwd,
        temporaryDirectory: this.#temporaryDirectory,
        networkEgress: this.#networkEgress,
        allowFileReadStar: true,
        allowSimulatorControl: this.#allowSimulatorControl,
        readRoots: [
          input.cwd,
          this.#temporaryDirectory,
          binaryDirectory,
          ...(dirname(binaryParentDirectory) === binaryParentDirectory
            ? []
            : [binaryParentDirectory]),
          ...(input.additionalReadRoots ?? []),
        ],
        ...(additionalWriteRoots.length === 0 ? {} : { additionalWriteRoots }),
        ...(input.isolatedRoots === undefined ? {} : { isolatedRoots: input.isolatedRoots }),
        ...(this.#platform === "darwin" && launchReadRules.length > 0
          ? { extraRules: launchReadRules }
          : {}),
      });
    } catch (error) {
      if (error instanceof SeatbeltConfinementError) return unavailable(false);
      return unavailable(false);
    }

    if (signal?.aborted) return cancelledBeforeSpawn();

    let child: SpawnedProcess;
    try {
      child = this.#spawn(launch.command, launch.args, {
        cwd: input.cwd,
        env: sanitizedEnvironment(input.environment, this.#temporaryDirectory),
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return unavailable(false);
    }

    const output = new CombinedOutputCapture(this.#maxOutputBytes);
    child.stdout.on("data", (chunk) => output.append("stdout", chunk));
    child.stderr.on("data", (chunk) => output.append("stderr", chunk));
    const closed = observeClose(child);
    const receiptAttempt = persistProcessReceipt(
      {
        supervisor: "repository-test-runner",
        ...(this.#receiptDirectory === undefined
          ? {}
          : { receiptDirectory: this.#receiptDirectory }),
        ...(this.#processIdentity === undefined ? {} : { processIdentity: this.#processIdentity }),
      },
      `${input.cwd}:${JSON.stringify(input.argv)}:${child.pid ?? "unknown"}`,
      child.pid ?? -1,
    ).then(async (value) => {
      await value.ready;
      return value;
    });
    const settlement = firstSettlement(closed, input.timeoutMs, signal);
    const receiptOutcome = await Promise.race([
      receiptAttempt.then(
        (value) => ({ kind: "receipt" as const, value }),
        (error) => ({ kind: "receipt-error" as const, error }),
      ),
      closed.then((value) => ({ kind: "closed" as const, value })),
      settlement.then((value) => ({ kind: "settlement" as const, value })),
    ]);
    const settledProcess =
      receiptOutcome.kind === "closed" || receiptOutcome.kind === "settlement"
        ? receiptOutcome.value
        : undefined;
    if (settledProcess?.kind === "closed" || settledProcess?.kind === "error") {
      const receipt = await receiptAttempt.then(
        (value) => value,
        () => undefined,
      );
      const groupReleased = await this.#waitForProcessGroupExit(child.pid ?? -1);
      if (groupReleased) {
        // A clean result must not race a late durable receipt.  Returning
        // before this removal leaves a stale receipt that can be reconciled
        // against an unrelated future process after a restart.
        await receipt?.remove();
      } else if (receipt === undefined) {
        // Receipt persistence failed while the detached group may still be
        // live.  There is no durable owner to reconcile later, so attempt
        // cleanup before reporting the uncertain outcome.
        await this.#terminate(child, closed).catch(() => undefined);
      } else {
        // Retain the receipt while a descendant group survives so restart
        // reconciliation continues to own it.  The background cleanup only
        // removes the receipt after it can prove the group has exited.
        void this.#removeReceiptAfterProcessExit(receipt, child, closed).catch(() => undefined);
      }
      return settledProcess.kind === "closed"
        ? exited(settledProcess.code, output, !groupReleased)
        : unavailable(!groupReleased, output);
    }
    if (settledProcess?.kind === "timed-out" || settledProcess?.kind === "cancelled") {
      const cleanup = await this.#terminate(child, closed);
      void receiptAttempt
        .then(async (value) => {
          if (await this.#waitForProcessGroupExit(child.pid ?? -1)) {
            await value.remove();
            return;
          }
          const receiptCleanup = await this.#terminate(child, closed);
          if (!receiptCleanup.uncertain) await value.remove();
        })
        .catch(() => undefined);
      return {
        termination: settledProcess.kind,
        exitCode: cleanup.code,
        ...output.result(),
        cleanupUncertain: cleanup.uncertain,
      };
    }
    if (receiptOutcome.kind === "receipt-error") {
      const cleanup = await this.#terminate(child, closed);
      return unavailable(cleanup.uncertain, output);
    }
    if (receiptOutcome.kind !== "receipt") return unavailable(true, output);
    const receipt: OwnedProcessReceiptHandle = receiptOutcome.value;

    const first = await settlement;
    if (first.kind === "error") {
      const groupReleased = await this.#removeReceiptWhenReleased(receipt, child.pid);
      return unavailable(!groupReleased, output);
    }
    if (first.kind === "closed") {
      const groupReleased = await this.#removeReceiptWhenReleased(receipt, child.pid);
      return exited(first.code, output, !groupReleased);
    }

    const cleanup = await this.#terminate(child, closed);
    if (!cleanup.uncertain) await receipt.remove();
    return {
      termination: first.kind === "cancelled" ? "cancelled" : "timed-out",
      exitCode: cleanup.code,
      ...output.result(),
      cleanupUncertain: cleanup.uncertain,
    };
  }

  async reconcile(): Promise<void> {
    await reconcileProcessReceipts({
      supervisor: "repository-test-runner",
      ...(this.#receiptDirectory === undefined ? {} : { receiptDirectory: this.#receiptDirectory }),
      ...(this.#processIdentity === undefined ? {} : { processIdentity: this.#processIdentity }),
      processGroupExists: this.#processGroupExists,
      killProcessGroup: (pid, signal) => this.#killProcessGroup(-Math.abs(pid), signal),
      shutdownTimeoutMs: this.#gracefulTimeoutMs,
    });
  }

  async readArtifact(input: RepositoryTestArtifactReadInput): Promise<Uint8Array | undefined> {
    try {
      validateArtifactInput(input);
      const canonicalRoot = await realpath(input.checkoutRoot);
      const candidate = resolve(canonicalRoot, input.relativePath);
      if (!contained(canonicalRoot, candidate)) throw new Error("Artifact path escapes checkout.");
      await rejectSymlinkComponents(canonicalRoot, input.relativePath);
      const canonicalCandidate = await realpath(candidate);
      if (!contained(canonicalRoot, canonicalCandidate))
        throw new Error("Artifact symlink escapes checkout.");

      const readLimit = Math.min(input.maximumBytes + 1, MAX_REPOSITORY_TEST_ARTIFACT_BYTES + 1);
      const handle = await open(
        candidate,
        constants.O_RDONLY | (this.#platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new Error("Artifact is not a regular file.");
        const allocation = Math.min(readLimit, metadata.size);
        const bytes = Buffer.allocUnsafe(allocation);
        let offset = 0;
        while (offset < allocation) {
          const result = await handle.read(bytes, offset, allocation - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + offset));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async #terminate(
    child: SpawnedProcess,
    closed: Promise<ProcessClose>,
  ): Promise<{ readonly code: number | null; readonly uncertain: boolean }> {
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0)
      return { code: null, uncertain: true };
    const groupId = -Math.abs(child.pid!);
    try {
      this.#killProcessGroup(groupId, "SIGTERM");
    } catch {
      return { code: null, uncertain: true };
    }
    const graceful = await closeWithin(closed, this.#gracefulTimeoutMs);
    if (graceful !== undefined) {
      if (graceful.kind !== "closed") return { code: null, uncertain: true };
      if (await this.#waitForProcessGroupExit(child.pid!)) {
        return { code: graceful.code, uncertain: false };
      }
    }
    try {
      this.#killProcessGroup(groupId, "SIGKILL");
    } catch {
      return { code: null, uncertain: true };
    }
    const forced = await closeWithin(closed, this.#gracefulTimeoutMs);
    if (forced?.kind !== "closed") return { code: null, uncertain: true };
    return (await this.#waitForProcessGroupExit(child.pid!))
      ? { code: forced.code, uncertain: false }
      : { code: null, uncertain: true };
  }

  async #waitForProcessGroupExit(pid: number): Promise<boolean> {
    if (this.#receiptDirectory === undefined) return true;
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    const deadline = Date.now() + this.#gracefulTimeoutMs;
    while (this.#processGroupExists(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }

  async #removeReceiptWhenReleased(
    receipt: OwnedProcessReceiptHandle,
    pid: number | undefined,
  ): Promise<boolean> {
    const groupReleased = await this.#waitForProcessGroupExit(pid ?? -1);
    if (groupReleased) await receipt.remove();
    return groupReleased;
  }

  async #removeReceiptAfterProcessExit(
    receipt: OwnedProcessReceiptHandle,
    child: SpawnedProcess,
    closed: Promise<ProcessClose>,
  ): Promise<void> {
    if (await this.#waitForProcessGroupExit(child.pid ?? -1)) {
      await receipt.remove();
      return;
    }
    const cleanup = await this.#terminate(child, closed);
    if (!cleanup.uncertain) await receipt.remove();
  }
}

class CombinedOutputCapture {
  readonly #maximum: number;
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  #retained = 0;

  constructor(maximum: number) {
    this.#maximum = maximum + 1;
  }

  append(target: "stdout" | "stderr", chunk: unknown): void {
    if (this.#retained >= this.#maximum) return;
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk), "utf8");
    const retained = bytes.subarray(0, this.#maximum - this.#retained);
    if (retained.byteLength === 0) return;
    (target === "stdout" ? this.#stdout : this.#stderr).push(Buffer.from(retained));
    this.#retained += retained.byteLength;
  }

  result(): Pick<RepositoryTestProcessResult, "stdout" | "stderr" | "parserFailed"> {
    const stdout = Buffer.concat(this.#stdout);
    const stderr = Buffer.concat(this.#stderr);
    return {
      stdout: new Uint8Array(stdout),
      stderr: new Uint8Array(stderr),
      parserFailed: !validUtf8(stdout) || !validUtf8(stderr),
    };
  }
}

type ProcessClose =
  | {
      readonly kind: "closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "error" };

function observeClose(child: SpawnedProcess): Promise<ProcessClose> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProcessClose) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish({ kind: "error" }));
    child.once("close", (code, signal) => finish({ kind: "closed", code, signal }));
  });
}

async function firstSettlement(
  closed: Promise<ProcessClose>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessClose | { readonly kind: "timed-out" } | { readonly kind: "cancelled" }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const timedOut = new Promise<{ readonly kind: "timed-out" }>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ kind: "timed-out" }), timeoutMs);
    });
    const cancelled = new Promise<{ readonly kind: "cancelled" }>((resolveCancel) => {
      abort = () => resolveCancel({ kind: "cancelled" });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([closed, timedOut, cancelled]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function closeWithin(
  closed: Promise<ProcessClose>,
  timeoutMs: number,
): Promise<ProcessClose | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<undefined>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validateProcessInput(
  input: RepositoryTestProcessInput,
  maximumOutputBytes: number,
): { readonly executable: string; readonly args: readonly string[] } {
  validateLaunchInput(input, maximumOutputBytes);
  // A test command is one structured argv run without a shell, so an argument
  // such as `; touch x` stays a literal. A shell or `-c` here would turn that
  // argv back into a string something reinterprets.
  const executableName = basename(input.argv[0]!).toLowerCase();
  if (
    ["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe"].includes(
      executableName,
    ) ||
    input.argv.slice(1).includes("-c")
  )
    throw new Error("Repository test shell argv is unavailable.");
  return { executable: input.argv[0]!, args: input.argv.slice(1) };
}

function validateLaunchInput(input: RepositoryTestProcessInput, maximumOutputBytes: number): void {
  if (
    input.argv.length === 0 ||
    input.argv.length > MAX_ARGUMENTS ||
    !isAbsolute(input.cwd) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > MAX_REPOSITORY_TEST_OUTPUT_BYTES
  )
    throw new Error("Repository test process input is invalid.");
  for (const argument of input.argv) {
    if (
      argument.length === 0 ||
      argument.includes("\0") ||
      Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES
    )
      throw new Error("Repository test argv is invalid.");
  }
  for (const [name, value] of Object.entries(input.environment)) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
      value.includes("\0") ||
      unsafeEnvironmentName(name)
    )
      throw new Error("Repository test environment is invalid.");
  }
}

/**
 * The script must be a regular file in its own subdirectory of the script
 * directory, judged by resolved paths so neither a symlink nor `..` can point
 * the shell elsewhere, and that directory must not sit inside a root the
 * launch may write.
 */
async function resolveHarnessScript(
  directory: string,
  script: string,
  writableRoots: ReadonlyArray<string>,
): Promise<string> {
  if (!isAbsolute(script)) throw new Error("Harness shell script is not absolute.");
  const root = await realpath(directory);
  for (const writable of writableRoots) {
    const resolvedWritable = await realpath(writable);
    if (contained(resolvedWritable, root) || contained(root, resolvedWritable))
      throw new Error("Harness shell scripts overlap a writable root.");
  }
  const metadata = await lstat(script);
  if (!metadata.isFile()) throw new Error("Harness shell script is not a regular file.");
  const resolved = await realpath(script);
  const owner = dirname(resolved);
  if (owner === root || !contained(root, owner))
    throw new Error("Harness shell script is not in its own script subdirectory.");
  return resolved;
}

function unsafeEnvironmentName(name: string): boolean {
  return (
    name === "PATH" ||
    name === "NODE_OPTIONS" ||
    name === "BUN_OPTIONS" ||
    name === "GIT_ASKPASS" ||
    name === "SSH_ASKPASS" ||
    name === "GIT_SSH_COMMAND" ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_")
  );
}

const TEMPORARY_VARIABLES: ReadonlySet<string> = new Set(["TMPDIR", "TMP", "TEMP"]);

function sanitizedEnvironment(
  explicit: Readonly<Record<string, string>>,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT) {
    const value = process.env[name];
    if (value === undefined) continue;
    // An empty or relative temporary variable resolves beneath the checkout
    // inside the child and meets the sandbox's write denial there, although
    // the launch was given a usable temporary root.
    if (TEMPORARY_VARIABLES.has(name) && !isAbsolute(value)) continue;
    environment[name] = value;
  }
  if (environment.TMPDIR === undefined) environment.TMPDIR = temporaryDirectory;
  return { ...environment, ...explicit };
}

function validateArtifactInput(input: RepositoryTestArtifactReadInput): void {
  if (
    !isAbsolute(input.checkoutRoot) ||
    input.relativePath.length === 0 ||
    isAbsolute(input.relativePath) ||
    input.relativePath.includes("\0") ||
    input.relativePath.includes("\\") ||
    input.relativePath
      .split("/")
      .some((component) => component === "" || component === "." || component === "..") ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 0 ||
    input.maximumBytes > MAX_REPOSITORY_TEST_ARTIFACT_BYTES + 1
  )
    throw new Error("Repository test artifact input is invalid.");
}

async function rejectSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const component of relativePath.split("/")) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Artifact symlinks are unavailable.");
  }
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function validUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function supportsOwnedProcessGroups(platform: NodeJS.Platform): boolean {
  return ["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos"].includes(platform);
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function exited(
  code: number | null,
  output: CombinedOutputCapture,
  cleanupUncertain = false,
): RepositoryTestProcessResult {
  return {
    termination: "exited",
    exitCode: code,
    ...output.result(),
    cleanupUncertain,
  };
}

function unavailable(
  cleanupUncertain: boolean,
  output = new CombinedOutputCapture(MAX_REPOSITORY_TEST_OUTPUT_BYTES),
): RepositoryTestProcessResult {
  return {
    termination: "unavailable",
    exitCode: null,
    ...output.result(),
    cleanupUncertain,
  };
}

function cancelledBeforeSpawn(): RepositoryTestProcessResult {
  return {
    termination: "cancelled",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    parserFailed: false,
    cleanupUncertain: false,
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function resolveTestExecutable(command: string): Promise<string | undefined> {
  if (basename(command) !== command) return undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = await realpath(resolve(directory, command));
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      // Missing candidates are normal while searching the host's executable path.
    }
  }
  return undefined;
}
