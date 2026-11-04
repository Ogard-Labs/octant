import { describe, expect, it, vi } from "vitest";
import {
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import type { ProviderCloudSessionServiceInput } from "../cloud/providerCloudSessionService";
import { wireProviderCloudSessions } from "./providerCloudSessions";
import { WindowAuthorityStore } from "../windowAuthorityStore";

const captured = vi.hoisted(() => ({
  input: undefined as ProviderCloudSessionServiceInput | undefined,
}));
vi.mock("../cloud/providerCloudSessionService", () => ({
  ProviderCloudSessionService: class {
    constructor(input: ProviderCloudSessionServiceInput) {
      captured.input = input;
    }
  },
}));
vi.mock("../cloud/providerCloudSessionStore", () => ({ ProviderCloudSessionStore: class {} }));

describe("cloud job thread authority", () => {
  it("keeps owned receipts and cancellation reachable after Plan while withholding new execution", () => {
    const windowId = decodeWindowId("a7550000-0000-4000-8000-000000000001");
    const threadId = decodeCodeThreadId("a7550000-0000-4000-8000-000000000002");
    const projectId = decodeProjectId("a7550000-0000-4000-8000-000000000003");
    const windows = new WindowAuthorityStore();
    windows.register({
      windowId,
      capability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
      now: Date.now(),
    });
    let executionPolicy: ProviderExecutionPolicy = "full-access";
    const thread = {
      id: threadId,
      projectId,
      lifecycle: "active",
      bindingRevisionId: "fixture-binding",
      checkoutId: "fixture-checkout",
    };
    wireProviderCloudSessions({
      persistence: { readCodeThread: () => thread, readProviderInstances: () => [] } as never,
      codeProjectAccess: {
        standingAuthority: (read: () => boolean) => read(),
        canAccessProject: () => true,
      } as never,
      codeSessionAuthority: { effectiveThread: () => ({ ...thread, executionPolicy }) } as never,
      windowAuthorityStore: windows,
      spendCeilingService: {} as never,
      credentialResolver: undefined,
      configuredDriverOptions: {} as never,
    });
    const context = captured.input?.context(windowId, threadId);
    expect(context?.current()).toBe(true);
    expect(context?.canSubmit()).toBe(true);
    executionPolicy = "plan";
    expect(context?.current()).toBe(true);
    expect(context?.canSubmit()).toBe(false);
    expect(captured.input?.context(windowId, threadId)?.executionPolicy).toBe("plan");
  });
});
