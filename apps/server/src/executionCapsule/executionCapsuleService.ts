import { randomUUID } from "node:crypto";
import {
  decodeExecutionCapsuleExportId,
  decodeExecutionCapsuleGitBundleReceipt,
  decodeExecutionCapsuleReceipt,
  type ExecutionCapsuleAcquireRequest,
  type ExecutionCapsuleExportId,
  type ExecutionCapsuleGitBundleReceipt,
  type ExecutionCapsuleId,
  type ExecutionCapsuleOwner,
  type ExecutionCapsuleReceipt,
  type ExecutionCapsuleResourceBudget,
} from "@octant/contracts/execution-capsule";
import {
  planExecutionCapsuleAdmission,
  type ExecutionCapsuleAvailableCapacity,
  type ExecutionCapsuleHostCapabilities,
} from "@octant/domain/execution-capsule-policy";

export interface ExecutionCapsuleSource {
  readonly bundlePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly revision: string;
}

export interface ExecutionCapsuleDriverProbe {
  readonly host: ExecutionCapsuleHostCapabilities;
  readonly available: ExecutionCapsuleAvailableCapacity;
}

export interface ExecutionCapsuleDriverCreateInput {
  readonly request: ExecutionCapsuleAcquireRequest;
  readonly source: ExecutionCapsuleSource;
}

export type ExecutionCapsuleDriverCreateResult =
  | { readonly status: "ready"; readonly runtimeId: string }
  | {
      readonly status: "refused";
      readonly reason: "source-unavailable" | "runtime-unavailable" | "creation-failed";
    };

export interface ExecutionCapsuleDriverExecuteInput {
  readonly runtimeId: string;
  readonly argv: ReadonlyArray<string>;
}

export type ExecutionCapsuleCommandResult =
  | {
      readonly status: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly status: "failed"; readonly reason: "runtime-unavailable" }
  | {
      readonly status: "refused";
      readonly reason: "capsule-unavailable" | "invalid-command";
    };

export type ExecutionCapsuleDriverExportResult =
  | {
      readonly status: "exported";
      readonly artifactPath: string;
      readonly sha256: string;
      readonly byteLength: number;
      readonly headRevision: string;
    }
  | { readonly status: "failed"; readonly reason: "export-failed" };

export interface ExecutionCapsuleDriver {
  readonly probe: () => Promise<ExecutionCapsuleDriverProbe>;
  readonly create: (
    input: ExecutionCapsuleDriverCreateInput,
  ) => Promise<ExecutionCapsuleDriverCreateResult>;
  readonly execute: (
    input: ExecutionCapsuleDriverExecuteInput,
  ) => Promise<Exclude<ExecutionCapsuleCommandResult, { readonly status: "refused" }>>;
  readonly exportGitBundle: (input: {
    readonly runtimeId: string;
  }) => Promise<ExecutionCapsuleDriverExportResult>;
  readonly release: (input: {
    readonly runtimeId: string;
  }) => Promise<
    | { readonly status: "released" }
    | { readonly status: "failed"; readonly reason: "release-failed" }
  >;
  readonly stop: (input: {
    readonly runtimeId: string;
  }) => Promise<
    { readonly status: "stopped" } | { readonly status: "failed"; readonly reason: "stop-failed" }
  >;
  readonly recover: (
    input: ExecutionCapsuleDriverCreateInput,
  ) => Promise<
    | { readonly status: "stopped"; readonly runtimeId: string }
    | { readonly status: "refused"; readonly reason: "runtime-unavailable" | "source-unavailable" }
  >;
  readonly verifyRecoveredExport: (input: OwnedExport) => Promise<boolean>;
  readonly discardCreated: (input: {
    readonly capsuleId: ExecutionCapsuleId;
    readonly runtimeId: string;
  }) => Promise<void>;
}

export type ExecutionCapsuleAcquireResult =
  | { readonly status: "ready"; readonly receipt: ExecutionCapsuleReceipt }
  | { readonly status: "queued"; readonly reason: "capacity-unavailable" }
  | {
      readonly status: "refused";
      readonly reason:
        | "protected-runtime-unavailable"
        | "unsafe-host-identity"
        | "source-unavailable"
        | "runtime-unavailable"
        | "creation-failed"
        | "owner-already-bound"
        | "runtime-identity-conflict";
    };

