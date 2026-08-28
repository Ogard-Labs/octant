import { describe, expect, it } from "vitest";
import { decodeLinearIssueContextRequest } from "./linearIssueContext";

describe("Linear issue context request", () => {
  it("accepts only an opaque Linear node id", () => {
    expect(
      decodeLinearIssueContextRequest({ id: "11111111-1111-4111-8111-111111111111" }),
    ).toEqual({ id: "11111111-1111-4111-8111-111111111111" });
  });

  it("rejects assembled issue text fields a renderer must not send", () => {
    expect(() =>
      decodeLinearIssueContextRequest({
        id: "11111111-1111-4111-8111-111111111111",
        title: "assembled",
      }),
    ).toThrow();
    expect(() =>
      decodeLinearIssueContextRequest({
        id: "11111111-1111-4111-8111-111111111111",
        description: "assembled",
      }),
    ).toThrow();
    expect(() =>
      decodeLinearIssueContextRequest({
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "ENG-12",
      }),
    ).toThrow();
  });

  it("rejects empty or malformed node ids", () => {
    expect(() => decodeLinearIssueContextRequest({ id: "" })).toThrow();
    expect(() => decodeLinearIssueContextRequest({ id: "bad id" })).toThrow();
    expect(() => decodeLinearIssueContextRequest({})).toThrow();
  });
});
