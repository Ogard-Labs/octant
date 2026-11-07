import { describe, expect, it, vi } from "vitest";
import { readOnePasswordBrowserMetadata } from "./onePasswordBrowserMetadata";

const item = {
  store: "onepassword" as const,
  accountId: "a".repeat(26),
  vaultId: "v".repeat(26),
  itemId: "i".repeat(26),
};
const details = {
  id: item.itemId,
  vault: { id: item.vaultId },
  title: "Fixture login",
  version: 3,
  urls: [{ href: "https://login.example:8443/path?token=synthetic" }],
  fields: [{ id: "password", value: "synthetic-secret-must-not-leave-adapter" }],
};

function runner(value: unknown) {
  return vi.fn(async () => ({
    kind: "exited" as const,
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  }));
}
const options = { executable: "/fixture/op", env: {}, timeoutMs: 1000 };

describe("selected Browser credential metadata", () => {
  it("pins the exact account, vault and item and returns only bounded metadata", async () => {
    const run = runner(details);
    const result = await readOnePasswordBrowserMetadata(item, { ...options, run });
    expect(run).toHaveBeenCalledWith(
      "/fixture/op",
      [
        "item",
        "get",
        item.itemId,
        "--account",
        item.accountId,
        "--vault",
        item.vaultId,
        "--format",
        "json",
      ],
      { env: {}, timeoutMs: 1000 },
    );
    expect(result).toEqual({
      status: "described",
      item,
      title: "Fixture login",
      version: 3,
      websiteOrigins: ["https://login.example:8443"],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(JSON.stringify(result)).not.toContain("token=");
  });

  it.each([
    { ...details, id: "different" },
    { ...details, vault: { id: "different" } },
    { ...details, urls: [] },
    { ...details, urls: Array.from({ length: 9 }, () => ({ href: "https://login.example" })) },
    { ...details, urls: [{ href: "http://login.example" }] },
    { ...details, urls: [{ href: "https://user:password@login.example" }] },
    { ...details, version: undefined },
  ])("refuses uncertain or mismatched item metadata without exposing its fields", async (value) => {
    const result = await readOnePasswordBrowserMetadata(item, { ...options, run: runner(value) });
    expect(result).toEqual({ status: "uncertain" });
  });

  it("refuses names and ambient service-account or Connect authority before invoking the tool", async () => {
    const run = runner(details);
    await expect(
      readOnePasswordBrowserMetadata({ ...item, accountId: "Personal" }, { ...options, run }),
    ).resolves.toEqual({ status: "invalid-item" });
    for (const env of [
      { OP_SERVICE_ACCOUNT_TOKEN: "fixture" },
      { OP_CONNECT_HOST: "https://fixture" },
    ]) {
      await expect(readOnePasswordBrowserMetadata(item, { ...options, run, env })).resolves.toEqual(
        { status: "unavailable" },
      );
    }
    expect(run).not.toHaveBeenCalled();
  });
});
