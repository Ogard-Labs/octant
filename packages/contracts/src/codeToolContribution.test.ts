import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CodeToolContribution, decodeOctantCodeToolsNamespace } from "./codeToolContribution";

const contribution = {
  id: "check",
  label: "Check account",
  description: "Request an approved account status read.",
  operationIds: ["linear-account-check"],
  savedCommandIds: [],
};
const decode = Schema.decodeUnknownResult(CodeToolContribution, { onExcessProperty: "error" });

describe("declarative Code tool contracts", () => {
  it("accepts only existing-operation and saved-binding selectors", () => {
    expect(decode(contribution)._tag).toBe("Success");
    expect(
      decode({
        ...contribution,
        operationIds: [],
        savedCommandIds: ["94000000-0000-4000-8000-000000000001"],
      })._tag,
    ).toBe("Success");
  });
  it.each(["name", "url", "command", "environment", "credentialRef", "accepted"])(
    "refuses an author-supplied %s outside the bounded selectors",
    (field) => {
      expect(decode({ ...contribution, [field]: "not-a-capability" })._tag).toBe("Failure");
    },
  );
  it("refuses empty, repeated, excessive or invalid selectors and colliding declarations", () => {
    expect(decode({ ...contribution, operationIds: [] })._tag).toBe("Failure");
    expect(decode({ ...contribution, operationIds: ["check", "check"] })._tag).toBe("Failure");
    expect(
      decode({
        ...contribution,
        operationIds: Array.from({ length: 17 }, (_, value) => `check-${value}`),
      })._tag,
    ).toBe("Failure");
    expect(decode({ ...contribution, savedCommandIds: ["arbitrary-command"] })._tag).toBe(
      "Failure",
    );
    expect(decodeOctantCodeToolsNamespace({ codeTools: [contribution, contribution] })._tag).toBe(
      "Failure",
    );
  });
});
