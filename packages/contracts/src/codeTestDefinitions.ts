import { Schema } from "effect";
import { CodeCheckoutId, CodeTestRunId, CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { ProviderExecutionPolicy } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const MAX_TEST_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_REPOSITORY_TEST_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_REPOSITORY_TEST_ARTIFACT_BYTES = 64 * 1024 * 1024;

const CodeTestDefinitionId = Schema.UUID.pipe(Schema.brand("CodeTestDefinitionId"));
export type CodeTestDefinitionId = typeof CodeTestDefinitionId.Type;

const CodeTestPath = Schema.String.pipe(
  Schema.filter(
    (value) =>
      value === "." ||
      (value.length > 0 &&
        !value.includes("\0") &&
        !value.includes("\\") &&
        !value.startsWith("/") &&
        !value.endsWith("/") &&
        value === value.normalize("NFC") &&
        value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")),
  ),
);
const ArtifactPath = CodeTestPath.pipe(Schema.filter((value) => value !== "."));
const EnvironmentReference = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]{0,127}$/));
const ArgvToken = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(1_024),
  Schema.filter(
    (value) =>
      !value.includes("\0") &&
      !["/bin/sh", "sh", "bash", "zsh", "fish", "cmd", "powershell", "-c"].includes(value),
  ),
);
const BoundedText = Schema.String.pipe(
  Schema.filter((value) => encoder.encode(value).byteLength <= MAX_REPOSITORY_TEST_OUTPUT_BYTES),
);
const GitObjectId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));
const PositiveTimeout = Schema.Int.pipe(Schema.between(1, MAX_TEST_TIMEOUT_MS));

export const CodeTestPackageManager = Schema.Literal("bun", "npm", "pnpm", "yarn");
export type CodeTestPackageManager = typeof CodeTestPackageManager.Type;

export const CodeRepositoryTestDefinitionSource = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("package-script"),
    packagePath: ArtifactPath,
    packageManager: CodeTestPackageManager,
    script: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("octant-file"),
    path: Schema.Literal(".octant/tests.json"),
    selectedId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  }).annotations(strict),
);
export type CodeRepositoryTestDefinitionSource = typeof CodeRepositoryTestDefinitionSource.Type;

export const CodeRepositoryTestDefinition = Schema.Struct({
  id: CodeTestDefinitionId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  source: CodeRepositoryTestDefinitionSource,
  argv: Schema.NonEmptyArray(ArgvToken).pipe(Schema.filter((argv) => argv.length <= 64)),
  cwd: CodeTestPath,
  environmentRefs: Schema.Array(EnvironmentReference).pipe(
    Schema.filter((refs) => refs.length <= 64 && new Set(refs).size === refs.length),
  ),
  timeoutMs: PositiveTimeout,
  artifactPaths: Schema.Array(ArtifactPath).pipe(
    Schema.filter((paths) => paths.length <= 128 && new Set(paths).size === paths.length),
  ),
}).annotations(strict);
export type CodeRepositoryTestDefinition = typeof CodeRepositoryTestDefinition.Type;

const CodeRepositoryTestDefinitionFileEntry = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  argv: Schema.NonEmptyArray(ArgvToken).pipe(Schema.filter((argv) => argv.length <= 64)),
  cwd: CodeTestPath,
  environmentRefs: Schema.Array(EnvironmentReference).pipe(
    Schema.filter((refs) => refs.length <= 64 && new Set(refs).size === refs.length),
  ),
  timeoutMs: PositiveTimeout,
  artifactPaths: Schema.Array(ArtifactPath).pipe(
    Schema.filter((paths) => paths.length <= 128 && new Set(paths).size === paths.length),
  ),
}).annotations(strict);
export type CodeRepositoryTestDefinitionFileEntry =
  typeof CodeRepositoryTestDefinitionFileEntry.Type;

export const CodeRepositoryTestDefinitionFile = Schema.Struct({
  version: Schema.Literal(1),
  tests: Schema.NonEmptyArray(CodeRepositoryTestDefinitionFileEntry).pipe(
    Schema.filter((tests) => new Set(tests.map((test) => test.id)).size === tests.length),
  ),
}).annotations(strict);
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
}).annotations(strict);
export type CodeRepositoryTestListing = typeof CodeRepositoryTestListing.Type;

export const CodeRepositoryTestOutput = Schema.Struct({
  text: BoundedText,
  byteLength: Schema.Int.pipe(Schema.nonNegative()),
  truncated: Schema.Boolean,
})
  .annotations(strict)
  .pipe(Schema.filter((output) => encoder.encode(output.text).byteLength === output.byteLength));
export type CodeRepositoryTestOutput = typeof CodeRepositoryTestOutput.Type;

export const CodeRepositoryTestArtifact = Schema.Struct({
  path: ArtifactPath,
  byteLength: Schema.Int.pipe(Schema.between(0, MAX_REPOSITORY_TEST_ARTIFACT_BYTES)),
  status: Schema.Literal("retained", "missing", "truncated", "unavailable"),
}).annotations(strict);
export type CodeRepositoryTestArtifact = typeof CodeRepositoryTestArtifact.Type;

export const CodeRepositoryTestConcern = Schema.Literal(
  "output-truncated",
  "artifact-truncated",
  "missing-artifact",
  "artifact-read-unavailable",
  "timeout",
  "parser-failed",
  "cleanup-uncertain",
);
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
  termination: Schema.Literal("exited", "cancelled", "timed-out", "unavailable"),
  stdout: CodeRepositoryTestOutput,
  stderr: CodeRepositoryTestOutput,
  artifacts: Schema.Array(CodeRepositoryTestArtifact),
  verdict: Schema.Literal("passed", "failed", "cancelled", "inconclusive", "unavailable"),
  concerns: Schema.Array(CodeRepositoryTestConcern).pipe(
    Schema.filter((concerns) => new Set(concerns).size === concerns.length),
  ),
}).annotations(strict);
export type CodeRepositoryTestRun = typeof CodeRepositoryTestRun.Type;

export const decodeCodeRepositoryTestDefinition = Schema.decodeUnknownSync(
  CodeRepositoryTestDefinition,
);
export const decodeCodeRepositoryTestDefinitionFile = Schema.decodeUnknownSync(
  CodeRepositoryTestDefinitionFile,
);
export const decodeCodeRepositoryTestListing = Schema.decodeUnknownSync(CodeRepositoryTestListing);
export const decodeCodeRepositoryTestRun = Schema.decodeUnknownSync(CodeRepositoryTestRun);
