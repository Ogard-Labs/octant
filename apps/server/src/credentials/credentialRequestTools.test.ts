import { decodeCodeThread, type CodeThread } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { CredentialRequests } from "./credentialRequests";
import { createCredentialRequestTools } from "./credentialRequestTools";
import { linearCredentialOperation } from "../plugins/linear/linearCredentialOperation";
const now = "2026-11-03T12:00:00.000Z";
function codeThread(overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "40000000-0000-4000-8000-000000000001",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Language reads",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/language",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe("credential tool authority", () => {
  it("opens the private request and cancels it when the turn closes", async () => {
    const service = new CredentialRequests();
    const thread = codeThread();
    const tools = createCredentialRequestTools({
      service,
      windowId: "window",
      thread,
      readThread: () => thread,
      effective: () => true,
      windowCurrent: () => true,
      operation: linearCredentialOperation,
    });
    expect(tools.definitions.map((d) => d.name)).toEqual(["request_credential"]);
    const pending = tools.execute({
      name: "request_credential",
      inputJson: '{"operation":"linear-account-check"}',
    });
    expect(service.view("window", String(thread.id)).requests).toHaveLength(1);
    await tools.close?.();
    expect(await pending).toMatchObject({ result: { status: "cancelled" } });
    service.close();
  });
  it.each(["plan", "disabled", "window", "rebound", "profile"] as const)(
    "refuses the %s boundary",
    async (boundary) => {
      const service = new CredentialRequests();
      const thread = codeThread();
      const current =
        boundary === "plan"
          ? codeThread({ executionPolicy: "plan" })
          : boundary === "profile"
            ? codeThread({ toolConstraints: ["other-tool"] })
            : boundary === "rebound"
              ? codeThread({ bindingRevisionId: "70000000-0000-4000-8000-000000000002" })
              : thread;
      const tools = createCredentialRequestTools({
        service,
        windowId: "window",
        thread,
        readThread: () => current,
        effective: () => boundary !== "disabled",
        windowCurrent: () => boundary !== "window",
        operation: linearCredentialOperation,
      });
      expect(tools.definitions).toEqual([]);
      expect(
        await tools.execute({
          name: "request_credential",
          inputJson: '{"operation":"linear-account-check"}',
        }),
      ).toMatchObject({ result: { status: "refused" } });
      expect(service.view("window", String(thread.id)).requests).toEqual([]);
      service.close();
    },
  );
});
