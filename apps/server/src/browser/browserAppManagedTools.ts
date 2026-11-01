import { browserToolImage } from "./browserToolImage";
import { admitBrowserUpload } from "./browserUploadFiles";
import {
  browserToolAction,
  browserToolResult,
  browserToolWantsScreenshot,
  parseBrowserToolInput,
} from "./browserToolOperations";
import { BROWSER_TOOL_DEFINITION, BROWSER_TOOL_HELP } from "./browserToolDefinition";
import type {
  BrowserActionRequest,
  BrowserAutomationSnapshot,
  BrowserContextPolicy,
  BrowserThreadId,
  StoredBrowserProfile,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  ToolActionRequest,
  WindowId,
} from "@octant/contracts";
import { MAX_BROWSER_TABS_PER_CONTEXT, sameToolActionAuthority } from "@octant/contracts";
import { browserProfileKey, isToolAllowedByAllowlist, storedBrowserProfile } from "@octant/domain";
import { withToolFamilyHelp, type AppManagedToolSet } from "../providers/appManagedToolSet";
import type { BrowserToolApprovalService } from "./browserToolApprovalService";

export const BROWSER_TOOL_NAME = BROWSER_TOOL_DEFINITION.name;

export interface BrowserAppManagedToolsOptions {
  readonly windowId: WindowId;
  readonly threadId: BrowserThreadId;
  readonly mode: "chat" | "work" | "code";
  /** Model selected when this tool set was composed. */
  readonly modelId: string;
  /** Resolves the current persisted model before each approval/effect. */
  readonly resolveModelId: (
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ) => string | undefined;
  /** Host-owned in-memory bindings that survive per-turn tool-set factories. */
  readonly modelBindings: Map<string, BrowserModelBinding>;
  readonly resolveAuthority: (
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ) => ToolActionAuthority | undefined;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly toolConstraints?: ReadonlyArray<string>;
  readonly browser: {
    readonly inspectThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => BrowserAutomationSnapshot;
    readonly create: (input: {
      readonly windowId: WindowId;
      readonly threadId: BrowserThreadId;
      readonly action: ToolActionRequest;
      readonly policy: BrowserContextPolicy;
      readonly profileCaller?: "terminal-grant";
    }) => Promise<BrowserAutomationSnapshot>;
    readonly act: (input: {
      readonly windowId: WindowId;
      readonly request: BrowserActionRequest;
      readonly capturedBy?: "agent";
      readonly uploadFiles?: ReadonlyArray<string>;
      readonly releaseUpload?: () => Promise<void>;
    }) => Promise<BrowserAutomationSnapshot>;
    readonly releaseThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => Promise<BrowserAutomationSnapshot>;
  };
  readonly approvals?: Pick<BrowserToolApprovalService, "request"> &
    Partial<Pick<BrowserToolApprovalService, "isRemembered" | "isUnattendedScope">>;
  /**
   * Set for a CLI the person typed into a thread terminal. It may drive the
   * thread's Private pages only; a page in a signed-in profile needs a person.
   */
  readonly profileCaller?: "terminal-grant";
  /**
   * The folder an upload may send files from: the Work thread's Project
   * folder. Absent, an upload is refused.
   */
  readonly uploadRoot?: () => string | undefined;
  readonly uuid: () => string;
}

export interface BrowserModelBinding {
  readonly modelId: string;
  readonly authority: ToolActionAuthority;
}

const hostPolicy: BrowserContextPolicy = {
  profileMode: "isolated",
  allowedOrigins: [],
  credentialFieldProtection: true,
  maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
  sessionTimeoutMs: 600_000,
};

