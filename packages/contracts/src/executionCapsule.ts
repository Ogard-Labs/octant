import { Schema } from "effect";
import { AgentRunId, AgentRunParentThreadId } from "./agentRun";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const ExecutionCapsuleId = brandedUuid("ExecutionCapsuleId");
export type ExecutionCapsuleId = typeof ExecutionCapsuleId.Type;

export const ExecutionCapsuleRecipeId = brandedUuid("ExecutionCapsuleRecipeId");
export type ExecutionCapsuleRecipeId = typeof ExecutionCapsuleRecipeId.Type;

export const ExecutionCapsuleExportId = brandedUuid("ExecutionCapsuleExportId");
export type ExecutionCapsuleExportId = typeof ExecutionCapsuleExportId.Type;

export const ExecutionCapsuleOwner = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("code-thread"),
    threadId: CodeThreadId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("agent-run"),
    runId: AgentRunId,
    parentThreadId: AgentRunParentThreadId,
  }).annotations(strict),
);
export type ExecutionCapsuleOwner = typeof ExecutionCapsuleOwner.Type;

export const ExecutionCapsuleImage = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/),
  Schema.brand("ExecutionCapsuleImage"),
);
export type ExecutionCapsuleImage = typeof ExecutionCapsuleImage.Type;

const ExecutionCapsuleSetupArgument = Schema.String.pipe(Schema.maxLength(4_096));
const ExecutionCapsuleSetupStep = Schema.Array(ExecutionCapsuleSetupArgument).pipe(
  Schema.minItems(1),
  Schema.maxItems(128),
);

export const ExecutionCapsuleRecipe = Schema.Struct({
  recipeId: ExecutionCapsuleRecipeId,
  revision: Schema.Int.pipe(Schema.between(1, 1_000_000)),
  image: ExecutionCapsuleImage,
  setup: Schema.Array(ExecutionCapsuleSetupStep).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type ExecutionCapsuleRecipe = typeof ExecutionCapsuleRecipe.Type;

export const ExecutionCapsuleResourceBudget = Schema.Struct({
  cpuMillicores: Schema.Int.pipe(Schema.between(100, 64_000)),
  memoryBytes: Schema.Int.pipe(Schema.between(128 * 1_024 * 1_024, 1_024 ** 4)),
  diskBytes: Schema.Int.pipe(Schema.between(256 * 1_024 * 1_024, 16 * 1_024 ** 4)),
  pidLimit: Schema.Int.pipe(Schema.between(16, 32_768)),
}).annotations(strict);
export type ExecutionCapsuleResourceBudget = typeof ExecutionCapsuleResourceBudget.Type;

export const ExecutionCapsuleAcquireRequest = Schema.Struct({
  capsuleId: ExecutionCapsuleId,
  owner: ExecutionCapsuleOwner,
  projectId: ProjectId,
  recipe: ExecutionCapsuleRecipe,
  budget: ExecutionCapsuleResourceBudget,
}).annotations(strict);
export type ExecutionCapsuleAcquireRequest = typeof ExecutionCapsuleAcquireRequest.Type;

export const ExecutionCapsuleBackend = Schema.Literal("gvisor-systrap");
export type ExecutionCapsuleBackend = typeof ExecutionCapsuleBackend.Type;

export const ExecutionCapsuleLifecycleStatus = Schema.Literal(
  "preparing",
  "ready",
  "stopped",
  "released",
  "unavailable",
);
export type ExecutionCapsuleLifecycleStatus = typeof ExecutionCapsuleLifecycleStatus.Type;

export const ExecutionCapsuleReceipt = Schema.Struct({
  capsuleId: ExecutionCapsuleId,
  owner: ExecutionCapsuleOwner,
  projectId: ProjectId,
  recipeId: ExecutionCapsuleRecipeId,
  recipeRevision: Schema.Int.pipe(Schema.between(1, 1_000_000)),
  backend: ExecutionCapsuleBackend,
  status: ExecutionCapsuleLifecycleStatus,
}).annotations(strict);
export type ExecutionCapsuleReceipt = typeof ExecutionCapsuleReceipt.Type;

export const ExecutionCapsuleGitBundleReceipt = Schema.Struct({
  exportId: ExecutionCapsuleExportId,
  capsuleId: ExecutionCapsuleId,
  kind: Schema.Literal("git-bundle"),
  sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Int.pipe(Schema.between(1, 1_024 * 1_024 * 1_024)),
  headRevision: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)),
  verified: Schema.Literal(true),
}).annotations(strict);
export type ExecutionCapsuleGitBundleReceipt = typeof ExecutionCapsuleGitBundleReceipt.Type;

export const decodeExecutionCapsuleId = Schema.decodeUnknownSync(ExecutionCapsuleId);
export const decodeExecutionCapsuleRecipeId = Schema.decodeUnknownSync(ExecutionCapsuleRecipeId);
export const decodeExecutionCapsuleExportId = Schema.decodeUnknownSync(ExecutionCapsuleExportId);
export const decodeExecutionCapsuleOwner = Schema.decodeUnknownSync(ExecutionCapsuleOwner);
export const decodeExecutionCapsuleImage = Schema.decodeUnknownSync(ExecutionCapsuleImage);
export const decodeExecutionCapsuleRecipe = Schema.decodeUnknownSync(ExecutionCapsuleRecipe);
export const decodeExecutionCapsuleResourceBudget = Schema.decodeUnknownSync(
  ExecutionCapsuleResourceBudget,
);
export const decodeExecutionCapsuleAcquireRequest = Schema.decodeUnknownSync(
  ExecutionCapsuleAcquireRequest,
);
export const decodeExecutionCapsuleBackend = Schema.decodeUnknownSync(ExecutionCapsuleBackend);
export const decodeExecutionCapsuleLifecycleStatus = Schema.decodeUnknownSync(
  ExecutionCapsuleLifecycleStatus,
);
export const decodeExecutionCapsuleReceipt = Schema.decodeUnknownSync(ExecutionCapsuleReceipt);
export const decodeExecutionCapsuleGitBundleReceipt = Schema.decodeUnknownSync(
  ExecutionCapsuleGitBundleReceipt,
);
