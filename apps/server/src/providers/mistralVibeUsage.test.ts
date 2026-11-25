import { decodeProviderInstanceId } from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMistralVibeUsageFacts } from "./mistralVibeUsage";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000b1");
const clock = () => "2026-11-25T12:00:00.000Z";
const key = "mistral-key-1";

const budgetAnswer = {
  usage_percentage: 88,
  api_budget: { usage_percentage: 91 },
  vibe_budget: {
    usage_percentage: 0.5,
    initial_budget: 25,
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: true,
  },
};

function recordingFetch(response: (url: string) => Response) {
  const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  return {
    requests,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return response(url);
    },
  };
}

function observe(facts: ReturnType<typeof makeMistralVibeUsageFacts>, onDemand = true) {
  return Effect.runPromise(
    Effect.scoped(Effect.either(facts.observeServiceLimits({ instanceId, onDemand }))),
  );
}

function facts(options: {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly authentication?: "api-key" | "subscription" | "provider-owned";
  readonly hasKey?: boolean;
  readonly key?: string;
}) {
  return makeMistralVibeUsageFacts({
    readings: new Map(),
    instanceId,
    clock,
    fetch: options.fetch,
    ...(options.authentication === undefined ? {} : { authentication: options.authentication }),
    credentialResolver: {
      has: async () => options.hasKey !== false,
      resolve: async () => options.key ?? key,
    },
  });
}

describe("Mistral Vibe plan usage", () => {
  it("shows the monthly Vibe Code allowance, reset time, and PAYG from the saved Settings key", async () => {
    const http = recordingFetch(() => Response.json(budgetAnswer));

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome._tag).toBe("Right");
    if (outcome._tag !== "Right") return;
    expect(outcome.right.quota).toBe("available");
    expect(outcome.right.rateLimitWindows).toEqual([
      {
        window: "monthly",
        status: "allowed",
        utilization: 0.005,
        resetsAt: "2026-12-01T00:00:00.000Z",
        observedAt: clock(),
        overage: { status: "allowed", disabledReason: "Pay as you go on" },
      },
    ]);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.url).toBe("https://api.mistral.ai/v1/billing/budget");
    expect(http.requests[0]?.init.method).toBe("GET");
    expect(new Headers(http.requests[0]?.init.headers).get("authorization")).toBe(`Bearer ${key}`);
    expect(new Headers(http.requests[0]?.init.headers).get("accept")).toBe("application/json");
  });

  it("fills PAYG from the subscription endpoint only when the budget omits it", async () => {
    const http = recordingFetch((url) =>
      url.endsWith("/subscription")
        ? Response.json({ vibe_payg_enabled: false })
        : Response.json({
            vibe_budget: {
              usage_percentage: 12,
              initial_budget: 20,
              reset_at: "2026-12-01T00:00:00Z",
            },
          }),
    );

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome._tag).toBe("Right");
    if (outcome._tag !== "Right") return;
    expect(outcome.right.rateLimitWindows).toEqual([
      {
        window: "monthly",
        status: "allowed",
        utilization: 0.12,
        resetsAt: "2026-12-01T00:00:00.000Z",
        observedAt: clock(),
        overage: { status: "allowed", disabledReason: "Pay as you go off" },
      },
    ]);
    expect(http.requests.map((request) => request.url)).toEqual([
      "https://api.mistral.ai/v1/billing/budget",
      "https://api.mistral.ai/v1/billing/subscription",
    ]);
  });

  it("keeps the monthly window when the subscription fallback fails", async () => {
    const http = recordingFetch((url) =>
      url.endsWith("/subscription")
        ? new Response("denied", { status: 403 })
        : Response.json({
            vibe_budget: { usage_percentage: 40, initial_budget: 10 },
          }),
    );

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome._tag).toBe("Right");
    if (outcome._tag !== "Right") return;
    expect(outcome.right.rateLimitWindows).toEqual([
      {
        window: "monthly",
        status: "allowed",
        utilization: 0.4,
        observedAt: clock(),
      },
    ]);
  });

  it("says plan limits do not apply when Mistral reports no Vibe budget, never 0%", async () => {
    const http = recordingFetch(() => Response.json({ usage_percentage: 0 }));

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unsupported" } });
    expect(JSON.stringify(outcome)).not.toContain(key);
  });

  it("says plan limits do not apply when the initial budget is zero", async () => {
    const http = recordingFetch(() =>
      Response.json({ vibe_budget: { usage_percentage: 0, initial_budget: 0 } }),
    );

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unsupported" } });
  });

  it("refuses a saved sign-in Mistral rejects, without the key", async () => {
    const http = recordingFetch(() => new Response("denied", { status: 401 }));

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unauthenticated" } });
    expect(JSON.stringify(outcome)).not.toContain(key);
  });

  it("treats a 403 as a key that cannot view usage, not as 0% used", async () => {
    const http = recordingFetch(() => new Response("{}", { status: 403 }));

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { category: "unsupported", message: "This account cannot view Vibe billing usage." },
    });
    expect(JSON.stringify(outcome)).not.toContain(key);
  });

  it("does not call out when the instance is not configured for an API key", async () => {
    const http = recordingFetch(() => Response.json(budgetAnswer));

    const outcome = await observe(facts({ authentication: "subscription", fetch: http.fetch }));

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unavailable" } });
    expect(http.requests).toHaveLength(0);
  });

  it("does not call out when Settings holds no Mistral API key", async () => {
    const http = recordingFetch(() => Response.json(budgetAnswer));

    const outcome = await observe(
      facts({ authentication: "api-key", hasKey: false, fetch: http.fetch }),
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unavailable" } });
    expect(http.requests).toHaveLength(0);
  });

  it("fails as a protocol change, without the key, when the used share is not a percent", async () => {
    const http = recordingFetch(() =>
      Response.json({ vibe_budget: { usage_percentage: 250, initial_budget: 20 } }),
    );

    const outcome = await observe(facts({ authentication: "api-key", fetch: http.fetch }));

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "protocol" } });
    expect(JSON.stringify(outcome)).not.toContain(key);
  });

  it("answers a Chat turn from the last reading and reads again at most every five minutes", async () => {
    const http = recordingFetch(() => Response.json(budgetAnswer));
    let now = Date.parse(clock());
    const usage = makeMistralVibeUsageFacts({
      readings: new Map(),
      instanceId,
      authentication: "api-key",
      clock: () => new Date(now).toISOString(),
      fetch: http.fetch,
      credentialResolver: {
        has: async () => true,
        resolve: async () => key,
      },
    });

    expect(await observe(usage, false)).toMatchObject({
      _tag: "Left",
      left: { category: "unavailable" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(http.requests).toHaveLength(1);

    expect((await observe(usage, false))._tag).toBe("Right");
    expect((await observe(usage, false))._tag).toBe("Right");
    expect(http.requests).toHaveLength(1);

    now += 5 * 60_000;
    expect((await observe(usage, false))._tag).toBe("Right");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(http.requests).toHaveLength(2);
  });
});
