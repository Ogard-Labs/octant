import type { CodeThreadId } from "@octant/contracts/code";
import type { AggregateVersion } from "@octant/contracts/events";
import type {
  TabGroupId,
  WindowId,
  WorkspaceOperation,
  WorkspaceTabId,
} from "@octant/contracts/shell";
import type { MentionableThreadId } from "@octant/contracts";
import {
  decodeWorkspacePresetApplied,
  decodeWorkspacePresetApplyRequest,
  decodeWorkspacePresetCatalogListing,
  type WorkspacePreset,
  type WorkspacePresetApplied,
  type WorkspacePresetSkillReport,
} from "@octant/contracts/workspace-presets";
import { planWorkspacePreset, reportWorkspacePresetSkills } from "@octant/domain";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const LIST_PATH = "/api/workspace-presets";
const APPLY_PATH = "/api/workspace-presets/apply";

export interface WorkspacePresetRouteDependencies {
  readonly presets: ReadonlyArray<WorkspacePreset>;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * The group a preset's panes open into and the thread they open against.
   * Resolved from the window's own workspace, never from the request, so a
   * preset cannot be applied to a thread the caller merely named.
   */
  readonly resolveTarget: (
    windowId: WindowId,
    threadId: CodeThreadId,
  ) => Promise<WorkspacePresetTarget | undefined>;
  readonly applyOperations: (
    windowId: WindowId,
    operations: ReadonlyArray<WorkspaceOperation>,
  ) => Promise<AggregateVersion>;
  /** The skills this thread's own resolved catalog leaves it able to use. */
  readonly resolveSkills: (
    windowId: WindowId,
    threadId: CodeThreadId,
  ) => Promise<ReadonlyArray<{ readonly name: string; readonly enabled: boolean }>>;
  readonly now?: () => number;
  readonly clock?: () => string;
}

export interface WorkspacePresetTarget {
  readonly groupId: TabGroupId;
  readonly mentionableThreadId: MentionableThreadId;
  readonly title: string;
}

/**
 * The curated workspace presets this host offers, and applying one.
 *
 * Local-window only. Applying composes every operation from the pinned preset
 * against a thread the window already has open, so a renderer selects a preset
 * and never authors a layout — and never reaches a surface the thread could
 * not open for itself.
 */
export function createWorkspacePresetRouteHandler(
  deps: WorkspacePresetRouteDependencies,
  mintTabId: () => WorkspaceTabId,
) {
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? (() => new Date().toISOString());
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (url.pathname !== LIST_PATH && url.pathname !== APPLY_PATH) return undefined;
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Workspace preset requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let windowId: WindowId;
    try {
      if (url.search !== "") return failure("Workspace preset request is invalid.", 400, origin);
      windowId = authenticateRouteWindowId({
        request,
        store: deps.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Workspace presets are unauthorized.", 401, origin)
        : failure("Workspace preset request is invalid.", 400, origin);
    }

    if (url.pathname === LIST_PATH && request.method === "GET") {
      try {
        return json(
          decodeWorkspacePresetCatalogListing({
            kind: "workspace-preset-catalog-listing",
            presets: deps.presets,
            observedAt: clock(),
          }),
          origin,
        );
      } catch {
        return failure("Workspace preset catalog could not be read.", 500, origin);
      }
    }
    if (url.pathname !== APPLY_PATH || request.method !== "POST") return undefined;

    let applied: WorkspacePresetApplied;
    try {
      const body = decodeWorkspacePresetApplyRequest(await request.json());
      const preset = deps.presets.find(
        (candidate) => String(candidate.id) === String(body.presetId),
      );
      if (preset === undefined) return failure("Workspace preset is unknown.", 404, origin);
      const target = await deps.resolveTarget(windowId, body.threadId);
      if (target === undefined) {
        return failure("This window has no such Code thread open.", 409, origin);
      }
      const operations = planWorkspacePreset({
        preset,
        thread: {
          threadId: body.threadId,
          mentionableThreadId: target.mentionableThreadId,
          title: target.title,
        },
        groupId: target.groupId,
        mintTabId: () =>
          mintTabId() as Parameters<typeof planWorkspacePreset>[0] extends never
            ? never
            : ReturnType<Parameters<typeof planWorkspacePreset>[0]["mintTabId"]>,
      });
      const version = await deps.applyOperations(windowId, operations);
      // Reported, never changed: a preset names skills, and whether the thread
      // may use one stays activation's decision.
      const skills: ReadonlyArray<WorkspacePresetSkillReport> = reportWorkspacePresetSkills(
        preset,
        await deps.resolveSkills(windowId, body.threadId),
      );
      applied = decodeWorkspacePresetApplied({
        kind: "workspace-preset-applied",
        presetId: preset.id,
        version,
        opened: preset.panes,
        skills,
      });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Workspace presets are unauthorized.", 401, origin)
        : failure("Workspace preset could not be applied.", 400, origin);
    }
    return json(applied, origin);
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function json(body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) || url.protocol === "file:";
  } catch {
    return false;
  }
}
