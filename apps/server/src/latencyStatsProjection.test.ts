import { describe, expect, it } from "vitest";
import {
  LatencyStatsProjection,
  observedRpcLatency,
  slowRequestRoute,
} from "./latencyStatsProjection";

describe("LatencyStatsProjection", () => {
  it("reports nearest-rank percentiles and lifetime slow counts", () => {
    const projection = new LatencyStatsProjection();
    projection.record("rpc", 1);
    projection.record("rpc", 2);
    projection.record("rpc", 15_000);
    projection.record("provider-runtime-acquire", -4.4);

    expect(projection.read()).toEqual({
      measurements: [
        {
          key: "rpc",
          label: "Request handling",
          observationCount: 3,
          p50Ms: 2,
          p95Ms: 15_000,
          maxMs: 15_000,
          slowThresholdMs: 15_000,
          slowCount: 1,
        },
        {
          key: "provider-runtime-acquire",
          label: "Provider runtime start",
          observationCount: 1,
          p50Ms: 0,
          p95Ms: 0,
          maxMs: 0,
        },
      ],
    });
  });

  it("keeps percentiles bounded to the newest 256 samples", () => {
    const projection = new LatencyStatsProjection();
    for (let duration = 0; duration < 512; duration += 1) {
      projection.record("rpc", duration);
    }

    expect(projection.read().measurements[0]).toEqual({
      key: "rpc",
      label: "Request handling",
      observationCount: 512,
      p50Ms: 383,
      p95Ms: 499,
      maxMs: 511,
      slowThresholdMs: 15_000,
      slowCount: 0,
    });
  });

  it("counts toolchain observations at the slow threshold", () => {
    const projection = new LatencyStatsProjection();
    projection.record("rpc-toolchain", 120_000);

    expect(projection.read().measurements).toContainEqual({
      key: "rpc-toolchain",
      label: "Toolchain request handling",
      observationCount: 1,
      p50Ms: 120_000,
      p95Ms: 120_000,
      maxMs: 120_000,
      slowThresholdMs: 120_000,
      slowCount: 1,
    });
  });
});

describe("observedRpcLatency", () => {
  it("classifies product RPCs and excludes non-RPC paths", () => {
    expect(observedRpcLatency("/api/chat/commands")).toBe("rpc");
    expect(observedRpcLatency("/api/chat/attachments/file")).toBe("rpc-toolchain");
    expect(observedRpcLatency("/api/usage/export")).toBe("rpc-toolchain");
    expect(observedRpcLatency("/health")).toBeUndefined();
    expect(observedRpcLatency("/assets/app.js")).toBeUndefined();
  });
});

describe("slowRequestRoute", () => {
  it("replaces identifiers without changing the route shape", () => {
    expect(
      slowRequestRoute(
        "/api/chat/threads/66000000-0000-4000-8000-000000000001/messages/opaque-token-value-123456",
      ),
    ).toBe("/api/chat/threads/:id/messages/:id");
  });
});
