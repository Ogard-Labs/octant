import { describe, expect, it } from "vitest";
import { createProviderCredentialClient } from "./providerCredentialClient";

const instance = "10000000-0000-4000-8000-000000000001";
const secret = "sk-test-do-not-keep";

function host(answer: (path: string) => Response) {
  const sent: Array<{ readonly url: string; readonly body: unknown; readonly method: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    sent.push({ url, body: JSON.parse(String(init?.body)), method: init?.method ?? "GET" });
    return answer(new URL(url).pathname);
  };
  return { sent, client: createProviderCredentialClient({ baseUrl: "http://127.0.0.1", fetch }) };
}

describe("a provider key from a device the host's own person paired", () => {
  it("stores, reads the state of, and clears a key in the request body, never in the address", async () => {
    const { client, sent } = host((path) =>
      Response.json({ outcome: path.endsWith("/status") ? "stored" : "changed" }),
    );

    await client.setProviderCredential(instance, secret);
    expect(await client.providerCredentialStatus(instance)).toBe("stored");
    await client.clearProviderCredential(instance);

    expect(sent.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/api/providers/credentials/set"],
      ["POST", "/api/providers/credentials/status"],
      ["POST", "/api/providers/credentials/remove"],
    ]);
    expect(sent[0]?.body).toEqual({ instance, credential: secret, replace: true });
    for (const request of sent) expect(request.url).not.toContain(secret);
  });

  it("edits the key pool: adds a labelled key, lists labels only, and reorders", async () => {
    const key = { id: "default", label: "Work", active: true };
    const { client, sent } = host((path) =>
      path.endsWith("/keys/list")
        ? Response.json({ keys: [key] })
        : path.endsWith("/keys/add")
          ? Response.json({ key })
          : Response.json({ outcome: "changed" }),
    );

    expect(await client.addProviderApiKey(instance, secret, "Work")).toEqual(key);
    expect(await client.listProviderApiKeys(instance)).toEqual([key]);
    await client.renameProviderApiKey(instance, "default", "Personal");
    await client.replaceProviderApiKey(instance, "default", secret);
    await client.setActiveProviderApiKey(instance, "default");
    await client.moveProviderApiKey(instance, "default", "down");
    await client.removeProviderApiKey(instance, "default");

    expect(sent.map((request) => new URL(request.url).pathname)).toEqual(
      ["add", "list", "rename", "replace", "set-active", "move", "remove"].map(
        (name) => `/api/providers/credentials/keys/${name}`,
      ),
    );
    expect(sent[0]?.body).toEqual({ instance, credential: secret, label: "Work" });
    expect(sent[5]?.body).toEqual({ instance, keyId: "default", direction: "down" });
  });

  it("reports the host's refusal of a restricted session without repeating the key", async () => {
    const { client } = host(() =>
      Response.json({ category: "unauthorized", message: "Not allowed." }, { status: 401 }),
    );

    expect(await client.providerCredentialStatus(instance)).toBe("unavailable");
    const refusals = await Promise.all([
      client.setProviderCredential(instance, secret).catch((error: unknown) => error),
      client.addProviderApiKey(instance, secret).catch((error: unknown) => error),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(Error);
      expect(String(refusal)).not.toContain(secret);
    }
  });

  it("says a linked secret must be unlinked first, and passes the pool's own refusal on", async () => {
    const linked = host(() => Response.json({ category: "linked-secret" }, { status: 409 }));
    await expect(linked.client.setProviderCredential(instance, secret)).rejects.toThrow(
      /linked secret store/,
    );
    const pool = host(() =>
      Response.json(
        { category: "api-key-pool", reason: "duplicate", message: "That key is already stored." },
        { status: 409 },
      ),
    );
    await expect(pool.client.addProviderApiKey(instance, secret)).rejects.toThrow(
      "That key is already stored.",
    );
  });
});
