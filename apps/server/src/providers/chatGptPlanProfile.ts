import type { ProviderFailure } from "@octant/contracts";
import type { CompatibleListedModels, CompatibleModelsListing } from "./openAiCompatibleEndpoint";

/**
 * The ChatGPT plan (Sign in with ChatGPT) request profile.
 *
 * The plan route is a preview with a fixed wire contract: `store:false` and
 * `stream:true` are mandatory, `input` must be an array carrying the full
 * history, system text travels as `instructions` (an explicit system-role
 * message item is rejected), and a fixed set of parameters must be omitted
 * entirely. Tools are function tools only — no hosted tools. This module is
 * the single place that contract is expressed: the driver threads the profile
 * from the resolved credential's descriptor into every Responses turn, and a
 * request that cannot be expressed under the profile is refused with a typed
 * reason before anything leaves the process.
 */

/** The descriptor id of the ChatGPT plan catalog offer. */
export const CHATGPT_PLAN_DESCRIPTOR_ID = "chatgpt-plan";

/** Whether a credential descriptor id selects the ChatGPT plan profile. */
export function isChatGptPlanDescriptor(descriptorId: string | undefined): boolean {
  return descriptorId === CHATGPT_PLAN_DESCRIPTOR_ID;
}

/**
 * Parameters the plan preview does not accept. A request carrying any of
 * these is refused before send; the profile never silently strips a field
 * the caller asked for, because a silently different request is worse than
 * a typed refusal.
 */
export const CHATGPT_PLAN_FORBIDDEN_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

export type ChatGptPlanForbiddenField = (typeof CHATGPT_PLAN_FORBIDDEN_FIELDS)[number];

/**
 * A request the plan profile cannot express. `field` names a parameter the
 * preview omits entirely. `store`, `stream`, and `input-shape` name a
 * mandatory wire constraint that was not met, rather than pretending the
 * problem was some other field.
 */
export type ChatGptPlanProfileRefusal =
  | { readonly kind: "forbidden-field"; readonly field: ChatGptPlanForbiddenField }
  | { readonly kind: "store" }
  | { readonly kind: "stream" }
  | { readonly kind: "input-shape" }
  | { readonly kind: "body-shape" }
  | { readonly kind: "tools-shape" }
  | { readonly kind: "hosted-tool"; readonly tool: string }
  | { readonly kind: "system-message-item" }
  | { readonly kind: "plan-usage-disabled" };

/**
 * Inspect a Responses request body under the plan profile. Returns the first
 * refusal, or undefined when the body is expressible. The check is on the
 * exact wire keys, so a field the profile does not know about is not refused
 * here — the profile only ever sends keys it has explicitly allowed.
 */
export function inspectChatGptPlanRequestBody(
  body: unknown,
): ChatGptPlanProfileRefusal | undefined {
  if (!isRecord(body)) return { kind: "body-shape" };
  for (const field of CHATGPT_PLAN_FORBIDDEN_FIELDS) {
    if (field in body) return { kind: "forbidden-field", field };
  }
  if (body.store !== false) return { kind: "store" };
  if (body.stream !== true) return { kind: "stream" };
  if (!Array.isArray(body.input)) return { kind: "input-shape" };
  for (const item of body.input) {
    if (isRecord(item) && item.type === "message" && item.role === "system") {
      return { kind: "system-message-item" };
    }
  }
  const tools = body.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return { kind: "tools-shape" };
    for (const tool of tools) {
      if (!isRecord(tool)) return { kind: "tools-shape" };
      if (tool.type !== "function") {
        return { kind: "hosted-tool", tool: typeof tool.type === "string" ? tool.type : "unknown" };
      }
    }
  }
  return undefined;
}

/** The typed provider failure a profile refusal maps to. */
export function chatGptPlanRefusalFailure(refusal: ChatGptPlanProfileRefusal): ProviderFailure {
  switch (refusal.kind) {
    case "forbidden-field":
      return {
        category: "unsupported",
        message: `The ChatGPT plan route does not accept the "${refusal.field}" parameter.`,
      };
    case "store":
      return {
        category: "unsupported",
        message: 'The ChatGPT plan route requires "store" to be false.',
      };
    case "stream":
      return {
        category: "unsupported",
        message: 'The ChatGPT plan route requires "stream" to be true.',
      };
    case "input-shape":
      return {
        category: "unsupported",
        message:
          'The ChatGPT plan route requires "input" to be an array carrying the full history.',
      };
    case "body-shape":
      return {
        category: "unsupported",
        message: "The ChatGPT plan route requires a JSON object body.",
      };
    case "tools-shape":
      return {
        category: "unsupported",
        message:
          "The ChatGPT plan route requires tools to be an array of function tool definitions.",
      };
    case "hosted-tool":
      return {
        category: "unsupported",
        message: `The ChatGPT plan route does not support the hosted tool "${refusal.tool}". Only function tools are available on this route.`,
      };
    case "system-message-item":
      return {
        category: "protocol",
        message:
          "The ChatGPT plan route rejects system-role message items; system text is sent as instructions.",
      };
    case "plan-usage-disabled":
      return {
        category: "unauthorized",
        message:
          "This ChatGPT account did not grant plan usage. Sign in again and allow plan access, or use an API key.",
      };
  }
}

/**
 * The plan route's structured error codes, mapped to user-facing states.
 * `subscription_sharing_usage_limit_exceeded` is a usage limit with a
 * provider-owned recovery link; `subscription_sharing_usage_unavailable` is
 * transient with bounded backoff; `subscription_sharing_unsupported_capability`
 * names the field to fix; the 401/403 codes are unauthenticated.
 */
