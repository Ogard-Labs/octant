import type { SandboxPolicyLaunchDetails } from "@octant/contracts/sandbox-policy";
import { admitSandboxPolicy, intersectSandboxPolicies } from "@octant/domain/sandbox-policy";
import { refusesFullAccessSandbox } from "@octant/domain/guardrail-policy";
import { ProviderDriverKind, ProjectId } from "@octant/contracts";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Schema } from "effect";
import { decodeUtcTimestamp, type EventActor, type Project } from "@octant/contracts";
import {
  SANDBOX_POLICY_CHANGED,
  SANDBOX_POLICY_AGGREGATE_TYPE,
  SandboxPolicyChanged,
  decodeSandboxPolicy,
  decodeSandboxPolicySelection,
  decodeSandboxRestrictionsSnapshot,
  decodeSandboxRestrictionsResult,
  type SandboxRestrictionsScope,
  type SandboxPolicy,
  type SandboxPolicySelection,
  type SandboxRestrictionsCommand,
  type SandboxRestrictionsResult,
  type SandboxPolicyDenial,
} from "@octant/contracts/sandbox-policy";
import type { Journal } from "./persistence/journal";
import type { EventRegistry } from "./persistence/eventRegistry";
import { replayAggregateTypesInOrder } from "./persistence/journalHydration";
import { ConcurrencyConflict } from "./persistence/journalErrors";
import {
  sandboxPolicySummary,
  type SandboxTurnRequest,
  type SandboxTurnAdmission,
  type SandboxRestrictionsAuthority,
} from "./process/sandboxRuntimePolicy";

const aggregateId = "00000000-0000-4000-8000-0000000000e6";
const decodeChanged = Schema.decodeUnknownSync(SandboxPolicyChanged);
type StoredPolicy = typeof SandboxPolicyChanged.Type;
const keyOf = (scope: SandboxRestrictionsScope) =>
  scope.kind === "settings"
    ? `settings:${scope.mode}`
    : scope.kind === "project"
      ? `project:${scope.projectId}`
      : `session:${scope.threadId}`;
const refused = (
  reason: "stale-version" | "binding-changed" | "unavailable" | "not-grantable",
  message: string,
): SandboxRestrictionsResult =>
  decodeSandboxRestrictionsResult({ kind: "sandbox-restrictions-refused", reason, message });

export function registerSandboxRestrictionsEvents(registry: EventRegistry): EventRegistry {
  return registry.register(SANDBOX_POLICY_CHANGED, 1, SandboxPolicyChanged);
}

export interface SandboxRestrictionsDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly hostId: string;
  readonly actor: EventActor;
  readonly project: (id: string) => Project | undefined;
  readonly thread: (
    id: string,
  ) => { readonly projectId: string; readonly mode: "code" | "work" } | undefined;
  readonly enrollmentEnabled?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly dataDirectory?: string;
}

export class SandboxRestrictionsService implements SandboxRestrictionsAuthority {
  readonly #dependencies: SandboxRestrictionsDependencies;
  readonly #stored = new Map<string, StoredPolicy>();
  readonly #sessions = new Map<string, StoredPolicy>();
  readonly #turns = new Map<
    string,
    {
      readonly selection?: SandboxPolicySelection;
      readonly launches: SandboxPolicyLaunchDetails[];
      readonly nonce: string;
      readonly parentThreadId?: string;
      readonly identities?: ReadonlyArray<{ readonly path: string; readonly identity: string }>;
      ending: boolean;
      readonly cleanups: Map<string, () => Promise<void>>;
    }
  >();
  readonly #denials = new Map<string, SandboxPolicyDenial>();
  #version = 0;
  #journalVersion = 0;
  readonly #audit: Array<Readonly<Record<string, string | number>>> = [];

