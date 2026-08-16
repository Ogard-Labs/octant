import {
  decodeProviderFailure,
  type OpenAiCompatibleProtocol,
  type ProviderFailure,
} from "@octant/contracts";
import type { ProtocolTurnFailureMetadata } from "./openAiResponses";

export type CompatibleProtocol = Exclude<OpenAiCompatibleProtocol, "auto">;

export type CompatibleProtocolAttemptResult<T> =
  | { readonly ok: true; readonly value: T }
  | ({ readonly ok: false } & ProtocolTurnFailureMetadata);

export type CompatibleProtocolAttempt<T> = (
  protocol: CompatibleProtocol,
) => Promise<CompatibleProtocolAttemptResult<T>>;

export interface RuntimeProtocolCache {
  readonly get: (instanceId: string) => CompatibleProtocol | undefined;
  readonly set: (instanceId: string, protocol: CompatibleProtocol) => void;
  readonly delete: (instanceId: string) => void;
  readonly clear: () => void;
}

export interface CompatibleProtocolSelectionInput<T> {
  readonly instanceId: string;
  readonly preference: OpenAiCompatibleProtocol;
  readonly cache: RuntimeProtocolCache;
  readonly attempt: CompatibleProtocolAttempt<T>;
}

const ROUTE_REJECTION_STATUSES = new Set([404, 405, 501]);

export function makeRuntimeProtocolCache(): RuntimeProtocolCache {
  const protocols = new Map<string, CompatibleProtocol>();
  return {
    get: (instanceId) => protocols.get(instanceId),
    set: (instanceId, protocol) => protocols.set(instanceId, protocol),
    delete: (instanceId) => protocols.delete(instanceId),
    clear: () => protocols.clear(),
  };
}

export async function selectCompatibleProtocol<T>(
  input: CompatibleProtocolSelectionInput<T>,
): Promise<T> {
  if (input.preference !== "auto") {
    return unwrap(await safeAttempt(input.attempt, input.preference));
  }

  const selected = input.cache.get(input.instanceId) ?? "responses";
  const first = await safeAttempt(input.attempt, selected);
  if (first.ok) {
    input.cache.set(input.instanceId, selected);
    return first.value;
  }

  if (selected !== "responses" || !permitsChatFallback(first)) throw first.failure;
  const fallback = await safeAttempt(input.attempt, "chat-completions");
  if (!fallback.ok) throw fallback.failure;
  input.cache.set(input.instanceId, "chat-completions");
  return fallback.value;
}

function permitsChatFallback(
  failure: Extract<CompatibleProtocolAttemptResult<unknown>, { ok: false }>,
) {
  return (
    failure.failure.category === "unsupported" &&
    failure.accepted === false &&
    failure.outputStarted === false &&
    failure.httpStatus !== undefined &&
    ROUTE_REJECTION_STATUSES.has(failure.httpStatus)
  );
}

function unwrap<T>(result: CompatibleProtocolAttemptResult<T>): T {
  if (!result.ok) throw sanitizeFailure(result.failure);
  return result.value;
}

async function safeAttempt<T>(
  attempt: CompatibleProtocolAttempt<T>,
  protocol: CompatibleProtocol,
): Promise<CompatibleProtocolAttemptResult<T>> {
  try {
    const result = await attempt(protocol);
    if (result.ok) return result;
    return { ...result, failure: sanitizeFailure(result.failure) };
  } catch (error) {
    throw sanitizeFailure(error);
  }
}

function sanitizeFailure(error: unknown): ProviderFailure {
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return {
      category: "provider-failed",
      message: "The provider protocol attempt failed.",
    };
  }
}
