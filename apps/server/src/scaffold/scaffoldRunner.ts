import {
  MAX_SCAFFOLD_OUTPUT_BYTES,
  decodeScaffoldRun,
  type ScaffoldEntry,
  type ScaffoldRun,
} from "@octant/contracts/scaffolds";
import type { CodeCheckoutId, CodeThreadId, ProviderExecutionPolicy } from "@octant/contracts";
import { planScaffold, scaffoldRefusalText } from "@octant/domain";

export interface ScaffoldProcessResult {
  readonly termination: "exited" | "cancelled" | "timed-out" | "unavailable";
  readonly exitCode: number | null;
  readonly output: Uint8Array;
}

export interface ScaffoldRunnerOptions {
  /**
   * Whether anything already answers to this name inside the checkout.
   *
   * A symlink counts: a scaffold that writes through one writes outside the
   * checkout, so the port reports the link itself rather than what it points
   * at, and any answer at all refuses the run.
   */
  readonly entryExists: (input: {
    readonly checkoutRoot: string;
    readonly name: string;
  }) => Promise<boolean>;
  readonly makeDirectory: (input: {
    readonly checkoutRoot: string;
    readonly name: string;
  }) => Promise<void>;
  /** Which of the tools the entries need this machine actually has. */
  readonly availableTools: () => Promise<ReadonlyArray<string>>;
  readonly execute: (
    input: {
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly timeoutMs: number;
    },
    signal?: AbortSignal,
  ) => Promise<ScaffoldProcessResult>;
  readonly now: () => string;
}

export interface ScaffoldRunInput {
  readonly runId: string;
  readonly entry: ScaffoldEntry;
  readonly directoryName: string;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly checkoutRoot: string;
  readonly signal?: AbortSignal;
}

export type ScaffoldRunResult =
  | { readonly status: "ran"; readonly run: ScaffoldRun }
  | { readonly status: "refused"; readonly message: string };

const SCAFFOLD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs one curated scaffold in a Code checkout.
 *
 * The runner never takes a command line: it takes an entry the host published
 * and asks the policy what that becomes here. Everything that could refuse —
 * Plan mode, a missing tool, a name already taken — is decided before a process
 * starts, so a refused scaffold leaves the checkout exactly as it found it.
 */
export class ScaffoldRunner {
  readonly #options: ScaffoldRunnerOptions;

  constructor(options: ScaffoldRunnerOptions) {
    this.#options = options;
  }

  async run(input: ScaffoldRunInput): Promise<ScaffoldRunResult> {
    const plan = planScaffold({
      entry: input.entry,
      directoryName: input.directoryName,
      posture: input.executionPolicy,
      availableTools: await this.#options.availableTools(),
      targetExists: await this.#options.entryExists({
        checkoutRoot: input.checkoutRoot,
        name: input.directoryName,
      }),
    });
    if (plan.status === "refused") {
      return { status: "refused", message: scaffoldRefusalText(plan.reason, input.entry) };
    }

    const startedAt = this.#options.now();
    let result: ScaffoldProcessResult;
    try {
      if (plan.hostCreatesDirectory) {
        await this.#options.makeDirectory({
          checkoutRoot: input.checkoutRoot,
          name: plan.createsPath,
        });
      }
      result = await this.#options.execute(
        {
          argv: plan.argv,
          cwd:
            plan.relativeCwd === "."
              ? input.checkoutRoot
              : `${input.checkoutRoot}/${plan.relativeCwd}`,
          timeoutMs: SCAFFOLD_TIMEOUT_MS,
        },
        input.signal,
      );
    } catch {
      result = { termination: "unavailable", exitCode: null, output: new Uint8Array() };
    }

    const output = boundedOutput(result.output);
    return {
      status: "ran",
      run: decodeScaffoldRun({
        id: input.runId,
        scaffoldId: input.entry.id,
        threadId: input.threadId,
        checkoutId: input.checkoutId,
        directoryName: input.directoryName,
        argv: plan.argv,
        startedAt,
        completedAt: this.#options.now(),
        exitCode: result.exitCode,
        termination: result.termination,
        output: output.text,
        outputTruncated: output.truncated,
        outcome: outcomeFor(result),
      }),
    };
  }
}

/**
 * What the run amounts to.
 *
 * Only a clean exit created a project. A generator that stopped partway leaves
 * a directory behind, and calling that "created" is how half a project gets
 * opened as a whole one.
 */
function outcomeFor(result: ScaffoldProcessResult): ScaffoldRun["outcome"] {
  if (result.termination === "cancelled") return "cancelled";
  if (result.termination === "unavailable") return "unavailable";
  return result.termination === "exited" && result.exitCode === 0 ? "created" : "failed";
}

function boundedOutput(bytes: Uint8Array): { readonly text: string; readonly truncated: boolean } {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { text: "", truncated: true };
  }
  const encoded = Buffer.from(decoded, "utf8");
  if (encoded.byteLength <= MAX_SCAFFOLD_OUTPUT_BYTES) return { text: decoded, truncated: false };
  let end = MAX_SCAFFOLD_OUTPUT_BYTES;
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}
