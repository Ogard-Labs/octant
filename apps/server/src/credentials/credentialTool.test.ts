import { describe, expect, it, vi } from "vitest";
import type { ThreadSecretOperations } from "../threadSecrets/threadSecretTools";
import { createCredentialTool, type CredentialToolSource } from "./credentialTool";

const registered: CredentialToolSource<{
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}> = {
  offered: true,
  list: () => [{ id: "check", label: "Check", reason: "Check the account." }],
  use: async () => ({ result: { status: "used" }, isError: false }),
  close: async () => undefined,
};
const secrets = () =>
  ({
    requestSecret: vi.fn(async () => ({ result: { status: "declined" }, isError: true })),
    runWithSecret: vi.fn(async () => ({ result: { status: "ran" }, isError: false })),
    close: vi.fn(),
  }) satisfies ThreadSecretOperations;
const call = (input: unknown) => ({
  name: "octant_credential",
  inputJson: typeof input === "string" ? input : JSON.stringify(input),
});

describe("the credential tool with thread secrets", () => {
  it("is offered for secrets alone", async () => {
    const own = secrets();
    const set = createCredentialTool({ secrets: own });
    expect(set.definitions.map(({ name }) => name)).toEqual(["octant_credential"]);
    expect(set.definitions[0]?.description).toContain("Never ask for a secret in chat");
    expect(await set.execute(call({ operation: "list" }))).toEqual({
      result: { operations: [], savedCommands: [] },
      isError: false,
    });
    for (const operation of ["request", "run-saved"])
      expect(await set.execute(call({ operation, id: "check" }))).toMatchObject({ isError: true });
  });

  it("keeps every other operation beside them", async () => {
    const set = createCredentialTool({ registered, secrets: secrets() });
    // A session that keeps its tools would take a changed one for a new tool.
    expect(set.definitions).toEqual(createCredentialTool({ secrets: secrets() }).definitions);
    expect(await set.execute(call({ operation: "request", id: "check" }))).toEqual({
      result: { status: "used" },
      isError: false,
    });
    expect(await set.execute(call({ operation: "list" }))).toMatchObject({
      result: { operations: [{ id: "check" }] },
    });
  });

  it("hands each operation its own input and the call's signal", async () => {
    const own = secrets();
    const set = createCredentialTool({ secrets: own });
    const { signal } = new AbortController();
    const request = { operation: "request-secret", name: "TOKEN" };
    await set.execute({ ...call(request), signal });
    expect(own.requestSecret).toHaveBeenCalledWith(request, signal);
    const run = { operation: "run-with-secret", command: "x".repeat(1_400), secrets: ["TOKEN"] };
    await set.execute({ ...call(run), signal });
    expect(own.runWithSecret).toHaveBeenCalledWith(run, signal);
  });

  it("refuses input too long to be a request, and text that is not one", async () => {
    const own = secrets();
    const set = createCredentialTool({ secrets: own });
    for (const input of [
      { operation: "request-secret", reason: "x".repeat(20_000) },
      "{",
      "null",
      '"request-secret"',
    ])
      expect(await set.execute(call(input))).toMatchObject({ isError: true });
    expect(own.requestSecret).not.toHaveBeenCalled();
  });

  it("explains them in its help and ends them when it closes", async () => {
    const own = secrets();
    const set = createCredentialTool({ registered, secrets: own });
    expect(await set.execute(call({ operation: "help" }))).toMatchObject({
      result: { help: expect.stringContaining("run-with-secret") },
    });
    await set.close?.();
    expect(own.close).toHaveBeenCalledOnce();
  });

  it("does not mention them to a caller without them", async () => {
    const set = createCredentialTool({ registered });
    expect(JSON.stringify(set.definitions)).not.toMatch(/request-secret|run-with-secret/);
    expect(await set.execute(call({ operation: "request-secret" }))).toMatchObject({
      isError: true,
    });
    expect(createCredentialTool({}).definitions).toEqual([]);
  });
});
