import {
  MAX_REPOSITORY_TEST_ARTIFACT_BYTES,
  MAX_REPOSITORY_TEST_OUTPUT_BYTES,
  decodeCodeRepositoryTestDefinition,
  decodeCodeRepositoryTestRun,
  type CodeCheckoutId,
  type CodeRepositoryTestArtifact,
  type CodeRepositoryTestDefinition,
  type CodeRepositoryTestOutput,
  type CodeRepositoryTestRun,
  type CodeThreadId,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { realpath as nodeRealpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface RepositoryTestProcessResult {
  readonly termination: "exited" | "cancelled" | "timed-out" | "unavailable";
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly parserFailed: boolean;
  readonly cleanupUncertain: boolean;
}

export interface RepositoryTestRunnerOptions {
  readonly realpath?: (path: string) => Promise<string>;
  readonly execute: (
    input: {
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
    signal?: AbortSignal,
  ) => Promise<RepositoryTestProcessResult>;
  readonly readArtifact: (input: {
    readonly checkoutRoot: string;
    readonly relativePath: string;
    readonly maximumBytes: number;
  }) => Promise<Uint8Array | undefined>;
  readonly now: () => string;
  readonly newId: () => string;
}

export interface RepositoryTestRunInput {
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly definition: CodeRepositoryTestDefinition;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly checkoutRevision: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly checkoutRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export class RepositoryTestRunner {
  readonly #options: RepositoryTestRunnerOptions;

  constructor(options: RepositoryTestRunnerOptions) {
    this.#options = options;
  }

  async run(input: RepositoryTestRunInput): Promise<CodeRepositoryTestRun> {
    const definition = decodeCodeRepositoryTestDefinition(input.definition);
    const startedAt = this.#options.now();
    const environment = selectedEnvironment(definition.environmentRefs, input.environment);
    let result: RepositoryTestProcessResult;
    try {
      const cwd = await privateWorkingDirectory(
        input.checkoutRoot,
        definition.cwd,
        this.#options.realpath ?? nodeRealpath,
      );
      result = await this.#options.execute(
        { argv: definition.argv, cwd, environment, timeoutMs: definition.timeoutMs },
        input.signal,
      );
    } catch {
      result = unavailableProcessResult();
    }
    const output = boundedOutput(
      result.stdout,
      result.stderr,
      Object.values(environment).filter((value) => value.length > 0),
    );
    const artifacts = await retainedArtifacts(
      definition.artifactPaths,
      input.checkoutRoot,
      this.#options.readArtifact,
    );
    const concerns = concernsFor(result, output, artifacts);
    return decodeCodeRepositoryTestRun({
      id: input.runId ?? this.#options.newId(),
      definition,
      threadId: input.threadId,
      checkoutId: input.checkoutId,
      checkoutRevision: input.checkoutRevision,
      executionPolicy: input.executionPolicy,
      startedAt,
      completedAt: this.#options.now(),
      exitCode: result.exitCode,
      termination: result.termination,
      stdout: output.stdout,
      stderr: output.stderr,
      artifacts,
      verdict: verdictFor(result, concerns),
      concerns,
    });
  }
}

function selectedEnvironment(
  references: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    references.flatMap((reference) =>
      typeof environment[reference] === "string" ? [[reference, environment[reference]]] : [],
    ),
  );
}

async function privateWorkingDirectory(
  root: string,
  cwd: string,
  realpath: (path: string) => Promise<string>,
): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalWorkingDirectory = await realpath(resolve(canonicalRoot, cwd));
  const fromRoot = relative(canonicalRoot, canonicalWorkingDirectory);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error("Repository test working directory is outside the checkout.");
  return canonicalWorkingDirectory;
}

function unavailableProcessResult(): RepositoryTestProcessResult {
  return {
    termination: "unavailable",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    parserFailed: false,
    cleanupUncertain: false,
  };
}

function boundedOutput(
  stdout: Uint8Array,
  stderr: Uint8Array,
  secrets: ReadonlyArray<string>,
): {
  readonly stdout: CodeRepositoryTestOutput;
  readonly stderr: CodeRepositoryTestOutput;
  readonly parserFailed: boolean;
} {
  const first = retainOutput(stdout, MAX_REPOSITORY_TEST_OUTPUT_BYTES, secrets);
  const second = retainOutput(
    stderr,
    MAX_REPOSITORY_TEST_OUTPUT_BYTES - first.output.byteLength,
    secrets,
  );
  return {
    stdout: first.output,
    stderr: second.output,
    parserFailed: first.parserFailed || second.parserFailed,
  };
}

function retainOutput(
  bytes: Uint8Array,
  maximumBytes: number,
  secrets: ReadonlyArray<string>,
): { readonly output: CodeRepositoryTestOutput; readonly parserFailed: boolean } {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { output: { text: "", byteLength: 0, truncated: true }, parserFailed: true };
  }
  for (const secret of secrets) decoded = decoded.replaceAll(secret, "[REDACTED]");
  const encoded = Buffer.from(decoded, "utf8");
  let end = Math.min(encoded.byteLength, Math.max(0, maximumBytes));
  while (end > 0 && end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const text = encoded.subarray(0, end).toString("utf8");
  return {
    output: {
      text,
      byteLength: end,
      truncated: end !== encoded.byteLength,
    },
    parserFailed: false,
  };
}

async function retainedArtifacts(
  paths: ReadonlyArray<string>,
  checkoutRoot: string,
  readArtifact: RepositoryTestRunnerOptions["readArtifact"],
): Promise<ReadonlyArray<CodeRepositoryTestArtifact>> {
  let remaining = MAX_REPOSITORY_TEST_ARTIFACT_BYTES;
  const artifacts: CodeRepositoryTestArtifact[] = [];
  for (const path of paths) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readArtifact({ checkoutRoot, relativePath: path, maximumBytes: remaining + 1 });
    } catch {
      artifacts.push({ path, byteLength: 0, status: "unavailable" });
      continue;
    }
    if (bytes === undefined) {
      artifacts.push({ path, byteLength: 0, status: "missing" });
      continue;
    }
    const retained = Math.min(bytes.byteLength, remaining);
    remaining -= retained;
    artifacts.push({
      path,
      byteLength: retained,
      status: retained === bytes.byteLength ? "retained" : "truncated",
    });
  }
  return artifacts;
}