  constructor(dependencies: SandboxRestrictionsDependencies) {
    this.#dependencies = dependencies;
    for (const envelope of replayAggregateTypesInOrder(dependencies.journal, [
      SANDBOX_POLICY_AGGREGATE_TYPE,
    ])) {
      const record = decodeChanged(envelope.payload);
      if (record.scope.kind !== "session") this.#stored.set(keyOf(record.scope), record);
      this.#journalVersion = envelope.aggregateVersion;
      this.#version = Math.max(
        this.#version,
        envelope.aggregateVersion,
        record.policy?.revision ?? 0,
      );
    }
  }
  #identity(path: string): { readonly path: string; readonly identity: string } {
    const canonical = realpathSync(path);
    const stat = statSync(canonical, { bigint: true });
    if (!stat.isDirectory() || canonical === "/")
      throw new Error("Select an existing folder below the filesystem root.");
    return { path: canonical, identity: `${stat.dev}:${stat.ino}` };
  }
  #machineIdentity(): string {
    const platform = this.#dependencies.platform ?? process.platform;
    const value =
      platform === "linux"
        ? readFileSync("/etc/machine-id", "utf8").trim()
        : platform === "darwin"
          ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.hostuuid"], {
              encoding: "utf8",
              timeout: 2000,
            }).trim()
          : this.#dependencies.hostId;
    if (value.length === 0) throw new Error("This machine's sandbox identity is unavailable.");
    return createHash("sha256").update(`${this.#dependencies.hostId}:${value}`).digest("hex");
  }
  storageDirectory(): string | undefined {
    return this.#dependencies.dataDirectory;
  }
  #binding(scope: SandboxRestrictionsScope): string {
    const projectId =
      scope.kind === "project"
        ? String(scope.projectId)
        : scope.kind === "session"
          ? this.#dependencies.thread(scope.threadId)?.projectId
          : undefined;
    if (scope.kind !== "settings" && projectId === undefined)
      throw new Error("This thread is unavailable.");
    if (projectId === undefined) return this.#machineIdentity();
    const project = this.#dependencies.project(projectId);
    if (project === undefined || project.type === "chat" || project.lifecycle !== "active")
      throw new Error("This Project is unavailable.");
    const root = this.#identity(project.binding.canonicalRoot);
    let remote = "";
    try {
      let gitDirectory = join(root.path, ".git");
      if (statSync(gitDirectory).isFile()) {
        const marker = readFileSync(gitDirectory, "utf8").trim();
        if (!marker.startsWith("gitdir: ")) throw new Error("Invalid checkout binding");
        gitDirectory = resolve(root.path, marker.slice(8));
        const common = join(gitDirectory, "commondir");
        try {
          gitDirectory = resolve(gitDirectory, readFileSync(common, "utf8").trim());
        } catch {
          /* Ordinary separate git directories have no common directory. */
        }
      }
      remote = readFileSync(join(gitDirectory, "config"), "utf8");
    } catch {
      /* A Work folder need not be a repository. */
    }
    return createHash("sha256")
      .update(
        JSON.stringify({
          host: this.#machineIdentity(),
          projectId,
          root,
          extraRoots: (project.extraFolders ?? []).map((folder) =>
            this.#identity(folder.canonicalRoot),
          ),
          revision: project.bindingHistory.at(-1)?.revisionId,
          remote,
        }),
      )
      .digest("hex");
  }
  #records(scope: SandboxRestrictionsScope): ReadonlyArray<StoredPolicy | undefined> {
    if (scope.kind === "settings") return [this.#stored.get(keyOf(scope))];
    const thread = scope.kind === "session" ? this.#dependencies.thread(scope.threadId) : undefined;
    const projectId = scope.kind === "project" ? String(scope.projectId) : thread?.projectId;
    const project = projectId === undefined ? undefined : this.#dependencies.project(projectId);
    const mode = thread?.mode ?? (project?.type === "work" ? "work" : "code");
    return [
      scope.kind === "session" ? this.#sessions.get(keyOf(scope)) : undefined,
      projectId === undefined ? undefined : this.#stored.get(`project:${projectId}`),
      this.#stored.get(`settings:${mode}`),
    ];
  }
  #effective(scope: SandboxRestrictionsScope): StoredPolicy | undefined {
    return this.#records(scope).find((record) => record?.policy !== undefined);
  }
  #validate(record: StoredPolicy): void {
    if (record.binding !== this.#binding(record.scope))
      throw new Error(
        "The Project or machine binding changed. Review and save the sandbox restrictions again.",
      );
    for (const root of record.roots) {
      const current = this.#identity(root.path);
      if (current.path !== root.path || current.identity !== root.identity)
        throw new Error(
          "An allowed folder changed identity. Review and save that folder grant again.",
        );
    }
  }
  snapshot(scope: SandboxRestrictionsScope) {
    const effective = this.#effective(scope);
    const platform = this.#dependencies.platform ?? process.platform;
    const policy = effective?.policy;
    const threadId = scope.kind === "session" ? scope.threadId : undefined;
    const projectId =
      scope.kind === "project"
        ? String(scope.projectId)
        : threadId === undefined
          ? undefined
          : this.#dependencies.thread(threadId)?.projectId;
    const limitations = [
      ...(platform === "darwin"
        ? [
            "New policy enrollment is unavailable until detached-descendant revocation is proven for this backend. Existing Keep the sandbox behavior remains available.",
          ]
        : []),
      ...(this.#dependencies.enrollmentEnabled === false
        ? [
            "New policy enrollment is in maintainer preview. Existing saved restrictions remain enforced.",
          ]
        : []),
      ...(platform === "linux"
        ? [
            "Read-only folders on the same filesystem as a writable root are unsupported until access-time alias mediation is available; the launch refuses rather than allowing writes through hard links.",
          ]
        : []),
      "Protected project paths require a proven backend and are unavailable on this host.",
      "Exact credential and host-service grants are not supported; protected-file rules remain enforced. OpenCode on Linux cannot yet enroll because its host control transport requires a confined bridge.",
    ];
    try {
      if (effective !== undefined) this.#validate(effective);
    } catch (error) {
      limitations.unshift(
        error instanceof Error ? error.message : "The saved grant is unavailable.",
      );
    }
    return decodeSandboxRestrictionsSnapshot({
      kind: "sandbox-restrictions",
      runtimeDetails: [...this.#turns.entries()]
        .filter(([id, turn]) =>
          threadId !== undefined
            ? id === threadId
            : projectId === undefined || String(turn.selection?.context.projectId) === projectId,
        )
        .flatMap(([, turn]) => turn.launches)
        .slice(-16),
      enrollmentEnabled:
        platform === "linux" &&
        (this.#dependencies.enrollmentEnabled !== false || policy !== undefined),
      version: this.#version,
      scope,
      source: effective?.scope.kind ?? "legacy",
      ...(policy === undefined ? {} : { policy }),
      inherited: effective !== undefined && keyOf(scope) !== keyOf(effective.scope),
      running: threadId !== undefined && this.#turns.has(threadId),
      summary:
        policy === undefined
          ? "Following the existing sandbox choice. No additional restrictions selected."
          : `Writes: Project + ${policy.filesystem.readWriteRoots.length} allowed folders. Read only: ${policy.filesystem.readOnlyRoots.length} folders. Network: ${policy.network === "existing-policy" ? "existing Safe networks settings" : policy.network}. Applies next turn.`,
      limitations,
      capabilities: {
        folders: platform === "linux",
        protectedPaths: false,
        isolatedCredentials: false,
        blockedHostServices: platform === "linux",
      },
      denials: [...this.#denials.values()].filter(
        (denial) =>
          !denial.dismissed &&
          (threadId !== undefined
            ? denial.threadId === threadId
            : projectId === undefined || String(denial.projectId) === projectId),
      ),
    });
  }
  change(
    command: SandboxRestrictionsCommand,
    actor: EventActor = this.#dependencies.actor,
  ): SandboxRestrictionsResult {
    if (command.expectedVersion !== this.#version)
      return refused("stale-version", "Sandbox restrictions changed. Reload before saving.");
    if (
      command.kind === "set-policy" &&
      this.#dependencies.enrollmentEnabled === false &&
      this.#effective(command.scope) === undefined
    )
      return {
        kind: "sandbox-restrictions-refused",
        reason: "unsupported",
        message:
          "New sandbox policies are in maintainer preview. Saved restrictions continue to be enforced.",
      };
    if (command.kind === "keep-blocked") {
      const denial = this.#denials.get(command.denialId);
      if (denial === undefined)
        return refused("unavailable", "That blocked action is no longer available.");
      this.#denials.set(denial.id, { ...denial, dismissed: true });
      this.#version += 1;
      return this.snapshot({ kind: "session", threadId: denial.threadId });
    }
    let scope: SandboxRestrictionsScope;
    let policy: SandboxPolicy | undefined;
    if (command.kind === "grant-denial") {
      const denial = this.#denials.get(command.denialId);
      if (
        denial === undefined ||
        !denial.grantable ||
        (denial.operation !== "read" &&
          denial.operation !== "write" &&
          !(denial.operation === "network" && denial.destination !== undefined))
      )
        return refused(
          "not-grantable",
          "This restriction cannot be widened with a folder exception.",
        );
      scope =
        command.duration === "session"
          ? { kind: "session", threadId: denial.threadId }
          : { kind: "project", projectId: denial.projectId };
      const current = this.#effective(scope)?.policy;
      if (current === undefined)
        return refused("not-grantable", "The sandbox policy is no longer selected.");
      if (denial.operation === "network" && denial.destination !== undefined) {
        policy = decodeSandboxPolicy({
          ...current,
          approvedDestinations: [...(current.approvedDestinations ?? []), denial.destination],
        });
      } else
        policy = decodeSandboxPolicy({
          ...current,
          filesystem: {
            ...current.filesystem,
            ...(denial.operation === "write"
              ? {
                  readOnlyRoots: current.filesystem.readOnlyRoots.filter(
                    (root) => root !== denial.resource,
                  ),
                }
              : {}),
            [denial.operation === "read" ? "readOnlyRoots" : "readWriteRoots"]: [
              ...(denial.operation === "read"
                ? current.filesystem.readOnlyRoots
                : current.filesystem.readWriteRoots),
              denial.resource,
            ],
          },
        });
    } else {
      scope = command.scope;
      policy = command.kind === "set-policy" ? command.policy : undefined;
    }
    let record: StoredPolicy;
    try {
      if (policy !== undefined)
        policy = decodeSandboxPolicy({ ...policy, revision: this.#version + 1 });
      const roots =
        policy === undefined
          ? []
          : [...policy.filesystem.readOnlyRoots, ...policy.filesystem.readWriteRoots].map((path) =>
              this.#identity(path),
            );
      record = {
        scope,
        binding: this.#binding(scope),
        ...(policy === undefined
          ? {}
          : {
              policy: {
                ...policy,
                filesystem: {
                  ...policy.filesystem,
                  readOnlyRoots: policy.filesystem.readOnlyRoots.map(
                    (path) => this.#identity(path).path,
                  ),
                  readWriteRoots: policy.filesystem.readWriteRoots.map(
                    (path) => this.#identity(path).path,
                  ),
                },
              },
            }),
        roots,
      };
      if (scope.kind !== "session")
        this.#dependencies.journal.append({
          aggregate: { aggregateType: SANDBOX_POLICY_AGGREGATE_TYPE, aggregateId },
          expectedVersion: this.#journalVersion,
          events: [
            {
              eventId: randomUUID(),
              eventName: SANDBOX_POLICY_CHANGED,
              eventVersion: 1,
              correlationId: randomUUID(),
              actor,
              occurredAt: decodeUtcTimestamp(new Date().toISOString()),
              payload: record,
            },
          ],
        });
    } catch (error) {
      if (error instanceof ConcurrencyConflict)
        return refused("stale-version", "Sandbox restrictions changed. Reload before saving.");
      return refused(
        "unavailable",
        error instanceof Error ? error.message : "The selected folder is unavailable.",
      );
    }
    if (scope.kind === "session") {
      if (policy === undefined) this.#sessions.delete(keyOf(scope));
      else this.#sessions.set(keyOf(scope), record);
    } else this.#stored.set(keyOf(scope), record);
    // Session choices do not advance the durable journal's concurrency version.
    if (scope.kind !== "session") this.#journalVersion += 1;
    this.#version += 1;
    if (command.kind === "grant-denial") {
      const denial = this.#denials.get(command.denialId);
      if (denial !== undefined) this.#denials.set(denial.id, { ...denial, dismissed: true });
    }
    this.#recordAudit({ operation: command.kind, scope: scope.kind, revision: this.#version });
    return this.snapshot(scope);
  }
  beginTurn(request: SandboxTurnRequest): SandboxTurnAdmission {
    if (this.#turns.has(request.threadId))
      return {
        status: "refused",
        message:
          "The previous sandbox runtime is still stopping. Wait for cleanup before retrying.",
      };
    let selection: SandboxPolicySelection | undefined;
    try {
      const record =
        this.#effective({ kind: "session", threadId: request.threadId }) ??
        this.#effective({
          kind: "project",
          projectId: Schema.decodeUnknownSync(ProjectId)(request.projectId),
        });
      const parentRecord =
        request.parentThreadId === undefined
          ? undefined
          : this.#effective({ kind: "session", threadId: request.parentThreadId });
      const parentPolicy =
        request.parentThreadId === undefined
          ? undefined
          : (this.active(request.parentThreadId)?.policy ?? parentRecord?.policy);
      const selectedPolicy =
        parentPolicy === undefined
          ? record?.policy
          : record?.policy === undefined
            ? parentPolicy
            : intersectSandboxPolicies(parentPolicy, record.policy);
      if (selectedPolicy !== undefined) {
        if (record !== undefined) this.#validate(record);
        if (
          parentRecord !== undefined &&
          request.parentThreadId !== undefined &&
          this.active(request.parentThreadId) === undefined
        )
          this.#validate(parentRecord);
        const platform = this.#dependencies.platform ?? process.platform;
        if (platform === "darwin")
          throw new Error(
            "This backend has no proven detached-descendant revocation for the selected policy. New policy launches are refused; existing Keep the sandbox behavior remains available.",
          );
        if (platform !== "linux")
          throw new Error("This platform cannot enforce the selected sandbox restrictions.");
        const admission = admitSandboxPolicy(selectedPolicy, {
          allowedFolders: true,
          protectedPaths: false,
          networkDeny: true,
          unrestrictedNetwork: true,
          isolatedCredentials: false,
          blockedHostServices: true,
        });
        if (admission.status === "refused")
          throw new Error(
            `Unsupported sandbox restrictions: ${admission.rules.join(", ")}. Review the unsupported rows in Sandbox restrictions.`,
          );
        const kind = Schema.decodeUnknownSync(ProviderDriverKind)(request.provider);
        if (kind === "opencode")
          throw new Error(
            "OpenCode on Linux cannot confine its host control transport under the selected policy. Choose a supported provider.",
          );
        if (
          refusesFullAccessSandbox({
            access: { executionPolicy: "full-access", fullAccessSandbox: true },
            driverKind: kind,
          })
        )
          throw new Error(
            "This provider cannot enforce the selected sandbox restrictions. Choose a supported provider.",
          );
        const root = this.#identity(request.root);
        const parentSelection =
          request.parentThreadId === undefined ? undefined : this.active(request.parentThreadId);
        if (parentSelection !== undefined) {
          const inside = (allowed: string, path: string) =>
            allowed === path || path.startsWith(`${allowed}/`);
          const writable = [
            parentSelection.context.root,
            ...(parentSelection.context.extraRoots ?? []),
            ...parentSelection.policy.filesystem.readWriteRoots,
          ];
          if (
            !writable.some((allowed) => inside(allowed, root.path)) ||
            parentSelection.policy.filesystem.readOnlyRoots.some((allowed) =>
              inside(allowed, root.path),
            )
          )
            throw new Error(
              "The helper's workspace exceeds its parent's sandbox grants. Choose a workspace within the parent's writable roots.",
            );
        }
        if (platform === "linux") {
          const writableDevices = [root.path, ...selectedPolicy.filesystem.readWriteRoots].map(
            (path) => statSync(path).dev,
          );
          if (
            selectedPolicy.filesystem.readOnlyRoots.some((path) =>
              writableDevices.includes(statSync(path).dev),
            )
          )
            throw new Error(
              "Linux cannot enforce this read-only folder against writable hard-link aliases on the same filesystem. Use a separate filesystem, a supported backend, or explicitly choose read and write access.",
            );
        }
        const project = this.#dependencies.project(request.projectId);
        if (this.#dependencies.dataDirectory !== undefined) {
          const privateRoot = realpathSync(this.#dependencies.dataDirectory);
          for (const grant of [
            root.path,
            ...selectedPolicy.filesystem.readOnlyRoots,
            ...selectedPolicy.filesystem.readWriteRoots,
          ]) {
            const canonical = realpathSync(grant);
            if (
              canonical === privateRoot ||
              privateRoot.startsWith(`${canonical}/`) ||
              canonical === join(privateRoot, "sandbox-filters") ||
              canonical.startsWith(`${join(privateRoot, "sandbox-filters")}/`) ||
              join(privateRoot, "sandbox-filters").startsWith(`${canonical}/`)
            )
              throw new Error(
                "This folder would expose the host's private policy store. Choose a narrower Project or allowed folder.",
              );
          }
        }
        if (
          parentSelection !== undefined &&
          project !== undefined &&
          project.type !== "chat" &&
          (project.extraFolders ?? []).some(
            (folder) =>
              ![
                parentSelection.context.root,
                ...(parentSelection.context.extraRoots ?? []),
                ...parentSelection.policy.filesystem.readWriteRoots,
              ].some(
                (allowed) =>
                  allowed === folder.canonicalRoot ||
                  folder.canonicalRoot.startsWith(`${allowed}/`),
              ),
          )
        )
          throw new Error("The helper's extra folders exceed its parent's sandbox grants.");
        selection = decodeSandboxPolicySelection({
          policy: structuredClone(selectedPolicy),
          context: {
            threadId: request.threadId,
            root: root.path,
            rootIdentities: [
              root,
              ...selectedPolicy.filesystem.readOnlyRoots.map((path) => this.#identity(path)),
              ...selectedPolicy.filesystem.readWriteRoots.map((path) => this.#identity(path)),
              ...(project === undefined || project.type === "chat"
                ? []
                : (project.extraFolders ?? []).map((folder) =>
                    this.#identity(folder.canonicalRoot),
                  )),
            ],
            extraRoots:
              project === undefined || project.type === "chat"
                ? []
                : (project.extraFolders ?? []).map((folder) => folder.canonicalRoot),
            hostId: this.#machineIdentity(),
            projectId: request.projectId,
            checkoutId: `${root.path}:${root.identity}`,
            sessionId: randomUUID(),
            provider: request.provider,
          },
        });
        for (const rootList of [
          selection.policy.filesystem.readOnlyRoots,
          selection.policy.filesystem.readWriteRoots,
          selection.context.extraRoots ?? [],
        ])
          Object.freeze(rootList);
        for (const rule of selection.policy.filesystem.protectedPaths) Object.freeze(rule);
        Object.freeze(selection.policy.filesystem.protectedPaths);
        Object.freeze(selection.policy.filesystem);
        for (const destination of selection.policy.approvedDestinations ?? [])
          Object.freeze(destination);
        if (selection.policy.approvedDestinations !== undefined)
          Object.freeze(selection.policy.approvedDestinations);
        for (const identity of selection.context.rootIdentities ?? []) Object.freeze(identity);
        if (selection.context.rootIdentities !== undefined)
          Object.freeze(selection.context.rootIdentities);
        Object.freeze(selection.policy);
        Object.freeze(selection.context);
        Object.freeze(selection);
      }
    } catch (error) {
      return {
        status: "refused",
        message: error instanceof Error ? error.message : "The sandbox binding is unavailable.",
      };
    }
    const nonce = randomUUID();
    if (selection !== undefined)
      this.#recordAudit({
        operation: "admission",
        thread: request.threadId,
        provider: request.provider,
        revision: selection.policy.revision,
      });
    this.#turns.set(request.threadId, {
      nonce,
      launches: [],
      ...(request.parentThreadId === undefined ? {} : { parentThreadId: request.parentThreadId }),
      ending: false,
      cleanups: new Map(),
      ...(selection === undefined
        ? {}
        : { selection, identities: selection.context.rootIdentities ?? [] }),
    });
    return {
      status: "admitted",
      turn: {
        ...(selection === undefined ? {} : { selection }),
        summary: selection === undefined ? "" : sandboxPolicySummary(selection),
        current: () =>
          this.#turns.get(request.threadId)?.nonce === nonce &&
          this.#turns.get(request.threadId)?.ending === false,
        end: () => {
          const held = this.#turns.get(request.threadId);
          if (held?.nonce !== nonce) return;
          held.ending = true;
          if (held.cleanups.size === 0) {
            this.#turns.delete(request.threadId);
            return;
          }
          return this.#finishTurn(request.threadId, held);
        },
      },
    };
  }
  registerCleanup(sessionId: string, cleanup: () => Promise<void>): () => void {
    const turn = [...this.#turns.values()].find(
      (entry) => entry.selection?.context.sessionId === sessionId,
    );
    if (turn === undefined || turn.ending)
      throw new Error("This sandbox runtime is no longer admitted.");
    const id = randomUUID();
    turn.cleanups.set(id, cleanup);
    return () => turn.cleanups.delete(id);
  }
  async #finishTurn(
    threadId: string,
    turn: {
      readonly selection?: SandboxPolicySelection;
      readonly nonce: string;
      readonly parentThreadId?: string;
      ending: boolean;
      readonly cleanups: Map<string, () => Promise<void>>;
    },
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = Promise.allSettled([...turn.cleanups.values()].map((cleanup) => cleanup()));
    const result = await Promise.race([
      stopped,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 5000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result !== undefined && result.every((entry) => entry.status === "fulfilled")) {
      if (this.#turns.get(threadId)?.nonce === turn.nonce) this.#turns.delete(threadId);
      return;
    }
    if (turn.selection !== undefined)
      this.deny({
        threadId,
        projectId: turn.selection.context.projectId,
        code: "sandbox-cleanup-incomplete",
        ruleId: "lifecycle.cleanup",
        operation: "cleanup",
        resource: "owned runtime",
        message:
          "Sandbox cleanup is incomplete. New turns are blocked until the owned runtime stops.",
        remedy: "Stop the running tools or restart the host before retrying.",
        grantable: false,
      });
    void stopped.then((entries) => {
      if (
        entries.every((entry) => entry.status === "fulfilled") &&
        this.#turns.get(threadId)?.nonce === turn.nonce
      )
        this.#turns.delete(threadId);
    });
  }
  recordLaunch(selection: SandboxPolicySelection, details: SandboxPolicyLaunchDetails): void {
    const turn = [...this.#turns.values()].find(
      (turn) => turn.selection === selection && !turn.ending,
    );
    if (turn === undefined) return;
    if (!turn.launches.some((entry) => JSON.stringify(entry) === JSON.stringify(details)))
      turn.launches.push(details);
    if (turn.launches.length > 16) turn.launches.shift();
  }
  validateSelection(selection: SandboxPolicySelection): boolean {
    const owner = [...this.#turns.entries()].find(
      ([, turn]) => turn.selection === selection && !turn.ending,
    );
    if (owner === undefined) return false;
    try {
      return this.active(owner[0]) === selection;
    } catch {
      return false;
    }
  }
  active(threadId: string): SandboxPolicySelection | undefined {
    const turn = this.#turns.get(threadId);
    if (turn?.ending) return undefined;
    if (turn?.selection !== undefined) {
      for (const expected of turn.identities ?? []) {
        const current = this.#identity(expected.path);
        if (current.path !== expected.path || current.identity !== expected.identity)
          throw new Error(
            "A sandbox folder changed identity during this turn. Stop the turn and review the folder grant before retrying.",
          );
      }
    }
    return turn?.selection;
  }
  deny(input: Omit<SandboxPolicyDenial, "id" | "count" | "dismissed">): void {
    const parentThreadId = this.#turns.get(input.threadId)?.parentThreadId;
    if (parentThreadId !== undefined) input = { ...input, threadId: parentThreadId };
    const old = [...this.#denials.values()].find(
      (denial) =>
        denial.threadId === input.threadId &&
        denial.ruleId === input.ruleId &&
        denial.resource === input.resource &&
        denial.operation === input.operation &&
        !denial.dismissed,
    );
    const denial = {
      ...input,
      id: old?.id ?? randomUUID(),
      count: (old?.count ?? 0) + 1,
      dismissed: false,
    };
    this.#denials.set(denial.id, denial);
    if (old === undefined)
      this.#recordAudit({
        operation: input.operation,
        thread: input.threadId,
        rule: input.ruleId,
        resource: createHash("sha256").update(basename(input.resource)).digest("hex").slice(0, 16),
      });
    if (this.#denials.size > 128) {
      const first = this.#denials.keys().next().value;
      if (first !== undefined) this.#denials.delete(first);
    }
  }
  #recordAudit(entry: Readonly<Record<string, string | number>>): void {
    this.#audit.push({ ...entry, at: new Date().toISOString() });
    if (this.#audit.length > 256) this.#audit.shift();
    const data = this.#dependencies.dataDirectory;
    if (data === undefined) return;
    // This bounded diagnostic log never grants authority and contains no raw
    // paths, commands, file contents or credential values.
    const temporary = join(data, `sandbox-audit-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(this.#audit), { mode: 0o600, flag: "wx" });
      renameSync(temporary, join(data, "sandbox-audit.json"));
    } catch {
      /* Audit diagnostics never change a policy decision. */
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Diagnostics cannot affect admission. */
      }
    }
  }
  revokeSession(threadId: string): void {
    this.#sessions.delete(`session:${threadId}`);
  }
}
