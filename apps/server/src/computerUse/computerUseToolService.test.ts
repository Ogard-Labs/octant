import { describe, expect, it, vi } from "vitest";
import {
  decodeApprovalOutsideContent,
  decodeDesktopLeaseId,
  decodeDesktopProviderId,
  decodeToolActionAuthority,
} from "@octant/contracts";
import {
  decodeComputerUseOwner,
  decodeComputerControlResult,
  type ComputerControlCommand,
  type ComputerControlResult,
  type ComputerUseOwner,
} from "@octant/contracts/computer-use-plugin";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import type { ComputerUseEvidenceEvent } from "./computerUseRuntime";
import { createComputerUseToolService } from "./computerUseToolService";
import type { DesktopTransferConfirmation } from "./desktopLeaseService";

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

const marking = decodeApprovalOutsideContent({
  sources: [
    { sourceLabel: "web-fetch", ingestionCount: 1, lastIngestedAt: "2026-10-15T09:00:00.000Z" },
  ],
  sourceCount: 1,
});

function fixture(overrides?: {
  readonly enabled?: boolean;
  readonly toolConstraints?: ReadonlyArray<string>;
  /** Whether the host can name the sources that marked the thread. */
  readonly namesSources?: boolean;
}) {
  let current = true;
  let tainted = false;
  const settings = { enabled: overrides?.enabled ?? true, automaticUpdates: true };
  const toolConstraints = overrides?.toolConstraints ?? [];
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
    settings: () => settings,
    authority: () => authority,
    ownerIsCurrent: () => current,
    toolConstraints: () => toolConstraints,
    externalContentIngested: () => tainted,
    outsideContent: () => (tainted && overrides?.namesSources !== false ? marking : undefined),
    threadTitle: () => "Fixture task",
    record: async () => {},
  });
  const tools = service.toolSet(owner, computerUseSelection("test"));
  return {
    service,
    get tools() {
      if (tools === undefined) throw new Error("Expected selected plugin.");
      return tools;
    },
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
  it("offers a one-time approval, not a five-minute grant, once the thread has read external content", async () => {
    const f = fixture();
    try {
      f.taint();
      void f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const pending = f.service.runtime.list(owner.windowId)[0]?.pendingApproval;
      expect(pending?.scope).toBeUndefined();
      expect(pending?.summary).toContain("this one action");
      expect(pending?.summary).not.toContain("5 minutes");
      expect(pending?.outsideContent).toEqual(marking);
      await f.tools.close?.();
    } finally {
      await f.service.close();
    }
  });

  it("names no outside content on a clean thread's approval", async () => {
    const f = fixture();
    try {
      void f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval?.outsideContent).toBe(
        undefined,
      );
      await f.tools.close?.();
    } finally {
      await f.service.close();
    }
  });

  it("still says a thread is marked when the host cannot name what marked it", async () => {
    const f = fixture({ namesSources: false });
    try {
      f.taint();
      void f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval?.outsideContent).toEqual({
        sources: [],
        sourceCount: 0,
      });
      await f.tools.close?.();
    } finally {
      await f.service.close();
    }
  });

  it("keeps the approved app session available to the same task on its next turn", async () => {
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
      expect(f.release).not.toHaveBeenCalled();
      const next = f.service.toolSet(owner, computerUseSelection("next-turn"));
      if (next === undefined) throw new Error("Expected selected plugin.");
      expect(
        await next.execute({
          name: "octant_computer",
          inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
        }),
      ).toMatchObject({ result: { kind: "windows" } });
      expect(f.execute).toHaveBeenCalledTimes(2);
      await next.close?.();
      f.revoke();
      await f.service.sweep();
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

  it("returns the explicit reason when the person denies a computer-use action", async () => {
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
        decision: "denied",
      });

      expect(await result).toMatchObject({
        isError: true,
        result: {
          kind: "refused",
          reason: "not-approved",
          message: "User denied the proposed action.",
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

describe("a turn without a Computer selection", () => {
  it("registers the tool name so a stale call returns the re-attach recovery", async () => {
    const f = fixture();
    try {
      const unattached = f.service.unattachedToolSet(owner);
      if (unattached === undefined) throw new Error("Expected a refusal definition.");
      expect(unattached.definitions.map((definition) => definition.name)).toEqual([
        "octant_computer",
      ]);
      const answer = await unattached.execute({ name: "octant_computer", inputJson: "{}" });
      expect(answer.isError).toBe(true);
      expect(answer.result).toMatchObject({ error: "computer-use-not-attached" });
      expect(JSON.stringify(answer.result)).toContain("@Computer");
      // Help belongs to the attached family; without @Computer it is refused too.
      const help = await unattached.execute({
        name: "octant_computer",
        inputJson: '{"operation":"help"}',
      });
      expect(help.result).toMatchObject({ error: "computer-use-not-attached" });
    } finally {
      await f.service.close();
    }
  });

  it("ships no definition while Computer use is disabled, since nothing could reattach it", async () => {
    const f = fixture({ enabled: false });
    try {
      expect(f.service.unattachedToolSet(owner)).toBeUndefined();
    } finally {
      await f.service.close();
    }
  });

  it("ships no definition when the thread's tool constraints exclude it", async () => {
    const f = fixture({ toolConstraints: ["octant_terminal"] });
    try {
      expect(f.service.unattachedToolSet(owner)).toBeUndefined();
    } finally {
      await f.service.close();
    }
  });

  it("ships no definition in Plan mode, since a re-attached call would still be refused", async () => {
    const f = fixture();
    try {
      expect(
        f.service.unattachedToolSet(decodeComputerUseOwner({ ...owner, executionPolicy: "plan" })),
      ).toBeUndefined();
    } finally {
      await f.service.close();
    }
  });
});

describe("Computer use bound to one of the thread's disposable desktops", () => {
  const leaseId = decodeDesktopLeaseId("55555555-5555-4555-8555-555555555555");
  const onDesktop = decodeComputerUseOwner({ ...owner, mode: "code", leaseId });
  const codeAuthority = decodeToolActionAuthority({
    hostId: "44444444-4444-4444-8444-444444444444",
    mode: "code",
    projectId: "66666666-6666-4666-8666-666666666666",
    providerInstanceId: owner.providerInstanceId,
    extension: { kind: "core" },
  });
  const sent = decodeComputerControlResult({
    kind: "sent",
    name: "notes-app",
    size: 9,
    sha256: "a".repeat(64),
  });

  function desktop(
    options: {
      readonly bindable?: boolean;
      readonly withMac?: boolean;
      readonly answers?: Array<"approved" | "denied">;
    } = {},
  ) {
    let tainted = false;
    const control = vi.fn(async (_owner: ComputerUseOwner, command: ComputerControlCommand) =>
      decodeComputerControlResult(
        command.operation === "apps"
          ? { kind: "apps", apps: [{ appId: "notes-app", name: "notes-app" }] }
          : {
              kind: "windows",
              appId: "appId" in command ? command.appId : "notes-app",
              windows: [{ windowId: 1, title: "notes-app on the disposable desktop" }],
            },
      ),
    );
    const transfers: Array<string> = [];
    const sendFile = vi.fn(
      async (
        _owner: ComputerUseOwner,
        path: string,
        confirm: (request: DesktopTransferConfirmation) => Promise<"approved" | "declined">,
        _externalContentIngested: boolean,
      ): Promise<ComputerControlResult> => {
        transfers.push(path);
        const answer = await confirm({
          owner: { mode: "code", threadId: onDesktop.threadId },
          leaseId,
          provider: {
            providerId: decodeDesktopProviderId("host-local"),
            displayName: "This host",
            locality: "host-local",
            billed: false,
          },
          asks: "in-thread",
          artifact: { path, name: "notes-app", size: 9, sha256: "a".repeat(64) },
        });
        return answer === "approved"
          ? sent
          : { kind: "refused", reason: "declined", message: "Declined." };
      },
    );
    const answers = [...(options.answers ?? [])];
    const asked: Array<string> = [];
    const ask = vi.fn(async (summary: string) => {
      asked.push(summary);
      return answers.shift() ?? "approved";
    });
    const recorded: Array<ComputerUseEvidenceEvent> = [];
    const macExecute = vi.fn(async () => decodeComputerControlResult({ kind: "apps", apps: [] }));
    const service = createComputerUseToolService({
      ...(options.withMac === true
        ? {
            desktop: {
              status: async () => {
                throw new Error("not read");
              },
              configure: async () => {},
              reserve: async () => true,
              execute: macExecute,
              release: async () => {},
            },
          }
        : {}),
      leases: { bindable: () => options.bindable ?? true, control, sendFile },
      destination: () => ({
        status: "leasable",
        kind: "disposable-desktop",
        leasable: [
          {
            providerId: decodeDesktopProviderId("host-local"),
            displayName: "This host",
            locality: "host-local",
            billed: false,
          },
        ],
      }),
      settings: () => ({ enabled: true, automaticUpdates: true }),
      authority: () => codeAuthority,
      ownerIsCurrent: () => true,
      toolConstraints: () => [],
      externalContentIngested: () => tainted,
      threadTitle: () => "Notes app",
      record: (event) => {
        recorded.push(event);
      },
    });
    return {
      service,
      control,
      sendFile,
      transfers,
      ask,
      asked,
      recorded,
      macExecute,
      taint: () => {
        tainted = true;
      },
      tools(target: ComputerUseOwner = onDesktop, imagesSupported = true) {
        const tools = service.toolSet(
          target,
          computerUseSelection("desktop"),
          imagesSupported,
          ask,
        );
        if (tools === undefined) throw new Error("Expected the desktop to bind.");
        return tools;
      },
    };
  }

  const call = (operation: Record<string, unknown>) => ({
    name: "octant_computer",
    inputJson: JSON.stringify(operation),
  });

  it("binds only a running lease of the thread, and only with a way to ask in the thread", async () => {
    const bound = desktop();
    const unbindable = desktop({ bindable: false });
    try {
      const tools = bound.tools();
      expect(tools.definitions[0]?.description).toContain("disposable Linux desktop");
      expect(JSON.stringify(tools.definitions[0]?.inputSchema)).toContain("send-file");
      expect(
        unbindable.service.toolSet(onDesktop, computerUseSelection("desktop"), true, bound.ask),
      ).toBeUndefined();
      expect(bound.service.toolSet(onDesktop, computerUseSelection("desktop"))).toBeUndefined();
      // A host with no screen of its own binds no Mac, offers no re-attach
      // recovery for one, and still reports itself leasable rather than a screen.
      expect(bound.service.runtime.destination()).toMatchObject({ status: "leasable" });
      expect(bound.service.toolSet(owner, computerUseSelection("mac"))).toBeUndefined();
      expect(bound.service.unattachedToolSet(owner)).toBeUndefined();
    } finally {
      await bound.service.close();
      await unbindable.service.close();
    }
  });

  it("asks for each app in the thread and acts as the agent only once the person approves", async () => {
    const f = desktop({ answers: ["approved", "denied"] });
    try {
      const tools = f.tools();
      await expect(
        tools.execute(call({ operation: "launch", appId: "notes-app" })),
      ).resolves.toEqual({
        result: {
          kind: "windows",
          appId: "notes-app",
          windows: [{ windowId: 1, title: "notes-app on the disposable desktop" }],
        },
        isError: false,
      });
      expect(f.asked).toEqual([
        `Allow control of notes-app on this thread's disposable desktop for "Notes app" for 5 minutes.`,
      ]);
      expect(f.control).toHaveBeenCalledOnce();
      expect(f.control.mock.calls[0]?.[0]).toMatchObject({ leaseId });
      // The five-minute grant covers the same app; another app asks again.
      await tools.execute(call({ operation: "windows", appId: "notes-app" }));
      expect(f.asked).toHaveLength(1);
      await expect(
        tools.execute(call({ operation: "launch", appId: "other-app" })),
      ).resolves.toMatchObject({
        isError: true,
        result: { kind: "refused", reason: "not-approved" },
      });
      expect(f.asked).toHaveLength(2);
      expect(f.control).toHaveBeenCalledTimes(2);
      expect(new Set(f.recorded.map((event) => event.requestedBy.kind))).toEqual(
        new Set(["agent"]),
      );
      expect(f.macExecute).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });

  it("lets the first answer decide, withdraws the other question, and never carries a late answer to the next action", async () => {
    const f = desktop();
    const questions: Array<{
      readonly signal: AbortSignal | undefined;
      readonly answer: (value: "approved" | "denied") => void;
    }> = [];
    const ask = vi.fn(
      (_summary: string, signal?: AbortSignal) =>
        new Promise<"approved" | "denied" | "cancelled" | "expired">((resolve) => {
          questions.push({ signal, answer: resolve });
        }),
    );
    try {
      const tools = f.service.toolSet(onDesktop, computerUseSelection("desktop"), true, ask);
      if (tools === undefined) throw new Error("Expected the desktop to bind.");
      const launched = tools.execute(call({ operation: "launch", appId: "notes-app" }));
      await vi.waitFor(() => expect(questions).toHaveLength(1));
      const view = f.service.runtime.list(onDesktop.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");
      // The local card answers first.
      await f.service.runtime.decide({
        ownerWindowId: onDesktop.windowId,
        threadId: onDesktop.threadId,
        authority: codeAuthority,
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
      });
      await expect(launched).resolves.toMatchObject({ isError: false });
      expect(questions[0]?.signal?.aborted).toBe(true);

      // The withdrawn thread question answering late reaches nothing, and the
      // next app still asks for itself.
      questions[0]?.answer("approved");
      const other = tools.execute(call({ operation: "launch", appId: "other-app" }));
      await vi.waitFor(() => expect(questions).toHaveLength(2));
      questions[1]?.answer("denied");
      await expect(other).resolves.toMatchObject({
        isError: true,
        result: { kind: "refused", reason: "not-approved" },
      });
      expect(f.control).toHaveBeenCalledOnce();
    } finally {
      await f.service.close();
    }
  });

  it("asks again for every action once the thread has read outside content", async () => {
    const f = desktop();
    try {
      const tools = f.tools();
      f.taint();
      await tools.execute(call({ operation: "launch", appId: "notes-app" }));
      await tools.execute(call({ operation: "windows", appId: "notes-app" }));
      expect(f.asked).toEqual([
        `Allow this one action in notes-app on this thread's disposable desktop for "Notes app".`,
        `Allow this one action in notes-app on this thread's disposable desktop for "Notes app".`,
      ]);
      // The lease service asks for the file even under Full access once tainted.
      await tools.execute(call({ operation: "send-file", path: "dist/notes-app" }));
      expect(f.sendFile.mock.calls[0]?.[3]).toBe(true);
    } finally {
      await f.service.close();
    }
  });

  it("refuses every command and every file in Plan without asking or reaching the desktop", async () => {
    const f = desktop();
    try {
      const tools = f.tools(decodeComputerUseOwner({ ...onDesktop, executionPolicy: "plan" }));
      for (const operation of [
        { operation: "launch", appId: "notes-app" },
        { operation: "send-file", path: "dist/notes-app" },
      ]) {
        await expect(tools.execute(call(operation))).resolves.toMatchObject({
          isError: true,
          result: { kind: "refused", reason: "unavailable" },
        });
      }
      expect(f.ask).not.toHaveBeenCalled();
      expect(f.control).not.toHaveBeenCalled();
      expect(f.sendFile).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });

  it("refuses a model that cannot see screenshots with needs-image-model", async () => {
    const f = desktop();
    try {
      const tools = f.tools(onDesktop, false);
      for (const operation of [
        { operation: "apps" },
        { operation: "launch", appId: "notes-app" },
        { operation: "send-file", path: "dist/notes-app" },
      ]) {
        await expect(tools.execute(call(operation))).resolves.toMatchObject({
          isError: true,
          result: { kind: "refused", reason: "needs-image-model" },
        });
      }
      await expect(tools.execute(call({ operation: "stop" }))).resolves.toMatchObject({
        result: { kind: "stopped" },
      });
      expect(f.control).not.toHaveBeenCalled();
      expect(f.sendFile).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });

  it("sends a file only after the thread is asked with its path, size, hash, and destination", async () => {
    const f = desktop({ answers: ["denied", "approved"] });
    try {
      const tools = f.tools();
      const send = call({ operation: "send-file", path: "dist/notes-app" });
      await expect(tools.execute(send)).resolves.toMatchObject({
        isError: true,
        result: { kind: "refused", reason: "declined" },
      });
      await expect(tools.execute(send)).resolves.toEqual({ result: sent, isError: false });
      expect(f.transfers).toEqual(["dist/notes-app", "dist/notes-app"]);
      expect(f.asked[0]).toBe(
        `Send dist/notes-app (9 bytes, SHA-256 ${"a".repeat(64)}) into this thread's disposable desktop on This host for "Notes app"?`,
      );
    } finally {
      await f.service.close();
    }
  });

  it("keeps keyboard-focus typing to the desktop and refuses it on this Mac", async () => {
    const f = desktop({ withMac: true });
    try {
      const mac = f.service.toolSet(owner, computerUseSelection("mac"));
      if (mac === undefined) throw new Error("Expected this Mac to bind.");
      await expect(
        mac.execute(
          call({
            operation: "type",
            observationId: "77777777-7777-4777-8777-777777777777",
            text: "x",
          }),
        ),
      ).resolves.toMatchObject({
        isError: true,
        result: { kind: "refused", reason: "unsupported" },
      });
      expect(f.macExecute).not.toHaveBeenCalled();
      expect(f.ask).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });
});
