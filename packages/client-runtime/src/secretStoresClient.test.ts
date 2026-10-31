import { describe, expect, it, vi } from "vitest";
import { SecretStoresClientFailure, createSecretStoresClient } from "./secretStoresClient";

const view = {
  kind: "secret-stores-view",
  brokerAvailable: true,
  stores: [{ kind: "onepassword", label: "1Password", linked: false, tool: "ready" }],
};

describe("secret stores client", () => {
  it("refuses a host that is not this machine", () => {
    expect(() =>
      createSecretStoresClient({
        baseUrl: "https://octant.example",
        fetch: vi.fn(),
        windowCapability: "capability",
      }),
    ).toThrow(SecretStoresClientFailure);
  });

  it("reads the linked stores with the window capability", async () => {
    const fetch = vi.fn(async () => Response.json(view));
    const client = createSecretStoresClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "capability",
    });

    expect(await client.read()).toEqual(view);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:13773/api/secret-stores/settings", {
      method: "GET",
      headers: { "x-octant-window-capability": "capability" },
    });
  });

  it("sends a command as JSON and drops a field the contract does not name", async () => {
    const fetch = vi.fn(async () => Response.json({ ...view, value: "must-not-pass" }));
    const client = createSecretStoresClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "capability",
    });

    const answer = await client.execute({ kind: "link-store", store: "onepassword" });
    expect(JSON.stringify(answer)).not.toContain("must-not-pass");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/secret-stores/commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "link-store", store: "onepassword" }),
      }),
    );
  });

  it("surfaces the host's refusal message", async () => {
    const client = createSecretStoresClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        Response.json({ message: "Secret stores are host-only." }, { status: 403 }),
      ),
      windowCapability: "capability",
    });

    await expect(client.read()).rejects.toThrow("Secret stores are host-only.");
  });
});
