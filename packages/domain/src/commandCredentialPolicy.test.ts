import { describe, it, expect } from "vitest";
import { decodeCommandCredentialDefinition } from "@octant/contracts/command-credentials";
import { commandCredentialDefinitionAllowed } from "./commandCredentialPolicy";
const definition = decodeCommandCredentialDefinition({
  label: "Read account",
  projectId: "00000000-0000-4000-8000-000000000001",
  executable: "/usr/local/bin/fixture-client",
  args: ["account", "status"],
  directory: "",
  accountId: "a".repeat(26),
  environment: [
    { name: "API_TOKEN", vaultId: "v".repeat(26), itemId: "i".repeat(26), fieldId: "credential" },
  ],
  timeoutMs: 1000,
});
describe("named credential command policy", () => {
  it("permits a fixed recipient with explicit immutable references", () =>
    expect(commandCredentialDefinitionAllowed(definition)).toBe(true));
  it.each([
    "OP_SESSION",
    "OP_RUN_NO_MASKING",
    "PATH",
    "HOME",
    "NODE_OPTIONS",
    "NODE_PATH",
    "BUN_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ASAR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "OCTANT_WINDOW_CAPABILITY",
    "LD_PRELOAD",
    "SSH_AUTH_SOCK",
  ])("refuses the authority-bearing environment variable %s", (name) =>
    expect(
      commandCredentialDefinitionAllowed({
        ...definition,
        environment: [
          { name, vaultId: "v".repeat(26), itemId: "i".repeat(26), fieldId: "credential" },
        ],
      }),
    ).toBe(false),
  );
  it("refuses shells, interpreter evaluation and a directory outside the Project", () => {
    for (const change of [
      { executable: "/bin/sh" },
      { args: ["-c", "echo bad"] },
      { directory: "../elsewhere" },
      { directory: "/tmp" },
    ])
      expect(commandCredentialDefinitionAllowed({ ...definition, ...change })).toBe(false);
  });
  it("refuses duplicate environment names instead of letting precedence choose a credential", () =>
    expect(
      commandCredentialDefinitionAllowed({
        ...definition,
        environment: [...definition.environment, ...definition.environment],
      }),
    ).toBe(false));
});
