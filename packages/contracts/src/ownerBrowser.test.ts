import { describe, expect, it } from "vitest";
import { decodeOwnerBrowserRequest } from "./ownerBrowser";

const target = {
  hostMemberId: "a7880000-0000-4000-8000-000000000001",
  threadId: "a7880000-0000-4000-8000-000000000002",
  contextId: "a7880000-0000-4000-8000-000000000003",
  targetVersion: "a".repeat(64),
  documentRevision: 1,
  origin: "https://fixture.invalid",
  profile: "private",
};

describe("owner Browser request boundary", () => {
  it("binds one selected Private page and refuses another profile, invented identity or arbitrary native command", () => {
    expect(decodeOwnerBrowserRequest({ kind: "take-over", target })).toMatchObject({ target });
    expect(() =>
      decodeOwnerBrowserRequest({ kind: "take-over", target: { ...target, profile: "personal" } }),
    ).toThrow();
    expect(() =>
      decodeOwnerBrowserRequest({ kind: "take-over", target, windowId: target.threadId }),
    ).toThrow();
    const command = {
      kind: "input",
      controlId: target.contextId,
      sequence: 1,
      expectedFrame: 1,
      input: { kind: "type", text: "synthetic input" },
    };
    expect(decodeOwnerBrowserRequest(command)).toMatchObject(command);
    expect(() =>
      decodeOwnerBrowserRequest({ ...command, input: { kind: "evaluate", source: "1+1" } }),
    ).toThrow();
    expect(() =>
      decodeOwnerBrowserRequest({ ...command, input: { kind: "type", text: "x".repeat(4097) } }),
    ).toThrow();
  });
});