export function createBrowserAppManagedTools(
  options: BrowserAppManagedToolsOptions,
): AppManagedToolSet {
  const initialAuthority = options.resolveAuthority(options.threadId, options.mode);
  const definitions = isToolAllowedByAllowlist(options.toolConstraints ?? [], BROWSER_TOOL_NAME)
    ? [BROWSER_TOOL_DEFINITION]
    : [];
  const tools: AppManagedToolSet = {
    definitions,
    execute: async ({ inputJson, name, signal }) => {
      if (name !== BROWSER_TOOL_NAME || definitions.length === 0) {
        return failure("tool-unavailable");
      }
      if (signal?.aborted) return failure("tool-interrupted");
      const input = parseBrowserToolInput(inputJson, { allowProfile: true });
      if (input === undefined) return failure("invalid-browser-input");
      const authority = options.resolveAuthority(options.threadId, options.mode);
      if (authority === undefined) return failure("browser-authority-unavailable");
      if (initialAuthority !== undefined && !sameToolActionAuthority(initialAuthority, authority)) {
        return failure("browser-authority-stale");
      }
      if (input.operation === "stop") {
        const snapshot = options.browser.inspectThread(options.windowId, options.threadId);
        if (snapshot.context !== undefined) {
          options.modelBindings.delete(String(snapshot.context.contextId));
        }
        return browserToolResult(
          await options.browser.releaseThread(options.windowId, options.threadId),
        );
      }
      if (!modelIsCurrent(options)) return failure("browser-model-stale");
      if (options.executionPolicy === "plan") return failure("plan-mode-read-only");
      let snapshot = options.browser.inspectThread(options.windowId, options.threadId);
      const existing = snapshot.context?.state === "active" ? snapshot.context : undefined;
      if (existing === undefined && snapshot.context !== undefined) {
        options.modelBindings.delete(String(snapshot.context.contextId));
      }
      const origin =
        existing === undefined
          ? input.operation === "navigate"
            ? allowedOrigin(input.url)
            : undefined
          : existing.policy.allowedOrigins.join(", ");
      if (origin === undefined) {
        return failure(
          input.operation === "navigate" ? "invalid-browser-url" : "browser-navigation-required",
        );
      }
      // A page's profile is fixed when it opens. An existing page keeps its own,
      // and the agent cannot move it: stopping the browser and opening again is
      // how a different profile is chosen, and the person is asked again.
      const existingProfile = storedBrowserProfile(existing?.policy.profile);
      if (
        existing !== undefined &&
        input.operation === "navigate" &&
        input.profile !== undefined &&
        browserProfileKey(existingProfile) !==
          browserProfileKey(requestedProfile(input.profile, authority))
      ) {
        return failure("browser-profile-differs-stop-first");
      }
      const profile: StoredBrowserProfile | undefined =
        existing !== undefined
          ? existingProfile
          : input.operation === "navigate" && input.profile !== undefined
            ? requestedProfile(input.profile, authority)
            : undefined;
      if (input.operation === "navigate" && input.profile === "project" && profile === undefined) {
        return failure("profile-unavailable");
      }
      if (
        profile !== undefined &&
        (options.profileCaller === "terminal-grant" ||
          options.approvals?.isUnattendedScope?.(options.windowId) === true)
      ) {
        return failure("profile-needs-a-person");
      }
      const existingBinding =
        existing === undefined ? undefined : options.modelBindings.get(String(existing.contextId));
      const contextApproved =
        existingBinding !== undefined &&
        String(existingBinding.modelId) === String(options.modelId) &&
        sameToolActionAuthority(existingBinding.authority, authority);
      // A remembered origin grant stands in for the prompt when the context
      // itself is new: "always allow" answered an open for this origin before.
      // An existing context still asks when its binding no longer matches —
      // the remembered grant covers the page, not a new model driving it.
      const remembered =
        existing === undefined && options.approvals?.isRemembered?.(origin, profile) === true;
      if ((existing === undefined || !contextApproved) && !remembered) {
        if (options.approvals === undefined) return failure("browser-approval-required");
        const outcome = await options.approvals.request({
          windowId: options.windowId,
          threadId: String(options.threadId),
          authority,
          origin,
          ...(profile === undefined ? {} : { profile }),
          ...(signal === undefined ? {} : { signal }),
        });
        if (outcome !== "approved") return failure(`browser-approval-${outcome}`);
        if (signal?.aborted) return failure("tool-interrupted");
        const refreshed = options.resolveAuthority(options.threadId, options.mode);
        if (refreshed === undefined || !sameToolActionAuthority(authority, refreshed)) {
          return failure("browser-authority-stale");
        }
        if (!modelIsCurrent(options)) return failure("browser-model-stale");
        if (existing !== undefined) {
          rememberModelBinding(options.modelBindings, String(existing.contextId), {
            modelId: options.modelId,
            authority: refreshed,
          });
        }
      }
      if (existing === undefined) {
        const created = await options.browser.create({
          windowId: options.windowId,
          threadId: options.threadId,
          action: actionRequest(options, authority),
          policy: {
            ...hostPolicy,
            ...(profile === undefined ? {} : { profile }),
            allowedOrigins: [origin],
          },
          ...(options.profileCaller === undefined ? {} : { profileCaller: options.profileCaller }),
        });
        snapshot = created;
        if (created.context?.state === "active") {
          const contextId = String(created.context.contextId);
          rememberModelBinding(options.modelBindings, contextId, {
            modelId: options.modelId,
            authority,
          });
        }
      }
      const context = snapshot.context;
      if (context === undefined || context.state !== "active") return browserToolResult(snapshot);
      const contextId = String(context.contextId);
      const binding = options.modelBindings.get(contextId);
      const bindingMatches =
        binding !== undefined &&
        String(binding.modelId) === String(options.modelId) &&
        sameToolActionAuthority(binding.authority, authority);
      if (!bindingMatches && existing !== undefined) {
        if (options.approvals === undefined) return failure("browser-approval-required");
        const outcome = await options.approvals.request({
          windowId: options.windowId,
          threadId: String(options.threadId),
          authority,
          origin,
          ...(profile === undefined ? {} : { profile }),
          ...(signal === undefined ? {} : { signal }),
        });
        if (outcome !== "approved") return failure(`browser-approval-${outcome}`);
        if (signal?.aborted) return failure("tool-interrupted");
        const refreshed = options.resolveAuthority(options.threadId, options.mode);
        if (refreshed === undefined || !sameToolActionAuthority(authority, refreshed)) {
          return failure("browser-authority-stale");
        }
        if (!modelIsCurrent(options)) return failure("browser-model-stale");
        rememberModelBinding(options.modelBindings, contextId, {
          modelId: options.modelId,
          authority: refreshed,
        });
      }
      const request = browserToolAction(input, context);
      if (request === undefined) return failure("invalid-browser-input");
      if (signal?.aborted) return failure("tool-interrupted");
      let uploadFiles: ReadonlyArray<string> | undefined;
      let releaseUpload: (() => Promise<void>) | undefined;
      if (input.operation === "upload") {
        // A CLI in a terminal is not the person who would be asked.
        if (options.profileCaller === "terminal-grant") return failure("upload-needs-a-person");
        const approvals = options.approvals;
        if (approvals === undefined) return failure("browser-approval-required");
        const admitted = await admitBrowserUpload({
          workspaceRoot: options.uploadRoot?.(),
          files: input.files,
          ask: (files) =>
            approvals.request({
              windowId: options.windowId,
              threadId: String(options.threadId),
              authority,
              origin,
              ...(profile === undefined ? {} : { profile }),
              upload: files,
              ...(signal === undefined ? {} : { signal }),
            }),
        });
        if (admitted.status === "refused") return failure(admitted.reason);
        uploadFiles = admitted.paths;
        releaseUpload = admitted.release;
      }
      if (releaseUpload !== undefined) {
        const refreshed = options.resolveAuthority(options.threadId, options.mode);
        const refusal = signal?.aborted
          ? "tool-interrupted"
          : refreshed === undefined || !sameToolActionAuthority(authority, refreshed)
            ? "browser-authority-stale"
            : !modelIsCurrent(options)
              ? "browser-model-stale"
              : undefined;
        if (refusal !== undefined) {
          await releaseUpload();
          return failure(refusal);
        }
      }
      // The page reads an uploaded file when its form is sent, which can be a
      // later action, so the service keeps the copies until the page closes.
      const acted = await options.browser.act({
        windowId: options.windowId,
        request,
        capturedBy: "agent",
        ...(uploadFiles === undefined ? {} : { uploadFiles }),
        ...(releaseUpload === undefined ? {} : { releaseUpload }),
      });
      if (signal?.aborted) return failure("tool-interrupted");
      if (!modelIsCurrent(options)) return failure("browser-model-stale");
      if (
        input.operation === "screenshot" &&
        browserToolImage(acted.observation?.screenshotDataUrl) === undefined
      ) {
        return failure("browser-screenshot-unavailable");
      }
      return browserToolResult(acted, browserToolWantsScreenshot(input));
    },
  };
  return withToolFamilyHelp(tools, BROWSER_TOOL_HELP);
}

