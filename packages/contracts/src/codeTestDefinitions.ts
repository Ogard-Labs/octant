import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeTestRunId, CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { ProviderExecutionPolicy } from "./providers";

const encoder = new TextEncoder();
const MAX_TEST_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_REPOSITORY_TEST_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_REPOSITORY_TEST_ARTIFACT_BYTES = 64 * 1024 * 1024;

const CodeTestDefinitionId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("CodeTestDefinitionId"),
);
export type CodeTestDefinitionId = typeof CodeTestDefinitionId.Type;

function isCodeTestPath(value: string): boolean {
  return (
    value === "." ||
    (value.length > 0 &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      value === value.normalize("NFC") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."))
  );
}
const CodeTestPath = Schema.String.check(Schema.makeFilter(isCodeTestPath));
/**
 * Where a run starts: relative to the checkout, or the absolute path of an
 * extra folder of the Project, or a folder inside one. The host places an
 * absolute path in one of the Project's extra folders before it runs anything.
 */
const CodeTestWorkingDirectory = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      isCodeTestPath(value) ||
      (value.startsWith("/") && value.length > 1 && isCodeTestPath(value.slice(1))),
  ),
);
const ArtifactPath = CodeTestPath.check(Schema.makeFilter((value) => value !== "."));
const EnvironmentReference = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,127}$/));
const ArgvToken = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter(
    (value) =>
      !value.includes("\0") &&
      !["/bin/sh", "sh", "bash", "zsh", "fish", "cmd", "powershell", "-c"].includes(value),
  ),
);
const BoundedText = Schema.String.check(
  Schema.makeFilter(
    (value) => encoder.encode(value).byteLength <= MAX_REPOSITORY_TEST_OUTPUT_BYTES,
  ),
);
const GitObjectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));
const PositiveTimeout = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_TEST_TIMEOUT_MS }),
);

export const CodeTestPackageManager = Schema.Literals(["bun", "npm", "pnpm", "yarn"]);
export type CodeTestPackageManager = typeof CodeTestPackageManager.Type;

export const CodeRepositoryTestDefinitionSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("package-script"),
    packagePath: ArtifactPath,
    packageManager: CodeTestPackageManager,
    script: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  }),
  Schema.Struct({
    kind: Schema.Literal("octant-file"),
    path: Schema.Literal(".octant/tests.json"),
    selectedId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  }),
]);
export type CodeRepositoryTestDefinitionSource = typeof CodeRepositoryTestDefinitionSource.Type;

export const CodeRepositoryTestDefinition = Schema.Struct({
  id: CodeTestDefinitionId,
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  source: CodeRepositoryTestDefinitionSource,
  argv: Schema.NonEmptyArray(ArgvToken).check(Schema.makeFilter((argv) => argv.length <= 64)),
  cwd: CodeTestWorkingDirectory,
  environmentRefs: Schema.Array(EnvironmentReference).check(
    Schema.makeFilter((refs) => refs.length <= 64 && new Set(refs).size === refs.length),
  ),
  timeoutMs: PositiveTimeout,
  artifactPaths: Schema.Array(ArtifactPath).check(
    Schema.makeFilter((paths) => paths.length <= 128 && new Set(paths).size === paths.length),
  ),
});
export type CodeRepositoryTestDefinition = typeof CodeRepositoryTestDefinition.Type;

const CodeRepositoryTestDefinitionFileEntry = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  argv: Schema.NonEmptyArray(ArgvToken).check(Schema.makeFilter((argv) => argv.length <= 64)),
  cwd: CodeTestPath,
  environmentRefs: Schema.Array(EnvironmentReference).check(
    Schema.makeFilter((refs) => refs.length <= 64 && new Set(refs).size === refs.length),
  ),
  timeoutMs: PositiveTimeout,
  artifactPaths: Schema.Array(ArtifactPath).check(
    Schema.makeFilter((paths) => paths.length <= 128 && new Set(paths).size === paths.length),
  ),
});
export type CodeRepositoryTestDefinitionFileEntry =
  typeof CodeRepositoryTestDefinitionFileEntry.Type;

export const CodeRepositoryTestDefinitionFile = Schema.Struct({
  version: Schema.Literal(1),
  tests: Schema.NonEmptyArray(CodeRepositoryTestDefinitionFileEntry).check(
    Schema.makeFilter((tests) => new Set(tests.map((test) => test.id)).size === tests.length),
  ),
});
export type CodeRepositoryTestDefinitionFile = typeof CodeRepositoryTestDefinitionFile.Type;

/**
 * The repository tests a Code thread may run, as discovered by the host for one
 * checkout. The list is authoritative and may be empty: a repository with no
 * structured tests is an ordinary answer, not a failure. A renderer never
 * authors a definition — it selects one of these and submits it back.
 */
export const CodeRepositoryTestListing = Schema.Struct({
  kind: Schema.Literal("code-repository-test-listing"),
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  definitions: Schema.Array(CodeRepositoryTestDefinition),
  observedAt: UtcTimestamp,
});
export type CodeRepositoryTestListing = typeof CodeRepositoryTestListing.Type;

export const CodeRepositoryTestOutput = Schema.Struct({
  text: BoundedText,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
}).check(
  Schema.makeFilter((output) => encoder.encode(output.text).byteLength === output.byteLength),
);
export type CodeRepositoryTestOutput = typeof CodeRepositoryTestOutput.Type;

export const CodeRepositoryTestArtifact = Schema.Struct({
  path: ArtifactPath,
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_REPOSITORY_TEST_ARTIFACT_BYTES }),
  ),
  status: Schema.Literals(["retained", "missing", "truncated", "unavailable"]),
});
export type CodeRepositoryTestArtifact = typeof CodeRepositoryTestArtifact.Type;

export const CodeRepositoryTestConcern = Schema.Literals([
  "output-truncated",
  "artifact-truncated",
  "missing-artifact",
  "artifact-read-unavailable",
  "timeout",
  "parser-failed",
  "cleanup-uncertain",
]);
export type CodeRepositoryTestConcern = typeof CodeRepositoryTestConcern.Type;

export const CodeRepositoryTestRun = Schema.Struct({
  id: CodeTestRunId,
  definition: CodeRepositoryTestDefinition,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  checkoutRevision: GitObjectId,
  executionPolicy: ProviderExecutionPolicy,
  startedAt: UtcTimestamp,
  completedAt: UtcTimestamp,
  exitCode: Schema.NullOr(Schema.Int),
  termination: Schema.Literals(["exited", "cancelled", "timed-out", "unavailable"]),
  stdout: CodeRepositoryTestOutput,
  stderr: CodeRepositoryTestOutput,
  artifacts: Schema.Array(CodeRepositoryTestArtifact),
  verdict: Schema.Literals(["passed", "failed", "cancelled", "inconclusive", "unavailable"]),
  concerns: Schema.Array(CodeRepositoryTestConcern).check(
    Schema.makeFilter((concerns) => new Set(concerns).size === concerns.length),
  ),
});
export type CodeRepositoryTestRun = typeof CodeRepositoryTestRun.Type;

export const decodeCodeRepositoryTestDefinition = Schema.decodeUnknownSync(
  CodeRepositoryTestDefinition,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeRepositoryTestDefinitionFile = Schema.decodeUnknownSync(
  CodeRepositoryTestDefinitionFile,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeRepositoryTestListing = Schema.decodeUnknownSync(
  CodeRepositoryTestListing,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeRepositoryTestRun = Schema.decodeUnknownSync(
  CodeRepositoryTestRun,
  STRICT_DECODE_OPTIONS,
);
