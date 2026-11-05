import { describe, it, expect } from "vitest";
import {
  decodeCommandCredentialDefinition,
  decodeCommandCredentialCommand,
  decodeCommandCredentialHostRequest,
} from "./commandCredentials";
const id = "00000000-0000-4000-8000-000000000001";
const definition = {
  label: "Fixed client",
  projectId: id,
  executable: "/usr/bin/client",
  args: ["status"],
  directory: "",
  accountId: "a".repeat(26),
  environment: [
    { name: "API_TOKEN", vaultId: "v".repeat(26), itemId: "i".repeat(26), fieldId: "credential" },
  ],
  timeoutMs: 1000,
};
describe("reference-only command contracts", () => {
  it("accepts immutable reference pins and refuses secret or authority fields", () => {
    expect(decodeCommandCredentialDefinition(definition)).toEqual(definition);
    expect(() =>
      decodeCommandCredentialDefinition({ ...definition, secret: "must-not-enter" }),
    ).toThrow();
    expect(() =>
      decodeCommandCredentialDefinition({
        ...definition,
        environment: [{ ...definition.environment[0], vaultId: "Personal vault" }],
      }),
    ).toThrow();
    expect(() =>
      decodeCommandCredentialCommand({ kind: "approve", requestId: id, projectId: id }),
    ).toThrow();
    expect(() =>
      decodeCommandCredentialHostRequest({
        requestId: id,
        bindingId: id,
        accountId: definition.accountId,
        environment: definition.environment,
        execute: "/bin/sh",
      }),
    ).toThrow();
  });
});
