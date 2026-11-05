import { describe, expect, it } from "vitest";
import {
  decodeBrowserCredentialCommand,
  decodeBrowserCredentialMetadata,
  decodeBrowserCredentialTarget,
  decodeBrowserCredentialHostCommand,
  decodeBrowserCredentialHostResult,
  decodeBrowserCredentialResult,
} from "./browserCredentialUse";

const item = {
  store: "onepassword",
  accountId: "a".repeat(26),
  vaultId: "v".repeat(26),
  itemId: "i".repeat(26),
};
const context = {
  contextId: "00000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000002",
  mode: "code",
};
describe("Browser credential-use boundary", () => {
  it("carries only opaque fill plans and effect receipts across public and host boundaries", () => {
    const planId = "00000000-0000-4000-8000-000000000010";
    const command = { kind: "confirm-browser-credential-fill", ...context, planId };
    expect(decodeBrowserCredentialCommand(command)).toEqual(command);
    for (const extra of [
      { password: "fixture" },
      { script: "document.cookie" },
      { selector: "#password" },
      { origin: "https://forged.example" },
    ])
      expect(() => decodeBrowserCredentialCommand({ ...command, ...extra })).toThrow();
    const receipt = { status: "filled", effect: "completed" };
    expect(decodeBrowserCredentialHostResult(receipt)).toEqual(receipt);
    expect(() => decodeBrowserCredentialHostResult({ ...receipt, username: "fixture" })).toThrow();
    expect(() =>
      decodeBrowserCredentialHostCommand({
        kind: "commit-browser-credential-fill",
        contextId: context.contextId,
        owner: { windowId: context.threadId, threadId: context.threadId },
        planId,
        custodyId: planId,
        password: "fixture",
      }),
    ).toThrow();
    expect(() =>
      decodeBrowserCredentialResult({
        kind: "browser-credential-fill-outcome",
        planId,
        status: "signed-in",
        effect: "completed",
        message: "Not established",
      }),
    ).toThrow();
  });
  it("requires immutable pins and refuses credential values and OAuth identity payloads", () => {
    expect(
      decodeBrowserCredentialCommand({ kind: "review-browser-credential", ...context, item }),
    ).toHaveProperty("item", item);
    for (const invalid of [
      { ...item, accountId: "Personal" },
      { ...item, password: "fixture" },
      { kind: "oauth", subject: "fixture" },
    ])
      expect(() =>
        decodeBrowserCredentialCommand({
          kind: "review-browser-credential",
          ...context,
          item: invalid,
        }),
      ).toThrow();
  });
  it("refuses iframe grants, non-canonical origins and excessive metadata", () => {
    const target = {
      ...context,
      projectId: "00000000-0000-4000-8000-000000000003",
      profile: { kind: "private" },
      topOrigin: "https://login.example:8443",
      frame: { kind: "top", origin: "https://login.example:8443" },
    };
    expect(decodeBrowserCredentialTarget(target)).toEqual(target);
    expect(() =>
      decodeBrowserCredentialTarget({ ...target, frame: { ...target.frame, kind: "iframe" } }),
    ).toThrow();
    expect(() =>
      decodeBrowserCredentialTarget({ ...target, topOrigin: "https://login.example/path" }),
    ).toThrow();
    const metadata = {
      item,
      title: "Fixture",
      version: 1,
      storeRevision: "fixture",
      websiteOrigins: [target.topOrigin],
    };
    expect(() =>
      decodeBrowserCredentialMetadata({
        ...metadata,
        websiteOrigins: Array(9).fill(target.topOrigin),
      }),
    ).toThrow();
    expect(() => decodeBrowserCredentialMetadata({ ...metadata, password: "fixture" })).toThrow();
  });
});
