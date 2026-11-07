import {
  decodeBrowserThreadId,
  LOCAL_HOST_ID,
  type AgentRun,
  type BrowserThreadId,
  type ToolActionAuthority,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
  type ProviderExecutionPolicy,
  type StoredBrowserProfile,
} from "@octant/contracts";
import type { BrowserSessionTarget } from "@octant/contracts/browser-session-grants";
import {
  effectiveAgentRunExecutionTarget,
  browserProfileChoiceOf,
  browserProfileFromChoice,
  storedBrowserProfile,
} from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { withToolFamilyHelp } from "../providers/appManagedToolSet";
import type {
  RecordExternalContentIngestionInput,
  ExternalContentIngestionResult,
} from "../context/externalContentIngestionStore";
import { BrowserAutomationService } from "./browserAutomationService";
import { createBrowserAppManagedTools } from "./browserAppManagedTools";
import { BROWSER_TOOL_DEFINITION, BROWSER_TOOL_HELP } from "./browserToolDefinition";
import { parseBrowserToolInput } from "./browserToolOperations";
import type { BrowserRuntimePort } from "./browserRuntimePort";
import {
  decodePersistentBrowserLeaseBinding,
  type PersistentBrowserOwnerId,
} from "@octant/contracts/persistent-browser-owner";
import type { CurrentBrowserSessionTarget, BrowserSessionGrants } from "./browserSessionGrants";

interface ChildBrowserEntry {
  readonly service: BrowserAutomationService;
  readonly tools: AppManagedToolSet;
  readonly grantId: string;
  readonly callerIsCurrent: () => boolean;
  readonly windowId: WindowId;
  readonly executionOwnerId?: PersistentBrowserOwnerId;
}

interface BrowserDelegatedChildrenOptions {
  readonly persistentOwnerEnabled?: () => boolean;
  readonly runtime: BrowserRuntimePort;
  readonly grants: Pick<
    BrowserSessionGrants,
    | "find"
    | "isCurrent"
    | "ownerWindowFor"
    | "forTarget"
    | "executionFor"
    | "invalidateExecutionOwners"
  >;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  readonly now: () => number;
}

/** A child owns its page and clamped authority; it never borrows its parent's page. */
export class BrowserDelegatedChildren {
  readonly #options: BrowserDelegatedChildrenOptions;
  readonly #active = new Map<string, ChildBrowserEntry>();

  constructor(options: BrowserDelegatedChildrenOptions) {
    this.#options = options;
  }

