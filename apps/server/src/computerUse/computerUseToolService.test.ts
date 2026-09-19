import { describe, expect, it, vi } from "vitest";
import { decodeToolActionAuthority } from "@octant/contracts";
import {
  decodeComputerUseOwner,
  decodeComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import { createComputerUseToolService } from "./computerUseToolService";

const owner = decodeComputerUseOwner({
  windowId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  mode: "chat",
  providerInstanceId: "33333333-3333-4333-8333-333333333333",
  modelId: "fixture",
  executionPolicy: "approval-gated",
});
const authority = decodeToolActionAuthority({
  hostId: "44444444-4444-4444-8444-444444444444",
  mode: "chat",
  providerInstanceId: owner.providerInstanceId,
  extension: { kind: "core" },
});

function fixture() {
  let current = true;
  let tainted = false;
  const execute = vi.fn(async () =>
    decodeComputerControlResult({
      kind: "windows",
      appId: "com.example.Fixture",
      windows: [{ windowId: 9, title: "Fixture" }],
    }),
  );
  const release = vi.fn(async () => {});
  const service = createComputerUseToolService({
    desktop: {
      status: async () => ({
        supported: true,
        enabled: true,
        automaticUpdates: true,
        permissions: { accessibility: true, screenRecording: true },
        driver: "ready",
        activeSessions: 0,
        update: "current",
      }),
      configure: async () => {},
      reserve: async () => true,
      execute,
      release,
    },
    settings: () => ({ enabled: true, automaticUpdates: true }),
    authority: () => authority,
    ownerIsCurrent: () => current,
    toolConstraints: () => [],
    externalContentIngested: () => tainted,
    threadTitle: () => "Fixture task",
    record: async () => {},
  });
  const tools = service.toolSet(owner, computerUseSelection("test"));
  if (tools === undefined) throw new Error("Expected selected plugin.");
  return {
    service,
    tools,
    execute,
    release,
    revoke: () => {
      current = false;
    },
    taint: () => {
      tainted = true;
    },
  };
}

describe("Computer use through a provider tool", () => {
  it("expires an app grant from approval time even when the first action is slow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const approvedAt = Date.now();
    const f = fixture();
    const command = {
      name: "octant_computer",
      inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
    };
    try {
      const first = f.tools.execute(command);
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");
      f.execute.mockImplementationOnce(async () => {
        vi.setSystemTime(approvedAt + 120_000);
        return decodeComputerControlResult({
          kind: "windows",
          appId: "com.example.Fixture",
          windows: [],
        });
      });
      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });
      await first;
      vi.setSystemTime(approvedAt + 301_000);
      const second = f.tools.execute(command);
      try {
        await vi.waitFor(() =>
          expect(
            f.service.runtime
              .list(owner.windowId)
              .some((session) => session.pendingApproval !== undefined),
          ).toBe(true),
        );
        expect(f.execute).toHaveBeenCalledOnce();
      } finally {
        await f.tools.close?.();
        await second;
      }
    } finally {
      await f.service.close();
      vi.useRealTimers();
    }
  });
  it("revokes a pending app approval when the tool session closes", async () => {
    const f = fixture();
    try {
      const result = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");
      await f.tools.close?.();
      await expect(
        f.service.runtime.decide({
          ownerWindowId: owner.windowId,
          threadId: owner.threadId,
          authority,
          sessionId: view.sessionId,
          actionId: view.pendingApproval.actionId,
          approvalId: view.pendingApproval.approvalId,
          decision: "approved",
        }),
      ).rejects.toThrow("Computer-use approval is stale");
      expect(await result).toMatchObject({ isError: true });
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });
  it("waits for the named app grant before control and releases it when the turn ends", async () => {
    const f = fixture();
    try {
      const result = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");
      expect(view.pendingApproval.summary).toContain("Fixture task");
      expect(view.pendingApproval.scope).toBe("application-session");
      expect(f.execute).not.toHaveBeenCalled();
      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });
      expect(await result).toMatchObject({ result: { kind: "windows" } });
      expect(f.execute).toHaveBeenCalledOnce();
      await f.tools.close?.();
      expect(f.release).toHaveBeenCalledOnce();
      expect(
        await f.tools.execute({ name: "octant_computer", inputJson: '{"operation":"apps"}' }),
      ).toMatchObject({ isError: true });
    } finally {
      await f.service.close();
    }
  });

  it("refuses a late approval after the task authority changes", async () => {
    const f = fixture();
    try {
      const result = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");
      f.revoke();
      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });
      expect(await result).toMatchObject({ isError: true });
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });

  it("completes an approved control call and grants the app for the window", async () => {
    const f = fixture();
    try {
      const result = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");

      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });

      expect(await result).toMatchObject({ result: { kind: "windows" } });
    } finally {
      await f.service.close();
    }
  });

  it("completes an approved control call after the thread ingested the tool's own listing", async () => {
    // Observed 2026-09-19: the application listing is journaled as ingested
    // external content, and the very next approved action was refused as
    // "owner-changed" although nothing about the owner had changed.
    const f = fixture();
    try {
      f.taint();
      const result = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");

      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });

      expect(await result).toMatchObject({ result: { kind: "windows" } });
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.close();
    }
  });

  it("asks again under taint instead of honouring the five-minute app grant", async () => {
    const f = fixture();
    try {
      const first = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");
      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });
      expect(await first).toMatchObject({ result: { kind: "windows" } });

      // The grant now covers the app for five minutes. Once the thread has
      // ingested external content, a standing grant must not carry an
      // irreversible action: the runtime asks again for a fresh confirmation.
      f.taint();
      const second = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(
          f.service.runtime.list(owner.windowId).find((s) => s.pendingApproval !== undefined),
        ).toBeDefined(),
      );
      const again = f.service.runtime
        .list(owner.windowId)
        .find((s) => s.pendingApproval !== undefined);
      if (again?.pendingApproval === undefined) throw new Error("Expected a fresh approval.");
      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: again.sessionId,
        actionId: again.pendingApproval.actionId,
        approvalId: again.pendingApproval.approvalId,
        decision: "approved",
      });
      expect(await second).toMatchObject({ result: { kind: "windows" } });
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.close();
    }
  });

  it("carries the host's refusal reason to the agent instead of a generic denial", async () => {
    const f = fixture();
    f.execute.mockImplementation(async () =>
      decodeComputerControlResult({
        kind: "refused",
        reason: "accessibility-timeout",
        message: "The application did not respond to the accessibility probe.",
      }),
    );
    try {
      const result = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");

      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });

      const outcome = await result;
      expect(outcome).toMatchObject({
        isError: true,
        result: {
          kind: "refused",
          reason: "accessibility-timeout",
          message: "The application did not respond to the accessibility probe.",
        },
      });
    } finally {
      await f.service.close();
    }
  });

  it("names the desktop failure when an approved action crashes instead of reading as a denial", async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      throw new Error("Computer-use desktop connection is unavailable.");
    });
    try {
      const result = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");

      await f.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        authority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });

      const outcome = await result;
      expect(outcome).toMatchObject({ isError: true });
      expect(outcome).toMatchObject({
        result: {
          message:
            "Owned native action or evidence recording failed: Computer-use desktop connection is unavailable.",
        },
      });
    } finally {
      await f.service.close();
    }
  });
});
