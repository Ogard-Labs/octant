import { describe, expect, it, vi } from "vitest";
import { createProviderCloudSessionClient } from "./providerCloudSessionClient";

describe("provider cloud client", () => {
  it("uses the authenticated host route and fails closed for malformed or unavailable replies", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ status: "ready", profiles: [], jobs: [] }))
      .mockResolvedValueOnce(
        Response.json({ status: "completed", secret: "synthetic-invalid-field" }),
      );
    const client = createProviderCloudSessionClient({
      baseUrl: "http://127.0.0.1:3100",
      windowCapability: "fixture-capability",
      fetch,
    });
    expect(await client.execute({ kind: "profiles" })).toEqual({
      status: "ready",
      profiles: [],
      jobs: [],
    });
    const call = fetch.mock.calls[0];
    expect(String(call?.[0])).toBe("http://127.0.0.1:3100/api/provider-cloud");
    expect(call?.[1]?.headers).toMatchObject({
      "x-octant-window-capability": "fixture-capability",
    });
    expect(await client.execute({ kind: "profiles" })).toEqual({
      status: "refused",
      reason: "unavailable",
    });
  });
});