/** The stored profile a `profile` argument names for this thread, if it has one. */
function requestedProfile(
  choice: "project" | "personal",
  authority: ToolActionAuthority,
): StoredBrowserProfile | undefined {
  if (choice === "personal") return { kind: "personal" };
  return authority.projectId === undefined
    ? undefined
    : { kind: "project", projectId: authority.projectId };
}

function modelIsCurrent(options: BrowserAppManagedToolsOptions): boolean {
  const current = options.resolveModelId(options.threadId, options.mode);
  return current !== undefined && String(current) === String(options.modelId);
}

const MAX_BROWSER_MODEL_BINDINGS = 256;

function rememberModelBinding(
  bindings: Map<string, BrowserModelBinding>,
  contextId: string,
  binding: BrowserModelBinding,
): void {
  if (!bindings.has(contextId) && bindings.size >= MAX_BROWSER_MODEL_BINDINGS) {
    const oldest = bindings.keys().next().value;
    if (oldest !== undefined) bindings.delete(oldest);
  }
  bindings.set(contextId, binding);
}

function actionRequest(
  options: BrowserAppManagedToolsOptions,
  authority: ToolActionAuthority,
): ToolActionRequest {
  return {
    actionId: options.uuid() as ToolActionRequest["actionId"],
    correlationId: options.uuid() as ToolActionRequest["correlationId"],
    capability: { id: "browser-automation" as ToolActionRequest["capability"]["id"], version: 1 },
    authority,
    intent: "Operate the thread-owned isolated browser.",
    approval: { kind: "not-required" },
  };
}

function allowedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function failure(reason: string) {
  return { result: { error: reason }, isError: true };
}
