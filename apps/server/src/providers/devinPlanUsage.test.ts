import { decodeProviderInstanceId } from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeDevinPlanUsageFacts } from "./devinPlanUsage";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000d1");
const credentialPath = "/home/person/.local/share/devin/credentials.toml";
const clock = () => "2026-10-20T12:00:00.000Z";

// The shape GetUserStatus answers with: ProtoJSON, so 64-bit integers are
// strings and a zero is left out.
const statusAnswer = {
  userStatus: {
    planStatus: {
      planInfo: { planName: "Pro" },
      dailyQuotaRemainingPercent: 64,
      dailyQuotaResetAtUnix: "1792540800",
      weeklyQuotaRemainingPercent: 12,
      weeklyQuotaResetAtUnix: "1793059200",
      overageBalanceMicros: "4000000",
    },
  },
};

function recordingFetch(response: () => Response) {
  const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  return {
    requests,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return response();
    },
  };
}

function observe(facts: ReturnType<typeof makeDevinPlanUsageFacts>) {
  return Effect.runPromise(
    Effect.scoped(Effect.either(facts.observeServiceLimits({ instanceId }))),
  );
}

describe("Devin plan usage", () => {
  it("shows the daily and weekly allowance left from the saved sign-in", async () => {
    const http = recordingFetch(() => Response.json(statusAnswer));
    const outcome = await observe(
      makeDevinPlanUsageFacts({
        instanceId,
        credentialPath,
        clock,
        fetch: http.fetch,
        readText: async () =>
          'windsurf_api_key = "devin-key-1"\napi_server_url = "https://server.example.com/"\n',
      }),
    );

    expect(outcome._tag).toBe("Right");
    if (outcome._tag !== "Right") return;
    expect(outcome.right.quota).toBe("available");
    expect(outcome.right.rateLimitWindows).toEqual([
      {
        window: "one_day",
        status: "allowed",
        utilization: 0.36,
        resetsAt: "2026-10-21T00:00:00.000Z",
        observedAt: clock(),
      },
      {
        window: "seven_day",
        status: "warning",
        utilization: 0.88,
        resetsAt: "2026-10-27T00:00:00.000Z",
        observedAt: clock(),
      },
    ]);
    const [request] = http.requests;
    expect(request?.url).toBe(
      "https://server.example.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    );
    expect(request?.init.method).toBe("POST");
    expect(JSON.parse(String(request?.init.body))).toMatchObject({
      metadata: { apiKey: "devin-key-1" },
    });
  });

  it("reads a window the answer left without a figure as used up", async () => {
    const http = recordingFetch(() =>
      Response.json({
        userStatus: {
          planStatus: { planInfo: { hideDailyQuota: true }, weeklyQuotaResetAtUnix: "1793059200" },
        },
      }),
    );
    const outcome = await observe(
      makeDevinPlanUsageFacts({
        instanceId,
        credentialPath,
        clock,
        fetch: http.fetch,
        readText: async () => 'windsurf_api_key = "devin-key-1"\n',
      }),
    );

    expect(outcome._tag).toBe("Right");
    if (outcome._tag !== "Right") return;
    expect(outcome.right.quota).toBe("exhausted");
    expect(outcome.right.rateLimitWindows?.map((window) => window.window)).toEqual(["seven_day"]);
    expect(http.requests[0]?.url.startsWith("https://server.codeium.com/")).toBe(true);
  });

  it("reports Devin not signed in without calling out when the credentials file is missing", async () => {
    const http = recordingFetch(() => Response.json(statusAnswer));
    const outcome = await observe(
      makeDevinPlanUsageFacts({
        instanceId,
        credentialPath,
        clock,
        fetch: http.fetch,
        readText: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unavailable" } });
    expect(http.requests).toHaveLength(0);
  });

  it("fails as a protocol change, without the key, when the answer stops matching", async () => {
    const http = recordingFetch(() => Response.json({ userStatus: { renamed: true } }));
    const outcome = await observe(
      makeDevinPlanUsageFacts({
        instanceId,
        credentialPath,
        clock,
        fetch: http.fetch,
        readText: async () => 'windsurf_api_key = "devin-key-1"\n',
      }),
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "protocol" } });
    expect(JSON.stringify(outcome)).not.toContain("devin-key-1");
  });

  it("refuses a sign-in the server rejects and never sends the key to a plain http server", async () => {
    const http = recordingFetch(() => new Response("denied", { status: 401 }));
    const outcome = await observe(
      makeDevinPlanUsageFacts({
        instanceId,
        credentialPath,
        clock,
        fetch: http.fetch,
        readText: async () =>
          'windsurf_api_key = "devin-key-1"\napi_server_url = "http://plain.example.com"\n',
      }),
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unauthenticated" } });
    expect(http.requests[0]?.url.startsWith("https://server.codeium.com/")).toBe(true);
  });
});
