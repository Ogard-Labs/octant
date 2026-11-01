import {
  ProviderToolingApplyResult,
  ProviderToolingListResult,
  ProviderToolingPlanResult,
  decodeHostAnswer,
  type ProviderInstanceId,
  type ProviderToolingApplyRequest,
  type ProviderToolingRequest,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ProviderToolingClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class ProviderToolingClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderToolingClientFailure";
    this.status = status;
  }
}

/**
 * Lists, plans, and runs the provider commands that add or remove an account's
 * tools. The host decides each one: a refusal comes back as a result the page
 * can say in words, and only a transport or authority failure throws. Only the
 * window on the host holds the capability these routes need.
 */
export interface ProviderToolingClient {
  list(providerInstanceId: ProviderInstanceId): Promise<ProviderToolingListResult>;
  plan(
    providerInstanceId: ProviderInstanceId,
    request: ProviderToolingRequest,
  ): Promise<ProviderToolingPlanResult>;
  apply(request: ProviderToolingApplyRequest): Promise<ProviderToolingApplyResult>;
}

export function createProviderToolingClient(
  options: ProviderToolingClientOptions,
): ProviderToolingClient {
  const send = async <A>(
    path: string,
    body: unknown,
    decode: (value: unknown) => A,
  ): Promise<A> => {
    let url: URL;
    try {
      url = new URL(path, options.baseUrl);
    } catch {
      throw new ProviderToolingClientFailure("Provider tooling base URL is invalid.", 0);
    }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      throw new ProviderToolingClientFailure("Provider tooling base URL must be loopback.", 0);
    }
    const fetch = bindFetchPort(options.fetch);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ProviderToolingClientFailure("Provider tooling is unavailable.", 0);
    }
    const answer: unknown = await response.json().catch(() => ({}));
    // A refusal the host wrote (including one for a paired device) is an answer.
    if (!response.ok && !isRefusal(answer)) {
      throw new ProviderToolingClientFailure(
        readError(answer) ?? "Provider tooling is unavailable.",
        response.status,
      );
    }
    return decode(answer);
  };
  const decodeList = decodeHostAnswer(ProviderToolingListResult);
  const decodePlan = decodeHostAnswer(ProviderToolingPlanResult);
  const decodeApply = decodeHostAnswer(ProviderToolingApplyResult);
  return {
    list: (providerInstanceId) =>
      send("/api/provider-tooling/list", { providerInstanceId }, decodeList),
    plan: (providerInstanceId, request) =>
      send("/api/provider-tooling/plan", { providerInstanceId, request }, decodePlan),
    apply: (request) => send("/api/provider-tooling/apply", request, decodeApply),
  };
}

function isRefusal(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).status === "refused"
  );
}

function readError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() !== "" ? error : undefined;
}