function concernsFor(
  result: RepositoryTestProcessResult,
  output: {
    readonly stdout: CodeRepositoryTestOutput;
    readonly stderr: CodeRepositoryTestOutput;
    readonly parserFailed: boolean;
  },
  artifacts: ReadonlyArray<CodeRepositoryTestArtifact>,
): Array<CodeRepositoryTestRun["concerns"][number]> {
  const concerns: Array<CodeRepositoryTestRun["concerns"][number]> = [];
  if (output.stdout.truncated || output.stderr.truncated) concerns.push("output-truncated");
  if (artifacts.some(({ status }) => status === "truncated")) concerns.push("artifact-truncated");
  if (artifacts.some(({ status }) => status === "missing")) concerns.push("missing-artifact");
  if (artifacts.some(({ status }) => status === "unavailable")) {
    concerns.push("artifact-read-unavailable");
  }
  if (result.termination === "timed-out") concerns.push("timeout");
  if (result.parserFailed || output.parserFailed) concerns.push("parser-failed");
  if (result.cleanupUncertain) concerns.push("cleanup-uncertain");
  return concerns;
}

function verdictFor(
  result: RepositoryTestProcessResult,
  concerns: ReadonlyArray<CodeRepositoryTestRun["concerns"][number]>,
): CodeRepositoryTestRun["verdict"] {
  if (result.termination === "unavailable") return "unavailable";
  if (result.termination === "cancelled") return "cancelled";
  if (concerns.length > 0 || result.termination === "timed-out") return "inconclusive";
  return result.exitCode === 0 ? "passed" : "failed";
}