export interface ExecutionCapsuleServiceOptions {
  readonly driver: ExecutionCapsuleDriver;
  readonly createExportId?: () => string;
  readonly revalidateRecovery?: (input: {
    readonly request: ExecutionCapsuleAcquireRequest;
    readonly source: ExecutionCapsuleSource;
  }) => Promise<
    | { readonly status: "valid" }
    | { readonly status: "refused"; readonly reason: "authority-drift" }
  >;
}

interface OwnedCapsule {
  readonly receipt: ExecutionCapsuleReceipt;
  readonly runtimeId: string;
  readonly budget: ExecutionCapsuleResourceBudget;
  readonly request: ExecutionCapsuleAcquireRequest;
  readonly source: ExecutionCapsuleSource;
}

interface OwnedExport {
  readonly receipt: ExecutionCapsuleGitBundleReceipt;
  readonly artifactPath: string;
}

export interface ExecutionCapsuleRecoveryRecord {
  readonly request: ExecutionCapsuleAcquireRequest;
  readonly source: ExecutionCapsuleSource;
  readonly exports: ReadonlyArray<OwnedExport>;
}

export type ExecutionCapsuleRecoveryRecordResult =
  | { readonly status: "ready"; readonly record: ExecutionCapsuleRecoveryRecord }
  | { readonly status: "refused"; readonly reason: "capsule-unavailable" };

export type ExecutionCapsuleExportResult =
  | { readonly status: "exported"; readonly receipt: ExecutionCapsuleGitBundleReceipt }
  | { readonly status: "refused"; readonly reason: "capsule-unavailable" }
  | { readonly status: "failed"; readonly reason: "export-failed" };

export type ExecutionCapsuleReleaseResult =
  | { readonly status: "released"; readonly receipt: ExecutionCapsuleReceipt }
  | {
      readonly status: "refused";
      readonly reason: "capsule-unavailable" | "export-required";
    }
  | { readonly status: "failed"; readonly reason: "release-failed" };

export type ExecutionCapsuleStopResult =
  | { readonly status: "stopped"; readonly receipt: ExecutionCapsuleReceipt }
  | { readonly status: "refused"; readonly reason: "capsule-unavailable" }
  | { readonly status: "failed"; readonly reason: "stop-failed" };

export type ExecutionCapsuleRecoverResult =
  | { readonly status: "stopped"; readonly receipt: ExecutionCapsuleReceipt }
  | {
      readonly status: "refused";
      readonly reason:
        | "protected-runtime-unavailable"
        | "unsafe-host-identity"
        | "capacity-unavailable"
        | "owner-already-bound"
        | "runtime-identity-conflict"
        | "runtime-unavailable"
        | "source-unavailable"
        | "authority-drift";
    };

/**
 * Owns the one-to-one relationship between a Code execution owner and a
 * protected runtime. Runtime names and paths never leave this service.
 */
export class ExecutionCapsuleService {
  readonly #driver: ExecutionCapsuleDriver;
  readonly #createExportId: () => string;
  readonly #revalidateRecovery: ExecutionCapsuleServiceOptions["revalidateRecovery"];
  readonly #capsules = new Map<ExecutionCapsuleId, OwnedCapsule>();
  readonly #ownerCapsules = new Map<string, ExecutionCapsuleId>();
  readonly #runtimeIds = new Set<string>();
  readonly #exports = new Map<ExecutionCapsuleExportId, OwnedExport>();
  readonly #pendingCapsules = new Set<ExecutionCapsuleId>();
  readonly #pendingOwners = new Set<string>();
  readonly #pendingBudgets = new Map<ExecutionCapsuleId, ExecutionCapsuleResourceBudget>();

  constructor(options: ExecutionCapsuleServiceOptions) {
    this.#driver = options.driver;
    this.#createExportId = options.createExportId ?? randomUUID;
    this.#revalidateRecovery = options.revalidateRecovery;
  }

  async acquire(input: {
    readonly request: ExecutionCapsuleAcquireRequest;
    readonly source: ExecutionCapsuleSource;
  }): Promise<ExecutionCapsuleAcquireResult> {
    const ownerKey = executionCapsuleOwnerKey(input.request.owner);
    const existing = this.#capsules.get(input.request.capsuleId);
    if (existing?.receipt.status === "ready") {
      return { status: "ready", receipt: existing.receipt };
    }
    if (existing !== undefined) return { status: "refused", reason: "owner-already-bound" };

    if (
      this.#ownerCapsules.has(ownerKey) ||
      this.#pendingOwners.has(ownerKey) ||
      this.#pendingCapsules.has(input.request.capsuleId)
    ) {
      return { status: "refused", reason: "owner-already-bound" };
    }

    this.#pendingOwners.add(ownerKey);
    this.#pendingCapsules.add(input.request.capsuleId);
    this.#pendingBudgets.set(input.request.capsuleId, input.request.budget);
    try {
      return await this.#acquireReserved(input, ownerKey);
    } finally {
      this.#pendingOwners.delete(ownerKey);
      this.#pendingCapsules.delete(input.request.capsuleId);
      this.#pendingBudgets.delete(input.request.capsuleId);
    }
  }

