import { describe, expect, it } from "vitest";
import { healthResponse } from "./health";

describe("healthResponse", () => {
  it("identifies the Octant server and version", async () => {
    const response = healthResponse("0.0.0-dev");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      product: "Octant",
      status: "ok",
      storage: "ready",
      version: "0.0.0-dev",
    });
  });

  it("identifies the managed server instance when supplied by its desktop parent", async () => {
    const response = healthResponse("0.0.0-dev", "managed-instance");

    expect(await response.json()).toEqual({
      product: "Octant",
      status: "ok",
      storage: "ready",
      version: "0.0.0-dev",
      instanceId: "managed-instance",
    });
  });

  it("exposes bounded host activity facts when supplied", async () => {
    const response = healthResponse("0.0.0-dev", "managed-instance", {
      activeAgentCount: 2,
      attentionRequired: true,
    });

    expect(await response.json()).toMatchObject({
      product: "Octant",
      status: "ok",
      storage: "ready",
      activeAgentCount: 2,
      attentionRequired: true,
    });
  });

  it("does not expose renderer mode because every renderer attaches to the same host", async () => {
    const response = healthResponse("0.0.0-dev");

    expect(await response.json()).not.toHaveProperty("developmentWebBootstrap");
  });
});
