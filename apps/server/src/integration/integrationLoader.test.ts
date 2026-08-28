import { describe, expect, it, vi } from "vitest";
import { createIntegrationHostPort } from "./integrationHostPort";
import { constructIntegrationRuntime, loadIntegrationModule } from "./integrationLoader";

const fakeModulePath = new URL("./__fixtures__/fakeIntegration.ts", import.meta.url).href;
const missingModulePath = new URL("./__fixtures__/missingIntegration.ts", import.meta.url).href;

describe("integration loader", () => {
  it("loads a module with a default factory", async () => {
    const hostPort = createIntegrationHostPort();
    const result = await loadIntegrationModule(fakeModulePath, hostPort);
    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.runtime.observe).toBeDefined();
    expect(result.runtime.execute).toBeDefined();
    expect(result.runtime.close).toBeDefined();
  });

  it("returns a failure for a missing module", async () => {
    const hostPort = createIntegrationHostPort();
    const result = await loadIntegrationModule(missingModulePath, hostPort);
    expect(result).toEqual({
      kind: "failed",
      code: "module-missing",
      message: expect.stringContaining("Cannot find module"),
    });
  });

  it("passes the injected host port to the factory", async () => {
    const injectedFetch = vi.fn<typeof globalThis.fetch>();
    const hostPort = createIntegrationHostPort({ fetch: injectedFetch });
    const result = await loadIntegrationModule(fakeModulePath, hostPort);
    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(hostPort.fetch).toBe(injectedFetch);
  });

  it("returns a failure when the factory export is not callable", async () => {
    const hostPort = createIntegrationHostPort();
    const result = await loadIntegrationModule("data:text/javascript,export default 42", hostPort);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.code).toBe("factory-not-callable");
  });

  it("constructs a runtime from a statically imported factory", async () => {
    const hostPort = createIntegrationHostPort();
    const result = constructIntegrationRuntime(
      () => ({
        observe: async () => ({
          kind: "authentication" as const,
          snapshot: { state: "unauthorized" as const, capabilities: [] },
        }),
        execute: async () => ({
          kind: "authentication" as const,
          snapshot: { state: "unauthorized" as const, capabilities: [] },
        }),
        close: async () => {},
      }),
      hostPort,
      "inline",
    );
    expect(result.kind).toBe("loaded");
  });

  it("returns a failure when the factory throws", async () => {
    const hostPort = createIntegrationHostPort();
    const result = await loadIntegrationModule(
      "data:text/javascript,export default function createRuntime() { throw new Error('boom'); }",
      hostPort,
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.code).toBe("runtime-factory-threw");
    expect(result.message).toContain("boom");
  });
});
