import { describe, expect, it } from "vitest";
import { createIntegrationHostPort } from "./integrationHostPort";
import { constructIntegrationRuntime } from "./integrationLoader";
import { IntegrationCredentialOperations } from "./integrationCredentialOperations";
import { createLinearIntegration } from "../plugins/linear/linearIntegration";

const operation = {
  id: "example-account-check",
  label: "Example token",
  reason: "Check access",
  consumer: "Example",
  actionLabel: "Check access",
  request: { url: "https://api.example.com/check", body: "{}", authorization: "bearer" as const },
  accepted: () => true,
};
describe("integration credential contributions", () => {
  it("admits a third-party operation through the same host port and withdraws it on close", async () => {
    const operations = new IntegrationCredentialOperations();
    const port = createIntegrationHostPort({
      registerCredentialOperation: (value) => operations.register(value),
    });
    const result = constructIntegrationRuntime((host: typeof port) => {
      const registered = host.registerCredentialOperation?.(operation);
      return {
        observe: async () => ({
          kind: "authentication",
          snapshot: { state: "unauthorized", capabilities: [] },
        }),
        execute: async () => ({
          kind: "authentication",
          snapshot: { state: "unauthorized", capabilities: [] },
        }),
        close: async () => {
          if (registered?.kind === "registered") registered.release();
        },
      };
    }, port);
    expect(result.kind).toBe("loaded");
    expect(operations.list().map((value) => value.id)).toEqual([operation.id]);
    expect(operations.register(operation)).toEqual({ kind: "refused" });
    if (result.kind === "loaded") await result.runtime.close();
    expect(operations.list()).toEqual([]);
  });
  it("lets the bundled integration register and release its own operation", async () => {
    const operations = new IntegrationCredentialOperations();
    const runtime = createLinearIntegration(
      createIntegrationHostPort({
        registerCredentialOperation: (value) => operations.register(value),
      }),
      { redirectUri: "http://127.0.0.1/callback" },
    );
    expect(operations.list().map((value) => value.id)).toEqual(["linear-account-check"]);
    await runtime.close();
    expect(operations.list()).toEqual([]);
  });
  it("refuses unsupported methods and GET bodies from a runtime plugin", () => {
    const operations = new IntegrationCredentialOperations();
    for (const method of ["DELETE", "PATCH", "GET"]) {
      const candidate = { ...operation, request: { ...operation.request } };
      Reflect.set(candidate.request, "method", method);
      expect(operations.register(candidate)).toEqual({ kind: "refused" });
    }
    expect(operations.list()).toEqual([]);
  });
  it("refuses an unsafe destination and snapshots a registered request", () => {
    const operations = new IntegrationCredentialOperations();
    expect(
      operations.register({
        ...operation,
        request: { ...operation.request, url: "http://example.com" },
      }),
    ).toEqual({ kind: "refused" });
    operations.register(operation);
    expect(operations.list()[0]).not.toBe(operation);
    expect(Object.isFrozen(operations.list()[0]?.request)).toBe(true);
  });
});
