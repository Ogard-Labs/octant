import { describe, expect, it, vi } from "vitest";
import { consumeOnePasswordBrowserCredential } from "./onePasswordBrowserCredential";

const item = {
  store: "onepassword" as const,
  accountId: "a".repeat(26),
  vaultId: "v".repeat(26),
  itemId: "i".repeat(26),
};
const expected = { item, title: "Fixture", version: 2, websiteOrigins: ["https://login.example"] };
const json = {
  category: "LOGIN",
  id: item.itemId,
  vault: { id: item.vaultId },
  title: expected.title,
  version: 2,
  urls: [{ href: "https://login.example" }],
  fields: [
    { id: "username", purpose: "USERNAME", type: "STRING", value: "fixture-user" },
    { id: "password", purpose: "PASSWORD", type: "CONCEALED", value: "fixture-private-value" },
  ],
};
describe("selected Browser credential consumption", () => {
  it("gives only the selected version's fixed login fields to a private consumer and returns no value", async () => {
    const consume = vi.fn(async () => undefined);
    const run = vi.fn(async (_file: string, _args: ReadonlyArray<string>) => ({
      kind: "exited" as const,
      exitCode: 0,
      stdout: JSON.stringify(json),
      stderr: "",
    }));
    const result = await consumeOnePasswordBrowserCredential(
      expected,
      { executable: "/fixture/op", run, env: {}, timeoutMs: 1000 },
      consume,
    );
    expect(result).toEqual({ status: "consumed" });
    expect(consume).toHaveBeenCalledExactlyOnceWith({
      username: "fixture-user",
      password: "fixture-private-value",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-private-value");
    expect(run.mock.calls[0]?.[1]).toEqual([
      "item",
      "get",
      item.itemId,
      "--account",
      item.accountId,
      "--vault",
      item.vaultId,
      "--format",
      "json",
    ]);
  });
  it.each([
    { ...json, version: 3 },
    { ...json, fields: [] },
    { ...json, fields: [...json.fields, json.fields[1]] },
    { ...json, urls: [{ href: "https://elsewhere.example" }] },
  ])("refuses changed or ambiguous credentials without calling the consumer", async (value) => {
    const consume = vi.fn(async () => undefined);
    const result = await consumeOnePasswordBrowserCredential(
      expected,
      {
        executable: "/fixture/op",
        env: {},
        timeoutMs: 1000,
        run: async () => ({
          kind: "exited",
          exitCode: 0,
          stdout: JSON.stringify(value),
          stderr: "",
        }),
      },
      consume,
    );
    expect(result.status).not.toBe("consumed");
    expect(consume).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("fixture-private-value");
  });
});