export const CHATGPT_PLAN_MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

export type ChatGptPlanErrorState =
  | { readonly kind: "usage-limit"; readonly manageUsageUrl: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unsupported-capability"; readonly code: string }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "not-eligible" }
  | { readonly kind: "unknown" };

export function chatGptPlanErrorState(
  code: string | undefined,
  httpStatus: number | undefined,
): ChatGptPlanErrorState {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return { kind: "usage-limit", manageUsageUrl: CHATGPT_PLAN_MANAGE_USAGE_URL };
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return { kind: "unavailable" };
    case "subscription_sharing_unsupported_capability":
      return { kind: "unsupported-capability", code };
    case "subscription_sharing_invalid_user":
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return { kind: "unauthenticated" };
    case "subscription_sharing_user_not_eligible":
    case "subscription_sharing_route_not_supported":
      return { kind: "not-eligible" };
    default:
      if (httpStatus === 401 || httpStatus === 403) return { kind: "unauthenticated" };
      if (httpStatus === 503) return { kind: "unavailable" };
      return { kind: "unknown" };
  }
}

/** The typed provider failure a plan-route error state maps to. */
export function chatGptPlanErrorFailure(state: ChatGptPlanErrorState): ProviderFailure {
  switch (state.kind) {
    case "usage-limit":
      return {
        category: "rate-limited",
        message: `Your ChatGPT plan usage limit was reached. Manage usage at ${state.manageUsageUrl}.`,
      };
    case "unavailable":
      return {
        category: "unavailable",
        message: "The ChatGPT plan route is unavailable right now. Retry shortly.",
      };
    case "unsupported-capability":
      return {
        category: "unsupported",
        message: `The ChatGPT plan route rejected the request (${state.code}). The request shape is not supported on this route.`,
      };
    case "unauthenticated":
      return {
        category: "unauthenticated",
        message: "The ChatGPT plan route rejected the sign-in. Sign in again to continue.",
      };
    case "not-eligible":
      return {
        category: "unauthorized",
        message:
          "This ChatGPT account is not eligible for plan usage on this route. A ChatGPT Plus or Pro plan is required.",
      };
    case "unknown":
      return {
        category: "provider-failed",
        message: "The ChatGPT plan route failed the request.",
      };
  }
}

/**
 * How Check connection reads the plan route's `/models` answer. The plan
 * preview's contract covers Responses turns, not model enumeration, and the
 * sign-in grants no model-read scope, so the route may answer with a body
 * that is not a model list, a refusal, or no models at all. Each of those is
 * reported in words with the person's manual model IDs instead of failing
 * the check as an invalid response. Credential, usage, and availability codes
 * keep their typed plan states.
 */
export const chatGptPlanModelsListing: CompatibleModelsListing = {
  classifyRejection(status, body) {
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      return undefined;
    }
    const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
    const code = typeof error?.code === "string" ? error.code : undefined;
    if (
      code === "subscription_sharing_route_not_supported" ||
      code === "subscription_sharing_unsupported_capability"
    ) {
      return "unlisted";
    }
    if (
      code !== undefined &&
      (code.startsWith("subscription_sharing_") || code.startsWith("chatpass_v2_"))
    ) {
      return chatGptPlanErrorFailure(chatGptPlanErrorState(code, status));
    }
    // OpenAI answers a token without the model-read scope with a 401 whose
    // message names the missing scope. The sign-in is valid for Responses
    // turns; it only cannot enumerate models, so asking the person to sign
    // in again would loop.
    if (
      status === 401 &&
      typeof error?.message === "string" &&
      error.message.includes("Missing scopes: api.model.read")
    ) {
      return "unlisted";
    }
    return undefined;
  },
  readListedModels: readChatGptPlanModels,
  unlistedMessage(answer, hasManualModels) {
    if (hasManualModels) {
      return "Models can't be listed on the ChatGPT plan; Octant uses your manual model IDs.";
    }
    return answer === "empty"
      ? "The ChatGPT plan listed no models. Add the model IDs your plan offers under Manual model IDs, then check the connection again."
      : "Models can't be listed on the ChatGPT plan. Add the model IDs your plan offers under Manual model IDs, then check the connection again.";
  },
};

/**
 * The plan route lists models as `{models:[…]}` (observed live: a 200 JSON
 * body whose only top-level key is `models`), in the Codex backend's item
 * style rather than the OpenAI `{data:[{id}]}` list. Each item's id is the
 * most specific field present (`slug`, then `id`, then `name`); its display
 * name and reported context window are kept when well-formed. An item that
 * cannot be mapped is skipped, never thrown on.
 */
function readChatGptPlanModels(value: unknown): CompatibleListedModels | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
  const models: Array<CompatibleListedModels["models"][number]> = [];
  for (const item of value.models) {
    if (!isRecord(item)) continue;
    const id = [item.slug, item.id, item.name].find(isModelIdentifier);
    if (id === undefined) continue;
    const displayName = [item.display_name, item.displayName].find(isDisplayText);
    const contextLimit = [item.context_window, item.contextWindow].find(isPositiveInteger);
    models.push({
      id,
      ...(displayName === undefined ? {} : { displayName: displayName.trim() }),
      ...(contextLimit === undefined ? {} : { contextLimit }),
    });
  }
  const first: unknown = value.models[0];
  return {
    models,
    ...(first === undefined
      ? {}
      : { firstItemKeys: isRecord(first) ? Object.keys(first).sort().slice(0, 24) : [] }),
  };
}

function isModelIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim()
  );
}

function isDisplayText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
