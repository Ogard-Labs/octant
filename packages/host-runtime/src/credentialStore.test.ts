import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";

describe("CredentialStore", () => {
  it("defines a replaceable provider-instance credential port", async () => {
    const calls: string[] = [];
    const store: CredentialStore = {
      set: async (providerInstanceId, credential) => {
        calls.push(`set:${providerInstanceId}:${credential}`);
      },
      has: async (providerInstanceId) => {
        calls.push(`has:${providerInstanceId}`);
        return true;
      },
      resolve: async (providerInstanceId) => {
        calls.push(`resolve:${providerInstanceId}`);
        return "stored-value";
      },
      delete: async (providerInstanceId) => {
        calls.push(`delete:${providerInstanceId}`);
      },
    };

    await store.set("provider-id", "private-value");
    await expect(store.has("provider-id")).resolves.toBe(true);
    await expect(store.resolve("provider-id")).resolves.toBe("stored-value");
    await store.delete("provider-id");

    expect(calls).toEqual([
      "set:provider-id:private-value",
      "has:provider-id",
      "resolve:provider-id",
      "delete:provider-id",
    ]);
  });

  it("exposes stable sanitized failure categories", () => {
    const failure = new CredentialStoreFailure("unavailable");

    expect(failure).toMatchObject({
      name: "CredentialStoreFailure",
      category: "unavailable",
      message: "The secure credential store is unavailable.",
    });
    expect(JSON.stringify(failure)).not.toContain("private-value");
  });
});
