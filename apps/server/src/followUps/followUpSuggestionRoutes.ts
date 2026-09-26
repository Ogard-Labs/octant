import {
  decodeActivateNativeHarnessFollowUp,
  decodeNativeHarnessFollowUpPreview,
  type NativeHarnessFollowUpActivationResult,
  type NativeHarnessFollowUpCreation,
  type ThreadFollowUpSuggestions,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  previewFollowUpCreation,
  type FollowUpCreationOutcome,
} from "./followUpSuggestionCreation";
import type { ThreadFollowUpSuggestionStore } from "./threadFollowUpSuggestionStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const PREFIX = "/api/follow-up-suggestions/";

export interface FollowUpSuggestionActionDependencies {
  readonly store: Pick<ThreadFollowUpSuggestionStore, "read" | "activate" | "activation">;
  /**
   * Creates what a confirmed follow-up names, on the confirming window. Absent
   * on a host that only records the activation.
   */
  readonly createFollowUp?: (input: {
    readonly windowId: string;
    readonly view: ThreadFollowUpSuggestions;
    readonly creation: NativeHarnessFollowUpCreation;
  }) => Promise<FollowUpCreationOutcome>;
}

export interface FollowUpSuggestionRouteDependencies extends FollowUpSuggestionActionDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** Whether this window may read the thread and act on it; never a body field. */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

/** Suggestions whose thread is being created right now, so a repeat waits its turn and is refused. */
const activating = new Set<string>();

/**
 * Previews or activates one suggestion on a thread the caller is already
 * authorized for. Activation refuses a repeat before anything is created,
 * then creates through the mode's ordinary command and only then records
 * the decision, so a refused creation leaves the chip available.
 */
export async function settleFollowUpSuggestion(
  dependencies: FollowUpSuggestionActionDependencies,
  input: {
    readonly threadId: string;
    readonly windowId: string;
    readonly action: string;
    readonly body: unknown;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const view = dependencies.store.read(input.threadId);
  const record = (input.body ?? {}) as Record<string, unknown>;
  const suggestion = view?.followUps.suggestions.find(
    (entry) => String(entry.id) === String(record.suggestionId),
  );
  if (view === undefined || suggestion === undefined) {
    return {
      status: 404,
      body: refused(String(record.suggestionId ?? ""), "suggestion-not-found"),
    };
  }
  const created = previewFollowUpCreation(view, suggestion);
  if (created === undefined) {
    return { status: 409, body: refused(String(suggestion.id), "target-unavailable") };
  }
  if (input.action === "preview") {
    return {
      status: 200,
      body: { preview: decodeNativeHarnessFollowUpPreview({ suggestion, wouldCreate: created }) },
    };
  }
  if (input.action !== "activate") {
    return { status: 404, body: { error: "Unknown follow-up action." } };
  }
  let activation;
  try {
    activation = decodeActivateNativeHarnessFollowUp(input.body);
  } catch {
    return {
      status: 400,
      body: { error: "Follow-up activation requires an explicit confirmation." },
    };
  }
  // A confirmation retried after its answer was lost gets that same answer,
  // so the created thread still opens with the prompt waiting.
  const previous = dependencies.store.activation(input.threadId, String(suggestion.id));
  if (previous !== undefined) return { status: 200, body: activated(suggestion.id, previous) };
  // Refuse a repeat before anything is created, not after — including a
  // second request that arrives while the first is still creating.
  const activationKey = `${input.threadId}:${String(suggestion.id)}`;
  if (
    view.activatedFollowUpIds.some((id) => String(id) === String(suggestion.id)) ||
    activating.has(activationKey)
  ) {
    return { status: 409, body: refused(String(suggestion.id), "already-activated") };
  }
  activating.add(activationKey);
  let creation: FollowUpCreationOutcome;
  try {
    creation =
      dependencies.createFollowUp === undefined
        ? { kind: "created", created, onSuggestingModel: true }
        : await dependencies.createFollowUp({ windowId: input.windowId, view, creation: created });
  } finally {
    activating.delete(activationKey);
  }
  if (creation.kind === "refused") {
    const result: NativeHarnessFollowUpActivationResult = {
      kind: "follow-up-refused",
      suggestionId: suggestion.id,
      reason: "target-unavailable",
      message: creation.message,
    };
    return { status: 409, body: result };
  }
  // A later reply may have replaced the set while the thread was being
  // created. The thread exists either way, so the person still gets it; only
  // the record of which chip made it has nowhere to go.
  dependencies.store.activate(input.threadId, activation.suggestionId, creation.created);
  return { status: 200, body: activated(suggestion.id, creation.created) };
}

function activated(
  suggestionId: NativeHarnessFollowUpActivationResult["suggestionId"],
  created: NativeHarnessFollowUpCreation,
): NativeHarnessFollowUpActivationResult {
  return { kind: "follow-up-activated", suggestionId, created };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

/**
 * A thread's follow-up suggestions on every provider: read them, preview what
 * one would create, and activate it with an explicit confirmation.
 */
export function createFollowUpSuggestionRouteHandler(
  dependencies: FollowUpSuggestionRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Follow-up suggestion requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let windowId: string;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: "Follow-up suggestion request is unauthorized." }, 401, origin);
      }
      return json({ error: "Follow-up suggestion request is invalid." }, 400, origin);
    }
    const [threadId = "", action = ""] = url.pathname.slice(PREFIX.length).split("/");
    if (threadId.length === 0) return json({ error: "Thread id is required." }, 400, origin);
    if (!(await dependencies.authorizeThread({ threadId, windowId }))) {
      return json({ error: "Follow-up suggestion request is unauthorized." }, 403, origin);
    }
    if (request.method === "GET" && action === "") {
      return json({ suggestions: dependencies.store.read(threadId) ?? null }, 200, origin);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Follow-up suggestion body must be valid JSON." }, 400, origin);
    }
    const settled = await settleFollowUpSuggestion(dependencies, {
      threadId,
      windowId,
      action,
      body,
    });
    return json(settled.body, settled.status, origin);
  };
}

function refused(
  suggestionId: string,
  reason: Extract<NativeHarnessFollowUpActivationResult, { kind: "follow-up-refused" }>["reason"],
): NativeHarnessFollowUpActivationResult {
  return {
    kind: "follow-up-refused",
    suggestionId: suggestionId as never,
    reason,
    message: `The follow-up was refused: ${reason}.`,
  };
}
