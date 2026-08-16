import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import {
  decodeProjectRank,
  type BindingRevisionId,
  type BoundProject,
  type CanonicalProjectBinding,
  type ChatProject,
  type CodeProject,
  type CodeAccessPersistence,
  type WorkProject,
  type Project,
  type ProjectActor,
  type ProjectId,
  type ProjectLifecycle,
  type ProjectRank,
} from "@octant/contracts/projects";

export type ProjectPolicyRejectionCode =
  | "binding-not-allowed"
  | "binding-revision-conflict"
  | "binding-unchanged"
  | "invalid-lifecycle"
  | "invalid-name"
  | "invalid-neighbor"
  | "invalid-rank"
  | "relink-not-allowed";

export class ProjectPolicyRejected extends Error {
  override readonly name = "ProjectPolicyRejected";

  constructor(
    readonly code: ProjectPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function reject(code: ProjectPolicyRejectionCode, message: string): never {
  throw new ProjectPolicyRejected(code, message);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function normalizeRank(numerator: bigint, denominator: bigint): ProjectRank {
  if (denominator === 0n) reject("invalid-rank", "Project rank denominator cannot be zero");
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  const token = `${normalizedNumerator / divisor}/${normalizedDenominator / divisor}`;
  try {
    return decodeProjectRank(token);
  } catch {
    return reject("invalid-rank", "Project rank is not canonical");
  }
}

function parseRank(rank: ProjectRank): Rational {
  if (!/^-?(?:0|[1-9]\d*)\/[1-9]\d*$/.test(rank)) {
    return reject("invalid-rank", "Project rank is malformed");
  }
  const [numeratorText, denominatorText] = rank.split("/") as [string, string];
  const numerator = BigInt(numeratorText);
  const denominator = BigInt(denominatorText);
  if (numeratorText === "-0" || gcd(numerator, denominator) !== 1n) {
    return reject("invalid-rank", "Project rank is not canonical");
  }
  return { numerator, denominator };
}

function compareRank(left: ProjectRank, right: ProjectRank): number {
  const leftValue = parseRank(left);
  const rightValue = parseRank(right);
  const comparison =
    leftValue.numerator * rightValue.denominator - rightValue.numerator * leftValue.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function nextVersion(project: Project): AggregateVersion {
  return (project.version + 1) as AggregateVersion;
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) reject("invalid-name", "Project name cannot be empty");
  return normalized;
}

interface CreateProjectFields {
  readonly id: ProjectId;
  readonly name: string;
  readonly rank: ProjectRank;
  readonly createdAt: UtcTimestamp;
}

type CreateChatProjectInput = CreateProjectFields & { readonly type: "chat" };
type CreateBoundProjectFields = CreateProjectFields & {
  readonly binding: CanonicalProjectBinding;
  readonly revisionId: BindingRevisionId;
  readonly actor: ProjectActor;
};
type CreateWorkProjectInput = CreateBoundProjectFields & { readonly type: "work" };
type CreateCodeProjectInput = CreateBoundProjectFields & { readonly type: "code" };
export type CreateProjectInput =
  | CreateChatProjectInput
  | CreateWorkProjectInput
  | CreateCodeProjectInput;

export function createProject(input: CreateChatProjectInput): ChatProject;
export function createProject(input: CreateWorkProjectInput): WorkProject;
export function createProject(input: CreateCodeProjectInput): CodeProject;
export function createProject(input: CreateProjectInput): Project;
export function createProject(input: CreateProjectInput): Project {
  const name = normalizeName(input.name);
  parseRank(input.rank);
  const common = {
    id: input.id,
    name,
    lifecycle: "active" as const,
    pinned: false,
    rank: input.rank,
    version: 1 as AggregateVersion,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  if (input.type === "chat") {
    if ("binding" in input || "revisionId" in input || "actor" in input) {
      reject("binding-not-allowed", "Chat Projects cannot have a root binding");
    }
    return { ...common, type: "chat" };
  }
  const bindingHistory = [
    {
      revisionId: input.revisionId,
      revision: 1,
      currentBinding: input.binding,
      actor: input.actor,
      changedAt: input.createdAt,
    },
  ] as const;
  if (input.type === "work") {
    return { ...common, type: "work", binding: input.binding, bindingHistory };
  }
  return {
    ...common,
    type: "code",
    binding: input.binding,
    bindingHistory,
    codeAccessPersistence: "current-session",
  };
}

export function renameProject(project: Project, name: string, updatedAt: UtcTimestamp): Project {
  return {
    ...project,
    name: normalizeName(name),
    version: nextVersion(project),
    updatedAt,
  };
}

export function changeCodeProjectAccess(
  project: Project,
  codeAccessPersistence: CodeAccessPersistence,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    reject("binding-not-allowed", "Only Code Projects have an access persistence policy");
  }
  if (project.codeAccessPersistence === codeAccessPersistence) {
    reject("invalid-lifecycle", "Code Project access persistence is already selected");
  }
  return {
    ...project,
    codeAccessPersistence,
    version: nextVersion(project),
    updatedAt,
  };
}

export function changeProjectLifecycle(
  project: Project,
  lifecycle: ProjectLifecycle,
  updatedAt: UtcTimestamp,
): Project {
  if (project.lifecycle === lifecycle) {
    reject("invalid-lifecycle", `Project is already ${lifecycle}`);
  }
  return { ...project, lifecycle, version: nextVersion(project), updatedAt };
}

export interface RelinkProjectInput {
  readonly previousBindingRevision: number;
  readonly binding: CanonicalProjectBinding;
  readonly revisionId: BindingRevisionId;
  readonly actor: ProjectActor;
  readonly changedAt: UtcTimestamp;
}

export function relinkProject(project: Project, input: RelinkProjectInput): BoundProject {
  if (project.type === "chat") {
    reject("relink-not-allowed", "Chat Projects cannot be relinked");
  }
  const currentRevision = project.bindingHistory.at(-1);
  if (
    currentRevision === undefined ||
    currentRevision.currentBinding.canonicalRoot !== project.binding.canonicalRoot
  ) {
    reject("binding-revision-conflict", "Project binding history does not match its binding");
  }
  if (currentRevision.revision !== input.previousBindingRevision) {
    reject("binding-revision-conflict", "Project binding revision has changed");
  }
  if (input.binding.canonicalRoot === project.binding.canonicalRoot) {
    reject("binding-unchanged", "Replacement root must differ from the current root");
  }
  const revision = {
    revisionId: input.revisionId,
    revision: currentRevision.revision + 1,
    previousBinding: project.binding,
    currentBinding: input.binding,
    actor: input.actor,
    changedAt: input.changedAt,
  };
  return {
    ...project,
    binding: input.binding,
    bindingHistory: [...project.bindingHistory, revision],
    version: nextVersion(project),
    updatedAt: input.changedAt,
  };
}

export function rankBetween(left?: ProjectRank, right?: ProjectRank): ProjectRank {
  if (left === undefined && right === undefined) return decodeProjectRank("0/1");
  if (left === undefined) {
    const rightValue = parseRank(right!);
    return normalizeRank(rightValue.numerator - rightValue.denominator, rightValue.denominator);
  }
  const leftValue = parseRank(left);
  if (right === undefined) {
    return normalizeRank(leftValue.numerator + leftValue.denominator, leftValue.denominator);
  }
  const rightValue = parseRank(right);
  if (compareRank(left, right) >= 0) {
    reject("invalid-rank", "Project rank neighbors must be strictly ascending");
  }
  return normalizeRank(
    leftValue.numerator + rightValue.numerator,
    leftValue.denominator + rightValue.denominator,
  );
}

export function compareProjectOrder(left: Project, right: Project): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const rankComparison = compareRank(left.rank, right.rank);
  if (rankComparison !== 0) return rankComparison;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface MoveProjectInput {
  readonly pinned: boolean;
  readonly beforeProject?: Project;
  readonly afterProject?: Project;
  readonly updatedAt: UtcTimestamp;
}

function validateMoveNeighbor(
  current: Project,
  neighbor: Project | undefined,
  pinned: boolean,
): void {
  if (neighbor === undefined) return;
  if (neighbor.id === current.id) reject("invalid-neighbor", "A Project cannot neighbor itself");
  if (neighbor.type !== current.type) {
    reject("invalid-neighbor", "Move neighbors must belong to the same mode");
  }
  if (neighbor.lifecycle !== current.lifecycle) {
    reject("invalid-neighbor", "Move neighbors must have the same lifecycle");
  }
  if (neighbor.pinned !== pinned) {
    reject("invalid-neighbor", "Move neighbors must belong to the requested pin lane");
  }
}

export function moveProject(project: Project, input: MoveProjectInput): Project {
  validateMoveNeighbor(project, input.beforeProject, input.pinned);
  validateMoveNeighbor(project, input.afterProject, input.pinned);
  if (
    input.beforeProject !== undefined &&
    input.afterProject !== undefined &&
    input.beforeProject.id === input.afterProject.id
  ) {
    reject("invalid-neighbor", "Move neighbors must be distinct");
  }
  const rank = rankBetween(input.beforeProject?.rank, input.afterProject?.rank);
  return {
    ...project,
    pinned: input.pinned,
    rank,
    version: nextVersion(project),
    updatedAt: input.updatedAt,
  };
}
