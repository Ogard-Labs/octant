import type { BrowserDownloadPermissions } from "./browserDownloadPermissions";
import type { BrowserDownloadRecorder } from "./browserDownloadJournal";
import type { BrowserUploadPermissions } from "./browserUploadPermissions";
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
import type { CurrentBrowserSessionTarget, BrowserSessionGrants } from "./browserSessionGrants";

interface ChildBrowserEntry {
  readonly service: BrowserAutomationService;
  readonly tools: AppManagedToolSet;
  readonly grantId: string;
  readonly callerIsCurrent: () => boolean;
  readonly windowId: WindowId;
}

interface BrowserDelegatedChildrenOptions {
  readonly runtime: BrowserRuntimePort;
  readonly agentDownloadsEnabled?: () => boolean;
  readonly downloads?: BrowserDownloadRecorder;
  readonly grants: Pick<
    BrowserSessionGrants,
    "find" | "isCurrent" | "ownerWindowFor" | "forTarget"
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
    readonly uploadPermissions?: Pick<BrowserUploadPermissions, "prepare" | "choices">;
    readonly downloadPermissions?: Pick<BrowserDownloadPermissions, "prepare" | "choices">;
  }): AppManagedToolSet {
    const id =
      input.target.grantee.kind === "child"
        ? String(input.target.grantee.runId)
        : input.executionId;
    if (id === undefined)
      throw new Error("A delegated Browser execution needs a host-owned identity.");
    const ownerKey = this.#options.uuid();
    const threadId = decodeBrowserThreadId(id);
    const close = async (): Promise<void> => {
      const entry = this.#active.get(ownerKey);
      this.#active.delete(ownerKey);
      await entry?.service.close();
    };
    let closing: Promise<void> | undefined;
    const refusal = (error: string) => ({
      result: {
        error,
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
              ...(input.uploadPermissions === undefined
                ? {}
                : {
                    uploadPermissionId: {
                      type: "string",
                      description:
                        "The exact host-reviewed upload manifest id; grants no account access.",
                    },
                  }),
              ...(input.downloadPermissions === undefined
                ? {}
                : {
                    downloadPermissionId: {
                      type: "string",
                      description:
                        "For download-save, omit this to list this routine/profile's reviewed manifests without saving; retry with the exact matching permissionId as downloadPermissionId. Grants no account access.",
                    },
                  }),
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
        const operation = parseBrowserToolInput(call.inputJson, {
          allowProfile: true,
          allowUploadPermission: input.uploadPermissions !== undefined,
          allowDownloadPermission: input.downloadPermissions !== undefined,
        });
        if (operation === undefined) return refusal("invalid-browser-input");
        const current = input.current();
        if (current === undefined) {
          await close();
          return refusal("browser-authority-stale");
        }
        if (
          (operation.operation === "upload" && input.uploadPermissions === undefined) ||
          (operation.operation === "download-save" && input.downloadPermissions === undefined)
        )
          return refusal("transfer-needs-separate-permission");
        if (operation.operation === "sign-in" || operation.operation === "run-script")
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
        if (operation.operation === "download-save" && operation.downloadPermissionId === undefined)
          return {
            result: {
              error: "download-permission-required",
              message:
                "Choose a matching reviewed manifest from permissions and retry this download-save with its permissionId as downloadPermissionId. If none fits, ask a local person to review the sources, destination, types, limits and expiry in Settings > Data & storage. Account permission authorizes no file transfer.",
              permissions: input.downloadPermissions?.choices(current, profile) ?? [],
            },
            isError: true,
          };
        if (operation.operation === "upload" && operation.uploadPermissionId === undefined)
          return {
            result: {
              error: "upload-permission-required",
              message:
                "A local person reviews an exact file manifest in Settings > Data & storage. Retry with its uploadPermissionId; account permission alone authorizes no file transfer.",
              permissions:
                input.uploadPermissions?.choices(current, profile, origins[0] ?? "") ?? [],
            },
            isError: true,
          };
        if (
          entry !== undefined &&
          (!this.#options.grants.isCurrent(entry.grantId, current, profile, origins) ||
            String(this.#options.grants.ownerWindowFor(entry.grantId)) !== String(entry.windowId))
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
          const windowId = this.#options.grants.ownerWindowFor(grantId);
          if (windowId === undefined) return refusal("browser-needs-a-local-owner-window");
          const permitted = (candidate: StoredBrowserProfile, sites: ReadonlyArray<string>) => {
            const live = input.current();
            return (
              live !== undefined &&
              this.#options.grants.isCurrent(grantId, live, candidate, sites) &&
              String(this.#options.grants.ownerWindowFor(grantId)) === String(windowId)
            );
          };
          const service = new BrowserAutomationService({
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
            ...(this.#options.agentDownloadsEnabled === undefined
              ? {}
              : { agentDownloadsEnabled: this.#options.agentDownloadsEnabled }),
            ...(this.#options.downloads === undefined
              ? {}
              : {
                  downloads: {
                    saved: (context, file) =>
                      this.#options.downloads?.saved(
                        { ...context, threadId: input.contentThreadId ?? context.threadId },
                        file,
                      ),
                    refused: (context, file) =>
                      this.#options.downloads?.refused(
                        { ...context, threadId: input.contentThreadId ?? context.threadId },
                        file,
                      ),
                  },
                }),
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
            ...(input.downloadPermissions === undefined
              ? {}
              : {
                  downloadPermission: (request: {
                    readonly permissionId: string;
                    readonly profile: StoredBrowserProfile;
                  }) => {
                    const live = input.current();
                    return live === undefined
                      ? Promise.resolve(undefined)
                      : (input.downloadPermissions?.prepare({
                          ...request,
                          target: live,
                          callerIsCurrent: () =>
                            input.current() !== undefined &&
                            this.#options.agentDownloadsEnabled?.() === true &&
                            permitted(request.profile, origins),
                        }) ?? Promise.resolve(undefined));
                  },
                }),
            ...(input.uploadPermissions === undefined
              ? {}
              : {
                  uploadPermission: (request) => {
                    const live = input.current();
                    return live === undefined
                      ? undefined
                      : input.uploadPermissions?.prepare({
                          ...request,
                          target: live,
                          callerIsCurrent: () =>
                            input.current() !== undefined &&
                            permitted(request.profile, [request.origin]),
                        });
                  },
                }),
            browser: {
              inspectThread: (window, thread) => service.inspectThread(window, thread),
              create: (request) => service.create(request),
              act: (request) => service.act(request),
              saveDownload: (request) => service.saveDownload(request),
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
          String(this.#options.grants.ownerWindowFor(entry.grantId)) !== String(entry.windowId)
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
      ([, entry]) => String(entry.windowId) === String(windowId),
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