  tools(input: {
    readonly target: BrowserSessionTarget;
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly current: () => BrowserSessionTarget | undefined;
    /** A host-proven run/session identity, independent of the reusable recipient. */
    readonly executionId?: string;
    readonly contentThreadId?: BrowserThreadId;
    readonly executionAuthority?: () => ToolActionAuthority | undefined;
  }): AppManagedToolSet {
    const id =
      input.target.grantee.kind === "child"
        ? String(input.target.grantee.runId)
        : input.executionId;
    if (id === undefined)
      throw new Error("A delegated Browser execution needs a host-owned identity.");
    const ownerKey = this.#options.uuid();
    const threadId = decodeBrowserThreadId(id);
    const ownerIsCurrent = async (entry: ChildBrowserEntry): Promise<boolean> => {
      if (entry.executionOwnerId === undefined)
        return (
          String(this.#options.grants.ownerWindowFor(entry.grantId)) === String(entry.windowId)
        );
      const current = await this.#options.runtime.persistentOwner?.status();
      if (current?.status === "ready")
        this.#options.grants.invalidateExecutionOwners(current.ownerId);
      return (
        this.#options.persistentOwnerEnabled?.() !== false &&
        current?.status === "ready" &&
        current.ownerId === entry.executionOwnerId
      );
    };
    const close = async (): Promise<void> => {
      const entry = this.#active.get(ownerKey);
      this.#active.delete(ownerKey);
      await entry?.service.close();
    };
    let closing: Promise<void> | undefined;
    const refusal = (error: string) => ({
      result: {
        error,
        ...(error === "browser-needs-login"
          ? {
              message:
                "A local person must sign in to the selected Browser profile on the execution host, then retry the task explicitly. This execution cannot enter credentials or take over a sign-in page.",
            }
          : {}),
        ...(error === "browser-needs-a-native-owner"
          ? {
              message:
                "The reviewed native Browser owner is unavailable. Open Octant on the execution host and review this session permission again; no headless profile is substituted.",
            }
          : {}),
        ...(error !== "browser-session-permission-required"
          ? {}
          : {
              message:
                "A local person reviews this caller's Browser session permission in Settings > Data & storage. Then retry with the exact granted profile. Granting does not start or resume the caller.",
              permissions:
                input.current() === undefined
                  ? []
                  : this.#options.grants.forTarget(input.target).map((grant) => ({
                      profile: browserProfileChoiceOf(grant.profile),
                      label: grant.profileLabel,
                      origins: grant.origins,
                      expiresAt: grant.expiresAt,
                    })),
            }),
      },
      isError: true as const,
    });
    const tools: AppManagedToolSet = {
      definitions: [
        {
          ...BROWSER_TOOL_DEFINITION,
          description:
            "Use this delegated caller's own Browser context with an explicitly granted stored profile and HTTPS site. Permission never lends the parent's page or file-transfer authority.",
          inputSchema: {
            ...BROWSER_TOOL_DEFINITION.inputSchema,
            properties: {
              ...BROWSER_TOOL_DEFINITION.inputSchema.properties,
              profile: {
                type: "string",
                description:
                  "The exact granted profile: project, personal, or account:<id>. A missing permission response lists only this caller's granted profiles.",
              },
            },
          },
        },
      ],
      close: () => {
        closing ??= close();
        return closing;
      },
      execute: async (call) => {
        if (call.name !== BROWSER_TOOL_DEFINITION.name) return refusal("tool-unavailable");
        if (closing !== undefined || call.signal?.aborted) return refusal("tool-interrupted");
        const operation = parseBrowserToolInput(call.inputJson, { allowProfile: true });
        if (operation === undefined) return refusal("invalid-browser-input");
        const current = input.current();
        if (current === undefined) {
          await close();
          return refusal("browser-authority-stale");
        }
        if (operation.operation === "upload" || operation.operation === "download-save")
          return refusal("transfer-needs-separate-permission");
        if (operation.operation === "sign-in") return refusal("browser-needs-login");
        if (operation.operation === "run-script")
          return refusal("browser-operation-needs-a-local-person");
        let entry = this.#active.get(ownerKey);
        if (operation.operation === "stop") {
          await close();
          return { result: { status: "stopped" } };
        }
        const existing = entry?.service.inspectThread(entry.windowId, threadId).context;
        const profile =
          storedBrowserProfile(existing?.policy.profile) ??
          (operation.operation === "navigate" && operation.profile !== undefined
            ? storedBrowserProfile(
                browserProfileFromChoice(operation.profile, current.authority.projectId),
              )
            : undefined);
        const origins =
          existing?.state === "active"
            ? existing.policy.allowedOrigins
            : operation.operation === "navigate"
              ? originOf(operation.url)
              : [];
        if (profile === undefined || origins.length === 0)
          return refusal("browser-session-permission-required");
        if (
          entry !== undefined &&
          (!this.#options.grants.isCurrent(entry.grantId, current, profile, origins) ||
            !(await ownerIsCurrent(entry)))
        ) {
          await close();
          entry = undefined;
        }
        if (entry === undefined) {
          const grantId = this.#options.grants.find(current.grantee, profile, origins);
          if (
            grantId === undefined ||
            !this.#options.grants.isCurrent(grantId, current, profile, origins)
          )
            return refusal("browser-session-permission-required");
          const execution = this.#options.grants.executionFor(grantId);
          // This is the real review's provenance key, never a fabricated window
          // identity or a fallback native principal for an execution service.
          const windowId =
            execution?.reviewerWindowId ?? this.#options.grants.ownerWindowFor(grantId);
          if (windowId === undefined) return refusal("browser-needs-a-local-owner-window");
          const owner =
            execution === undefined
              ? undefined
              : await this.#options.runtime.persistentOwner?.status();
          if (owner?.status === "ready")
            this.#options.grants.invalidateExecutionOwners(owner.ownerId);
          if (
            execution !== undefined &&
            (this.#options.persistentOwnerEnabled?.() === false ||
              owner?.status !== "ready" ||
              owner.ownerId !== execution.ownerId)
          )
            return refusal("browser-needs-a-native-owner");
          const binding =
            execution === undefined
              ? undefined
              : decodePersistentBrowserLeaseBinding({
                  ownerId: execution.ownerId,
                  grantId,
                  executionId: id,
                  threadId: input.contentThreadId ?? threadId,
                  mode: current.authority.mode,
                  projectId: current.authority.projectId,
                  providerId: String(current.authority.providerInstanceId),
                  modelId: String(current.modelId),
                  authorityRevision: JSON.stringify({
                    authority: input.executionAuthority?.() ?? current.authority,
                    recipient: execution.grant.recipientRevisionDigest,
                  }),
                  profile,
                  origins,
                  expiresAt: execution.grant.expiresAt,
                });
          const permitted = (candidate: StoredBrowserProfile, sites: ReadonlyArray<string>) => {
            const live = input.current();
            return (
              live !== undefined &&
              this.#options.grants.isCurrent(grantId, live, candidate, sites) &&
              (execution !== undefined
                ? this.#options.persistentOwnerEnabled?.() !== false
                : String(this.#options.grants.ownerWindowFor(grantId)) === String(windowId))
            );
          };
          const service = new BrowserAutomationService({
            ...(binding === undefined
              ? {}
              : {
                  executionOwner: {
                    kind: "execution" as const,
                    binding,
                    isCurrent: () => permitted(profile, origins),
                  },
                }),
            runtime: this.#options.runtime,
            sharedRuntime: true,
            authority: {
              resolve: () =>
                input.executionAuthority === undefined
                  ? input.current()?.authority
                  : input.executionAuthority(),
              canAccessWindow: (window, thread) =>
                String(window) === String(windowId) &&
                String(thread) === id &&
                input.current() !== undefined,
            },
            isUnattendedScope: () => true,
            delegatedProfileIsCurrent: ({ profile: candidate, origins: sites }) =>
              permitted(candidate, sites),
            recordExternalContentIngestion: (mark) =>
              this.#options.recordExternalContentIngestion({
                ...mark,
                ...(input.contentThreadId === undefined ? {} : { threadId: input.contentThreadId }),
              }),
            uuid: this.#options.uuid,
            now: this.#options.now,
            clock: () => new Date(this.#options.now()).toISOString(),
          });
          const managed = createBrowserAppManagedTools({
            windowId,
            threadId,
            mode: current.authority.mode,
            modelId: current.modelId,
            executionPolicy: input.executionPolicy,
            modelBindings: new Map(),
            resolveAuthority: () =>
              input.executionAuthority === undefined
                ? input.current()?.authority
                : input.executionAuthority(),
            resolveModelId: () => input.current()?.modelId,
            delegatedProfileIsCurrent: permitted,
            browser: {
              inspectThread: (window, thread) => service.inspectThread(window, thread),
              create: (request) => service.create(request),
              act: (request) => service.act(request),
              releaseThread: (window, thread) => service.releaseThread(window, thread),
            },
            approvals: {
              request: async () => "denied",
              isRemembered: (origin, candidate) =>
                candidate !== undefined && permitted(candidate, [origin]),
              isUnattendedScope: () => true,
              isPairedDevice: () => false,
            },
            uuid: this.#options.uuid,
          });
          entry = {
            service,
            tools: managed,
            grantId,
            windowId,
            ...(execution === undefined ? {} : { executionOwnerId: execution.ownerId }),
            callerIsCurrent: () => input.current() !== undefined,
          };
          this.#active.set(ownerKey, entry);
        }
        const answer = await entry.tools.execute(call);
        const live = input.current();
        if (
          closing !== undefined ||
          live === undefined ||
          !this.#options.grants.isCurrent(entry.grantId, live, profile, origins) ||
          !(await ownerIsCurrent(entry))
        )
          return {
            result: {
              error: "browser-session-ended",
              effect: "unknown",
              message:
                "The permission, caller or native owner ended while the operation was running. No observation is returned. Check the site before retrying an action.",
            },
            isError: true,
          };
        return answer;
      },
    };
    return withToolFamilyHelp(tools, BROWSER_TOOL_HELP);
  }

  async settle(): Promise<void> {
    const ended = [...this.#active.entries()].filter(([, row]) => !row.callerIsCurrent());
    for (const [id] of ended) this.#active.delete(id);
    await Promise.all(ended.map(([, row]) => row.service.close()));
  }

  async revoke(grantId: string): Promise<void> {
    const entries = [...this.#active.entries()].filter(([, entry]) => entry.grantId === grantId);
    for (const [id] of entries) this.#active.delete(id);
    await Promise.all(entries.map(([, entry]) => entry.service.close()));
  }

  async closeWindow(windowId: WindowId): Promise<void> {
    const entries = [...this.#active.entries()].filter(
      ([, entry]) =>
        entry.executionOwnerId === undefined && String(entry.windowId) === String(windowId),
    );
    for (const [id] of entries) this.#active.delete(id);
    await Promise.all(entries.map(([, entry]) => entry.service.close()));
  }

  async close(): Promise<void> {
    const entries = [...this.#active.values()];
    this.#active.clear();
    await Promise.all(entries.map((entry) => entry.service.close()));
  }
}

function originOf(value: string): ReadonlyArray<string> {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? [url.origin] : [];
  } catch {
    return [];
  }
}

/** A site-limited native Browser grant never changes the caller's ambient network grant. */
export function currentManagedChildBrowserTarget(
  run: AgentRun,
  input: {
    readonly canReview: (run: AgentRun) => boolean;
    readonly resolveParent: (
      threadId: BrowserThreadId,
      mode: "work" | "code",
    ) => ToolActionAuthority | undefined;
    readonly supportsTools: (
      providerInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
    ) => boolean;
  },
): CurrentBrowserSessionTarget | undefined {
  if (
    run.executionKind !== "octant-managed" ||
    String(run.routingReceipt.executionResolution.hostId) !== String(LOCAL_HOST_ID) ||
    !run.authority.tools ||
    run.workspaceReceipt.kind === "chat-virtual" ||
    !input.canReview(run)
  )
    return undefined;
  if (run.workspaceReceipt.kind === "code-worktree" && !run.workspaceReceipt.verified)
    return undefined;
  const parent = decodeBrowserThreadId(String(run.parentThreadId));
  const mode = run.workspaceReceipt.mode;
  const parentAuthority = input.resolveParent(parent, mode);
  if (
    parentAuthority === undefined ||
    String(parentAuthority.projectId) !== String(run.workspaceReceipt.projectId)
  )
    return undefined;
  const execution = effectiveAgentRunExecutionTarget(run.routingReceipt);
  if (!input.supportsTools(execution.providerInstanceId, execution.modelId)) return undefined;
  const authority: ToolActionAuthority = {
    hostId: parentAuthority.hostId,
    mode,
    projectId: run.workspaceReceipt.projectId,
    providerInstanceId: execution.providerInstanceId,
    extension: { kind: "core" },
  };
  return {
    target: {
      grantee: { kind: "child", runId: run.id },
      label: run.task.slice(0, 256),
      authority,
      modelId: execution.modelId,
    },
    revision: JSON.stringify({
      requestId: run.requestId,
      generation: run.generation ?? 1,
      workspace: run.workspaceReceipt,
      authority: run.authority,
      parent: parentAuthority,
      digest: run.routingReceipt.effectiveAuthorityDigest,
    }),
  };
}
