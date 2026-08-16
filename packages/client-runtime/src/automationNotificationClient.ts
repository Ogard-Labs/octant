import {
  decodeAutomationNotificationDeliveryQueryResponse,
  decodeAutomationNotificationDeliveryStatus,
  decodeAutomationNotificationPreferences,
  type AutomationNotificationDeliveryQueryResponse,
  type AutomationNotificationDeliveryStatus,
  type AutomationNotificationPreferences,
  type UpdateAutomationNotificationPreferences,
} from "@octant/contracts";

export interface AutomationNotificationClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly windowCapability?: string;
  /**
   * Total attempts per request across reconnects. Status and delivery queries
   * are read-only; preference updates carry expectedVersion so a replay after
   * a dropped connection returns the original receipt or a typed conflict.
   */
  readonly maxAttempts?: number;
}

export interface AutomationNotificationDeliveryQueryInput {
  readonly automationId?: string;
  readonly runId?: string;
  readonly projectId?: string;
}

export interface AutomationNotificationClient {
  readonly preferences: () => Promise<AutomationNotificationPreferences>;
  readonly status: () => Promise<AutomationNotificationDeliveryStatus>;
  readonly deliveries: (
    input?: AutomationNotificationDeliveryQueryInput,
  ) => Promise<AutomationNotificationDeliveryQueryResponse>;
  readonly update: (
    input: UpdateAutomationNotificationPreferences,
  ) => Promise<AutomationNotificationPreferences>;
}

export class AutomationNotificationClientFailure extends Error {
  readonly code: "unavailable" | "unauthorized" | "conflict" | "invalid" | "forbidden";

  constructor(code: AutomationNotificationClientFailure["code"], message: string) {
    super(message);
    this.name = "AutomationNotificationClientFailure";
    this.code = code;
  }
}

const DEFAULT_MAX_ATTEMPTS = 2;

export function createAutomationNotificationClient(
  options: AutomationNotificationClientOptions,
): AutomationNotificationClient {
  const fetchImpl = options.fetch ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const headers = (): HeadersInit => {
    const next: Record<string, string> = { "content-type": "application/json" };
    if (options.windowCapability !== undefined) {
      next["x-octant-window-capability"] = options.windowCapability;
    }
    return next;
  };

  return {
    async preferences() {
      return request(
        fetchImpl,
        new URL("/api/automation-notifications", options.baseUrl).toString(),
        { method: "GET", headers: headers() },
        (body) => {
          const value = body as { readonly preferences?: unknown };
          return decodeAutomationNotificationPreferences(value.preferences);
        },
        "preferences",
        maxAttempts,
      );
    },
    async status() {
      return request(
        fetchImpl,
        new URL("/api/automation-notifications/status", options.baseUrl).toString(),
        { method: "GET", headers: headers() },
        (body) => {
          const value = body as { readonly status?: unknown };
          return decodeAutomationNotificationDeliveryStatus(value.status);
        },
        "status",
        maxAttempts,
      );
    },
    async deliveries(input = {}) {
      const url = new URL("/api/automation-notifications/deliveries", options.baseUrl);
      if (input.automationId !== undefined)
        url.searchParams.set("automationId", input.automationId);
      if (input.runId !== undefined) url.searchParams.set("runId", input.runId);
      if (input.projectId !== undefined) url.searchParams.set("projectId", input.projectId);
      return request(
        fetchImpl,
        url.toString(),
        { method: "GET", headers: headers() },
        (body) => decodeAutomationNotificationDeliveryQueryResponse(body),
        "deliveries",
        maxAttempts,
      );
    },
    async update(input) {
      return request(
        fetchImpl,
        new URL("/api/automation-notifications", options.baseUrl).toString(),
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(input),
        },
        (body) => {
          const value = body as { readonly preferences?: unknown };
          return decodeAutomationNotificationPreferences(value.preferences);
        },
        "update",
        maxAttempts,
      );
    },
  };
}

async function request<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  decode: (body: unknown) => T,
  operation: string,
  maxAttempts: number,
): Promise<T> {
  let lastUnavailable: AutomationNotificationClientFailure | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      lastUnavailable = new AutomationNotificationClientFailure(
        "unavailable",
        `Automation notification ${operation} is unavailable.`,
      );
      continue;
    }
    if (!response.ok) throw mapFailure(response.status, operation);
    try {
      return decode(await response.json());
    } catch {
      throw new AutomationNotificationClientFailure(
        "unavailable",
        `Automation notification ${operation} is malformed.`,
      );
    }
  }
  throw (
    lastUnavailable ??
    new AutomationNotificationClientFailure(
      "unavailable",
      `Automation notification ${operation} is unavailable.`,
    )
  );
}

function mapFailure(status: number, operation: string): AutomationNotificationClientFailure {
  if (status === 401) {
    return new AutomationNotificationClientFailure(
      "unauthorized",
      `Automation notification ${operation} is unauthorized.`,
    );
  }
  if (status === 403) {
    return new AutomationNotificationClientFailure(
      "forbidden",
      `Automation notification ${operation} is forbidden.`,
    );
  }
  if (status === 409) {
    return new AutomationNotificationClientFailure(
      "conflict",
      "Automation notification preferences changed concurrently.",
    );
  }
  if (status === 400) {
    return new AutomationNotificationClientFailure(
      "invalid",
      `Automation notification ${operation} request is invalid.`,
    );
  }
  return new AutomationNotificationClientFailure(
    "unavailable",
    `Automation notification ${operation} is unavailable.`,
  );
}