  async #acquireReserved(
    input: {
      readonly request: ExecutionCapsuleAcquireRequest;
      readonly source: ExecutionCapsuleSource;
    },
    ownerKey: string,
  ): Promise<ExecutionCapsuleAcquireResult> {
    let probe: ExecutionCapsuleDriverProbe;
    try {
      probe = await this.#driver.probe();
    } catch {
      return { status: "refused", reason: "protected-runtime-unavailable" };
    }
    const plan = planExecutionCapsuleAdmission({
      request: input.request,
      host: probe.host,
      available: subtractReservedCapacity(
        probe.available,
        this.#reservedBudgets(input.request.capsuleId),
      ),
    });
    if (plan.status !== "admitted") return plan;

    let created: ExecutionCapsuleDriverCreateResult;
    try {
      created = await this.#driver.create(input);
    } catch {
      return { status: "refused", reason: "creation-failed" };
    }
    if (created.status === "refused") return created;
    if (created.runtimeId.length === 0 || this.#runtimeIds.has(created.runtimeId)) {
      await this.#driver
        .discardCreated({ capsuleId: input.request.capsuleId, runtimeId: created.runtimeId })
        .catch(() => undefined);
      return { status: "refused", reason: "runtime-identity-conflict" };
    }

    let receipt: ExecutionCapsuleReceipt;
    try {
      receipt = decodeExecutionCapsuleReceipt({
        capsuleId: input.request.capsuleId,
        owner: input.request.owner,
        projectId: input.request.projectId,
        recipeId: input.request.recipe.recipeId,
        recipeRevision: input.request.recipe.revision,
        backend: plan.backend,
        status: "ready",
      });
    } catch {
      await this.#driver
        .discardCreated({ capsuleId: input.request.capsuleId, runtimeId: created.runtimeId })
        .catch(() => undefined);
      return { status: "refused", reason: "creation-failed" };
    }
    this.#capsules.set(input.request.capsuleId, {
      receipt,
      runtimeId: created.runtimeId,
      budget: input.request.budget,
      request: input.request,
      source: input.source,
    });
    this.#ownerCapsules.set(ownerKey, input.request.capsuleId);
    this.#runtimeIds.add(created.runtimeId);
    return { status: "ready", receipt };
  }

  #reservedBudgets(
    currentCapsuleId: ExecutionCapsuleId,
  ): ReadonlyArray<ExecutionCapsuleResourceBudget> {
    return [
      ...[...this.#capsules.values()].map((capsule) => capsule.budget),
      ...[...this.#pendingBudgets.entries()]
        .filter(([capsuleId]) => String(capsuleId) !== String(currentCapsuleId))
        .map(([, budget]) => budget),
    ];
  }

  list(): ReadonlyArray<ExecutionCapsuleReceipt> {
    return [...this.#capsules.values()]
      .map((capsule) => capsule.receipt)
      .sort((left, right) => String(left.capsuleId).localeCompare(String(right.capsuleId)));
  }

  recoveryRecord(capsuleId: ExecutionCapsuleId): ExecutionCapsuleRecoveryRecordResult {
    const capsule = this.#capsules.get(capsuleId);
    if (capsule === undefined) return { status: "refused", reason: "capsule-unavailable" };
    return {
      status: "ready",
      record: {
        request: capsule.request,
        source: capsule.source,
        exports: [...this.#exports.values()].filter(
          (exported) => String(exported.receipt.capsuleId) === String(capsuleId),
        ),
      },
    };
  }

  async execute(input: {
    readonly capsuleId: ExecutionCapsuleId;
    readonly argv: ReadonlyArray<string>;
  }): Promise<ExecutionCapsuleCommandResult> {
    const capsule = this.#capsules.get(input.capsuleId);
    if (capsule === undefined || capsule.receipt.status !== "ready") {
      return { status: "refused", reason: "capsule-unavailable" };
    }
    if (
      input.argv.length === 0 ||
      input.argv.length > 128 ||
      input.argv.some((argument) => argument.includes("\0") || argument.length > 4_096)
    ) {
      return { status: "refused", reason: "invalid-command" };
    }
    try {
      return await this.#driver.execute({ runtimeId: capsule.runtimeId, argv: input.argv });
    } catch {
      return { status: "failed", reason: "runtime-unavailable" };
    }
  }

  async exportGitBundle(capsuleId: ExecutionCapsuleId): Promise<ExecutionCapsuleExportResult> {
    const capsule = this.#capsules.get(capsuleId);
    if (capsule === undefined || capsule.receipt.status !== "ready") {
      return { status: "refused", reason: "capsule-unavailable" };
    }
    let exported: ExecutionCapsuleDriverExportResult;
    try {
      exported = await this.#driver.exportGitBundle({ runtimeId: capsule.runtimeId });
    } catch {
      return { status: "failed", reason: "export-failed" };
    }
    if (exported.status === "failed") return exported;

    try {
      const exportId = decodeExecutionCapsuleExportId(this.#createExportId());
      const receipt = decodeExecutionCapsuleGitBundleReceipt({
        exportId,
        capsuleId,
        kind: "git-bundle",
        sha256: exported.sha256,
        byteLength: exported.byteLength,
        headRevision: exported.headRevision,
        verified: true,
      });
      this.#exports.set(exportId, { receipt, artifactPath: exported.artifactPath });
      return { status: "exported", receipt };
    } catch {
      return { status: "failed", reason: "export-failed" };
    }
  }

  async release(input: {
    readonly capsuleId: ExecutionCapsuleId;
    readonly exportId: ExecutionCapsuleExportId;
  }): Promise<ExecutionCapsuleReleaseResult> {
    const capsule = this.#capsules.get(input.capsuleId);
    if (capsule === undefined) {
      return { status: "refused", reason: "capsule-unavailable" };
    }
    const exported = this.#exports.get(input.exportId);
    if (exported === undefined || String(exported.receipt.capsuleId) !== String(input.capsuleId)) {
      return { status: "refused", reason: "export-required" };
    }

    let released: Awaited<ReturnType<ExecutionCapsuleDriver["release"]>>;
    try {
      released = await this.#driver.release({ runtimeId: capsule.runtimeId });
    } catch {
      return { status: "failed", reason: "release-failed" };
    }
    if (released.status === "failed") return released;

    this.#capsules.delete(input.capsuleId);
    this.#ownerCapsules.delete(executionCapsuleOwnerKey(capsule.receipt.owner));
    this.#runtimeIds.delete(capsule.runtimeId);
    return {
      status: "released",
      receipt: decodeExecutionCapsuleReceipt({ ...capsule.receipt, status: "released" }),
    };
  }

  async stop(capsuleId: ExecutionCapsuleId): Promise<ExecutionCapsuleStopResult> {
    const capsule = this.#capsules.get(capsuleId);
    if (capsule === undefined || capsule.receipt.status !== "ready") {
      return { status: "refused", reason: "capsule-unavailable" };
    }
    let stopped: Awaited<ReturnType<ExecutionCapsuleDriver["stop"]>>;
    try {
      stopped = await this.#driver.stop({ runtimeId: capsule.runtimeId });
    } catch {
      return { status: "failed", reason: "stop-failed" };
    }
    if (stopped.status === "failed") return stopped;
    const receipt = decodeExecutionCapsuleReceipt({ ...capsule.receipt, status: "stopped" });
    this.#capsules.set(capsuleId, { ...capsule, receipt });
    return { status: "stopped", receipt };
  }

  async recover(input: {
    readonly request: ExecutionCapsuleAcquireRequest;
    readonly source: ExecutionCapsuleSource;
    readonly exports?: ReadonlyArray<OwnedExport>;
  }): Promise<ExecutionCapsuleRecoverResult> {
    const ownerKey = executionCapsuleOwnerKey(input.request.owner);
    if (
      this.#capsules.has(input.request.capsuleId) ||
      this.#ownerCapsules.has(ownerKey) ||
      this.#pendingOwners.has(ownerKey) ||
      this.#pendingCapsules.has(input.request.capsuleId)
    ) {
      return { status: "refused", reason: "owner-already-bound" };
    }

    this.#pendingOwners.add(ownerKey);
    this.#pendingCapsules.add(input.request.capsuleId);
    this.#pendingBudgets.set(input.request.capsuleId, input.request.budget);
    try {
      return await this.#recoverReserved(input, ownerKey);
    } finally {
      this.#pendingOwners.delete(ownerKey);
      this.#pendingCapsules.delete(input.request.capsuleId);
      this.#pendingBudgets.delete(input.request.capsuleId);
    }
  }

  async #recoverReserved(
    input: {
      readonly request: ExecutionCapsuleAcquireRequest;
      readonly source: ExecutionCapsuleSource;
      readonly exports?: ReadonlyArray<OwnedExport>;
    },
    ownerKey: string,
  ): Promise<ExecutionCapsuleRecoverResult> {
    if (this.#revalidateRecovery === undefined) {
      return { status: "refused", reason: "authority-drift" };
    }
    try {
      const revalidated = await this.#revalidateRecovery(input);
      if (revalidated.status === "refused") return revalidated;
    } catch {
      return { status: "refused", reason: "authority-drift" };
    }
    let probe: ExecutionCapsuleDriverProbe;
    try {
      probe = await this.#driver.probe();
    } catch {
      return { status: "refused", reason: "protected-runtime-unavailable" };
    }
    const plan = planExecutionCapsuleAdmission({
      request: input.request,
      host: probe.host,
      available: subtractReservedCapacity(
        probe.available,
        this.#reservedBudgets(input.request.capsuleId),
      ),
    });
    if (plan.status === "queued") return { status: "refused", reason: plan.reason };
    if (plan.status === "refused") return plan;

    for (const exported of input.exports ?? []) {
      if (
        String(exported.receipt.capsuleId) !== String(input.request.capsuleId) ||
        exported.receipt.verified !== true
      ) {
        return { status: "refused", reason: "source-unavailable" };
      }
      let verified: boolean;
      try {
        verified = await this.#driver.verifyRecoveredExport(exported);
      } catch {
        verified = false;
      }
      if (!verified) return { status: "refused", reason: "source-unavailable" };
    }

    let recovered: Awaited<ReturnType<ExecutionCapsuleDriver["recover"]>>;
    try {
      recovered = await this.#driver.recover(input);
    } catch {
      return { status: "refused", reason: "runtime-unavailable" };
    }
    if (recovered.status === "refused") return recovered;
    if (recovered.runtimeId.length === 0 || this.#runtimeIds.has(recovered.runtimeId)) {
      await this.#driver
        .discardCreated({ capsuleId: input.request.capsuleId, runtimeId: recovered.runtimeId })
        .catch(() => undefined);
      return { status: "refused", reason: "runtime-identity-conflict" };
    }
    const receipt = decodeExecutionCapsuleReceipt({
      capsuleId: input.request.capsuleId,
      owner: input.request.owner,
      projectId: input.request.projectId,
      recipeId: input.request.recipe.recipeId,
      recipeRevision: input.request.recipe.revision,
      backend: plan.backend,
      status: "stopped",
    });
    this.#capsules.set(input.request.capsuleId, {
      receipt,
      runtimeId: recovered.runtimeId,
      budget: input.request.budget,
      request: input.request,
      source: input.source,
    });
    this.#ownerCapsules.set(ownerKey, input.request.capsuleId);
    this.#runtimeIds.add(recovered.runtimeId);
    for (const exported of input.exports ?? []) {
      this.#exports.set(exported.receipt.exportId, exported);
    }
    return { status: "stopped", receipt };
  }
}

function executionCapsuleOwnerKey(owner: ExecutionCapsuleOwner): string {
  return owner.kind === "code-thread"
    ? `code-thread:${String(owner.threadId)}`
    : `agent-run:${String(owner.runId)}`;
}

function subtractReservedCapacity(
  available: ExecutionCapsuleAvailableCapacity,
  budgets: Iterable<ExecutionCapsuleResourceBudget>,
): ExecutionCapsuleAvailableCapacity {
  let cpuMillicores = available.cpuMillicores;
  let memoryBytes = available.memoryBytes;
  let diskBytes = available.diskBytes;
  let pidLimit = available.pidLimit;
  for (const budget of budgets) {
    cpuMillicores -= budget.cpuMillicores;
    memoryBytes -= budget.memoryBytes;
    diskBytes -= budget.diskBytes;
    pidLimit -= budget.pidLimit;
  }
  return {
    cpuMillicores: Math.max(0, cpuMillicores),
    memoryBytes: Math.max(0, memoryBytes),
    diskBytes: Math.max(0, diskBytes),
    pidLimit: Math.max(0, pidLimit),
  };
}
