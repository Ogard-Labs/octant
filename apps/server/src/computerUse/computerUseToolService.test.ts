import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeApprovalOutsideContent,
  decodeDesktopLeaseId,
  decodeDesktopProviderId,
  decodeEventActor,
  decodeProjectId,
  decodeShellCommand,
  decodeToolActionAuthority,
  type ProjectId,
} from "@octant/contracts";
import { computerUseAppRemembered, defaultShellSettings } from "@octant/domain";
import {
  decodeComputerUseOwner,
  decodeComputerControlResult,
  type ComputerControlCommand,
  type ComputerControlResult,
  type ComputerUseOwner,
} from "@octant/contracts/computer-use-plugin";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { ProcessAuthorityClock } from "../processAuthorityClock";
import {
  readApprovalOutsideContent,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { PersistenceService } from "../persistence/persistenceService";
import { rebuildProjections } from "../persistence/projection";
import { readShellSettings } from "../persistence/shellProjection";
import { ShellService } from "../shellService";
import type { ComputerUseEvidenceEvent } from "./computerUseRuntime";
import { createComputerUseToolService } from "./computerUseToolService";
import type {
  DesktopExtensionConfirmation,
  DesktopTransferConfirmation,
} from "./desktopLeaseService";

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

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openDatabase(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-computer-marks-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-30T12:00:00.000Z");
  return connection;
}

function fixture(overrides?: {
  readonly enabled?: boolean;
  readonly toolConstraints?: ReadonlyArray<string>;
  /** Whether the host can name the sources that marked the thread. */
  readonly namesSources?: boolean;
  /** The owner the turn's tool is offered to; this Mac's approval-gated Chat by default. */
  readonly toolOwner?: ComputerUseOwner;
  /** A host with no screen of its own, whose only destination is a lease. */
  readonly leasableOnly?: boolean;
  /** Whether the owner's thread stands at Full access. */
  readonly fullAccess?: boolean;
  /** Whether Strict is on for the owner's thread; absent reads as Strict. */
  readonly strict?: boolean;
  /** Reads the thread's real outside-content mark in place of the fixture's flag. */
  readonly marks?: {
    readonly ingested: () => boolean;
    readonly outsideContent: () => ReturnType<typeof readApprovalOutsideContent>;
  };
  /** The authority clock approval offers expire on; wall time by default. */
  readonly now?: () => number;
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
      reserve: async () => overrides?.leasableOnly !== true,
      execute,
      release,
    },
    ...(overrides?.leasableOnly === true
      ? {
          destination: () => ({
            status: "leasable" as const,
            kind: "disposable-desktop" as const,
            leasable: [],
          }),
        }
      : {}),
    settings: () => settings,
    authority: () => authority,
    ownerIsCurrent: () => current,
    toolConstraints: () => toolConstraints,
    fullAccess: () => overrides?.fullAccess === true,
    ...(overrides?.strict === undefined ? {} : { strict: () => overrides.strict === true }),
    externalContentIngested: overrides?.marks?.ingested ?? (() => tainted),
    outsideContent:
      overrides?.marks?.outsideContent ??
      (() => (tainted && overrides?.namesSources !== false ? marking : undefined)),
    threadTitle: () => "Fixture task",
    record: async () => {},
    now: overrides?.now ?? (() => Date.now()),
  });
  const tools = service.toolSet(overrides?.toolOwner ?? owner);
  return {
    service,
    get tools() {
      if (tools === undefined) throw new Error("Expected the offered tool.");
      return tools;
    },
    execute,
    release,
    revoke: () => {
      current = false;
    },
    restore: () => {
      current = true;
    },
    taint: () => {
      tainted = true;
    },
  };
}

describe("Computer use through a provider tool", () => {
  it("keeps an app grant for the thread, with no lapse after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const approvedAt = Date.now();
    // The grant has no clock on either time source: neither the wall clock
    // nor the authority clock the service reads may lapse it.
    let elapsedMs = 1_000;
    const clock = new ProcessAuthorityClock({
      wallClock: () => Date.now(),
      suspendAwareElapsedSource: () => elapsedMs,
    });
    const f = fixture({ now: clock.now() });
    const command = {
      name: "octant_computer",
      inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
    };
    try {
      const first = f.tools.execute(command);
      await approvePending(f);
      await first;
      elapsedMs += 6 * 60 * 60_000;
      vi.setSystemTime(approvedAt + 6 * 60 * 60_000);
      await f.service.sweep();
      expect(f.release).not.toHaveBeenCalled();
      expect(await f.tools.execute(command)).toMatchObject({ result: { kind: "windows" } });
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(
        f.service.runtime.list(owner.windowId).some((view) => view.pendingApproval !== undefined),
      ).toBe(false);
    } finally {
      await f.service.close();
      vi.useRealTimers();
    }
  });
  it("ends an app grant when its thread stops being active, and asks again if the thread returns", async () => {
    const f = fixture();
    const command = {
      name: "octant_computer",
      inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
    };
    try {
      const first = f.tools.execute(command);
      await approvePending(f);
      await first;
      // An archived thread is no longer current; the sweep that follows every
      // journal commit ends what it held.
      f.revoke();
      await f.service.sweep();
      f.restore();
      const again = f.tools.execute(command);
      expect((await approvePending(f)).scope).toBe("application-session");
      await again;
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.close();
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
  it("offers a one-time approval, not an app grant, once the thread has read external content", async () => {
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
      expect(pending?.summary).not.toContain("this thread");
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
      const next = f.service.toolSet(owner);
      if (next === undefined) throw new Error("Expected the offered tool.");
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

  it("under Strict asks again below Full access once the thread read outside content, instead of honouring the app grant", async () => {
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

      // The grant now covers the app for the thread. Below Full access, once
      // the thread has ingested external content, a standing grant must not
      // carry an irreversible action: the runtime asks again for a fresh
      // confirmation.
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

/** Approves the one action now waiting for this Mac's person. */
async function approvePending(f: ReturnType<typeof fixture>, approver = owner) {
  await vi.waitFor(() =>
    expect(
      f.service.runtime.list(approver.windowId).find((view) => view.pendingApproval !== undefined),
    ).toBeDefined(),
  );
  const view = f.service.runtime
    .list(approver.windowId)
    .find((candidate) => candidate.pendingApproval !== undefined);
  if (view?.pendingApproval === undefined) throw new Error("Expected an approval.");
  await f.service.runtime.decide({
    ownerWindowId: approver.windowId,
    threadId: approver.threadId,
    authority,
    sessionId: view.sessionId,
    actionId: view.pendingApproval.actionId,
    approvalId: view.pendingApproval.approvalId,
    decision: "approved",
  });
  return view.pendingApproval;
}

describe("Computer offered on every eligible turn", () => {
  it("offers the full tool to a turn whose send carries no selection", async () => {
    const f = fixture();
    try {
      expect(f.tools.definitions.map((definition) => definition.name)).toEqual(["octant_computer"]);
    } finally {
      await f.service.close();
    }
  });

  it("tells a host with no screen to start a desktop instead of asking for macOS permissions", async () => {
    const f = fixture({ leasableOnly: true });
    try {
      const outcome = await f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"apps"}',
      });
      expect(outcome).toMatchObject({
        isError: true,
        result: { kind: "refused", reason: "no-destination" },
      });
      expect(JSON.stringify(outcome)).toContain("Desktop tab");
      expect(JSON.stringify(outcome)).not.toContain("macOS");
    } finally {
      await f.service.close();
    }
  });

  it("runs the first action without approval at Full access outside Strict", async () => {
    const fullAccess = decodeComputerUseOwner({
      ...owner,
      mode: "work",
      executionPolicy: "full-access",
    });
    const f = fixture({ toolOwner: fullAccess, fullAccess: true, strict: false });
    try {
      const result = await f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      expect(result).toMatchObject({ result: { kind: "windows" } });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(
        f.service.runtime
          .list(fullAccess.windowId)
          .some((view) => view.pendingApproval !== undefined),
      ).toBe(false);
    } finally {
      await f.service.close();
    }
  });

  it("asks before the first action on each app in a thread under Strict even at Full access", async () => {
    const fullAccess = decodeComputerUseOwner({ ...owner, executionPolicy: "full-access" });
    const f = fixture({ toolOwner: fullAccess, fullAccess: true, strict: true });
    try {
      const first = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      const asked = await approvePending(f, fullAccess);
      expect(asked.summary).toContain("com.example.Fixture");
      expect(await first).toMatchObject({ result: { kind: "windows" } });
      // The grant covers that app only: the next app asks again.
      const other = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Other"}',
      });
      const askedAgain = await approvePending(f, fullAccess);
      expect(askedAgain.summary).toContain("com.example.Other");
      await other;
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.close();
    }
  });

  it("remembers an app grant for the Project across restarts and threads, isolates other Projects, and asks again once forgotten", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-computer-project-remember-"));
    directories.push(directory);
    const projectA = decodeProjectId("55555555-5555-4555-8555-555555555501");
    const projectB = decodeProjectId("55555555-5555-4555-8555-555555555502");
    const threadA1 = decodeComputerUseOwner({
      ...owner,
      mode: "work",
      threadId: "22222222-2222-4222-8222-222222222201",
    });
    const threadA2 = decodeComputerUseOwner({
      ...owner,
      mode: "work",
      threadId: "22222222-2222-4222-8222-222222222202",
    });
    const threadB1 = decodeComputerUseOwner({
      ...owner,
      mode: "work",
      threadId: "22222222-2222-4222-8222-222222222203",
    });
    const authorityFor = (projectId: ProjectId) =>
      decodeToolActionAuthority({
        hostId: "44444444-4444-4444-8444-444444444444",
        mode: "work",
        projectId,
        providerInstanceId: owner.providerInstanceId,
        extension: { kind: "core" },
      });
    const projectOf = (target: ComputerUseOwner): ProjectId =>
      String(target.threadId) === String(threadB1.threadId) ? projectB : projectA;

    const boot = () => {
      const connection = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => "2026-11-19T12:00:00.000Z");
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock: () => "2026-11-19T12:00:00.000Z",
      });
      const persistence = {
        journal,
        readShellSettings: () => readShellSettings(connection),
        readWindowWorkspace: () => undefined,
        readWindowWorkspaces: () => [],
        readEnvironmentPresentation: () => undefined,
        readProject: () => undefined,
        readChatThread: () => undefined,
        readCodeThread: () => undefined,
        status: () => ({ state: "current" as const, integrity: "ok" as const }),
        rebuildProjections: () =>
          rebuildProjections({
            connection,
            journal,
            projections: runtime.projections.all(),
            clock: () => "2026-11-19T12:00:00.000Z",
          }),
        close: () => connection.close(),
      };
      const shellService = new ShellService({
        persistence: persistence as unknown as PersistenceService,
        uuid: () => crypto.randomUUID(),
        clock: () => "2026-11-19T12:00:00.000Z",
      });
      shellService.bootstrap(owner.windowId);
      const execute = vi.fn(async () =>
        decodeComputerControlResult({
          kind: "windows",
          appId: "com.example.Fixture",
          windows: [{ windowId: 9, title: "Fixture" }],
        }),
      );
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
          release: async () => {},
        },
        settings: () => ({ enabled: true, automaticUpdates: true }),
        authority: (target) => authorityFor(projectOf(target)),
        ownerIsCurrent: () => true,
        toolConstraints: () => [],
        fullAccess: () => false,
        strict: () => false,
        externalContentIngested: () => false,
        projectAppRemembered: (projectId, appId) =>
          computerUseAppRemembered(
            (persistence.readShellSettings()?.settings ?? defaultShellSettings())
              .rememberedComputerUseApps,
            projectId,
            appId,
          ),
        rememberProjectApp: ({ projectId, appId, approver }) => {
          const stored = persistence.readShellSettings();
          shellService.rememberComputerUseApp({
            approver:
              approver.kind === "window"
                ? approver
                : {
                    kind: "paired-device",
                    actor: decodeEventActor({
                      kind: "remote-device",
                      actorId: approver.deviceId,
                      deviceId: approver.deviceId,
                    }),
                  },
            expectedVersion: stored?.aggregateVersion ?? (0 as never),
            projectId,
            appId,
          });
        },
        threadTitle: () => "Project task",
        record: async () => {},
        now: () => Date.now(),
      });
      return { persistence, shellService, service, execute };
    };

    const command = {
      name: "octant_computer",
      inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
    };

    // First server lifetime: approve with "Remember for this Project" in Project A.
    const firstBoot = boot();
    try {
      const toolsA1 = firstBoot.service.toolSet(threadA1);
      if (toolsA1 === undefined) throw new Error("Expected offered tool.");
      const pendingCall = toolsA1.execute(command);
      await vi.waitFor(() =>
        expect(
          firstBoot.service.runtime.list(owner.windowId).find((v) => v.pendingApproval),
        ).toBeDefined(),
      );
      const view = firstBoot.service.runtime.list(owner.windowId).find((v) => v.pendingApproval);
      if (view?.pendingApproval === undefined) throw new Error("Expected pending approval.");
      expect(view.pendingApproval.canRememberForProject).toBe(true);
      await firstBoot.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: threadA1.threadId,
        authority: authorityFor(projectA),
        sessionId: view.sessionId,
        actionId: view.pendingApproval.actionId,
        approvalId: view.pendingApproval.approvalId,
        decision: "approved",
        rememberForProject: true,
      });
      expect(await pendingCall).toMatchObject({ result: { kind: "windows" } });
      expect(firstBoot.persistence.readShellSettings()?.settings.rememberedComputerUseApps).toEqual(
        [
          expect.objectContaining({
            projectId: projectA,
            appId: "com.example.Fixture",
            grantedBy: expect.objectContaining({ kind: "local-user" }),
            grantedAt: "2026-11-19T12:00:00.000Z",
          }),
        ],
      );
    } finally {
      await firstBoot.service.close();
      firstBoot.persistence.close();
    }

    // Simulated restart: reopen persistence and rebuild projections from the journal.
    const secondBoot = boot();
    try {
      secondBoot.persistence.rebuildProjections();
      // A brand-new thread in Project A runs without first-action approval.
      const toolsA2 = secondBoot.service.toolSet(threadA2);
      if (toolsA2 === undefined) throw new Error("Expected offered tool.");
      expect(await toolsA2.execute(command)).toMatchObject({ result: { kind: "windows" } });
      expect(secondBoot.execute).toHaveBeenCalledOnce();
      expect(
        secondBoot.service.runtime
          .list(owner.windowId)
          .some((view) => view.pendingApproval !== undefined),
      ).toBe(false);

      // A thread in Project B still requires approval.
      const toolsB1 = secondBoot.service.toolSet(threadB1);
      if (toolsB1 === undefined) throw new Error("Expected offered tool.");
      const pendingB = toolsB1.execute(command);
      await vi.waitFor(() =>
        expect(
          secondBoot.service.runtime.list(owner.windowId).find((v) => v.pendingApproval),
        ).toBeDefined(),
      );
      const viewB = secondBoot.service.runtime.list(owner.windowId).find((v) => v.pendingApproval);
      if (viewB?.pendingApproval === undefined) throw new Error("Expected Project B approval.");
      await secondBoot.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: threadB1.threadId,
        authority: authorityFor(projectB),
        sessionId: viewB.sessionId,
        actionId: viewB.pendingApproval.actionId,
        approvalId: viewB.pendingApproval.approvalId,
        decision: "denied",
      });
      expect(await pendingB).toMatchObject({ isError: true });

      // Forgetting the remembered app in Settings makes a new Project A thread ask again.
      const stored = secondBoot.persistence.readShellSettings();
      if (stored === undefined) throw new Error("Expected stored settings.");
      secondBoot.shellService.execute(
        decodeShellCommand({
          kind: "replace-settings",
          windowId: owner.windowId,
          expectedVersion: stored.aggregateVersion,
          settings: { ...stored.settings, rememberedComputerUseApps: [] },
        }),
      );
      const threadA3 = decodeComputerUseOwner({
        ...owner,
        mode: "work",
        threadId: "22222222-2222-4222-8222-222222222204",
      });
      const toolsA3 = secondBoot.service.toolSet(threadA3);
      if (toolsA3 === undefined) throw new Error("Expected offered tool.");
      const pendingA3 = toolsA3.execute(command);
      await vi.waitFor(() =>
        expect(
          secondBoot.service.runtime.list(owner.windowId).find((v) => v.pendingApproval),
        ).toBeDefined(),
      );
      const viewA3 = secondBoot.service.runtime.list(owner.windowId).find((v) => v.pendingApproval);
      if (viewA3?.pendingApproval === undefined)
        throw new Error("Expected Project A approval after forgetting.");
      await secondBoot.service.runtime.decide({
        ownerWindowId: owner.windowId,
        threadId: threadA3.threadId,
        authority: authorityFor(projectA),
        sessionId: viewA3.sessionId,
        actionId: viewA3.pendingApproval.actionId,
        approvalId: viewA3.pendingApproval.approvalId,
        decision: "denied",
      });
      expect(await pendingA3).toMatchObject({ isError: true });
    } finally {
      await secondBoot.service.close();
      secondBoot.persistence.close();
    }
  });

  it("refuses rememberForProject when the pending approval does not allow remembering", async () => {
    const f = fixture({ strict: true });
    try {
      f.taint();
      const pendingCall = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(f.service.runtime.list(owner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = f.service.runtime.list(owner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected approval.");
      expect(view.pendingApproval.canRememberForProject).toBeUndefined();
      await expect(
        f.service.runtime.decide({
          ownerWindowId: owner.windowId,
          threadId: owner.threadId,
          authority,
          sessionId: view.sessionId,
          actionId: view.pendingApproval.actionId,
          approvalId: view.pendingApproval.approvalId,
          decision: "approved",
          rememberForProject: true,
        }),
      ).rejects.toThrow("cannot be remembered for the Project");
      await f.tools.close?.();
      expect(await pendingCall).toMatchObject({ isError: true });
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });

  it("refuses to persist a Project grant when the thread loses authority or Computer use is disabled while approval waits", async () => {
    const projectId = decodeProjectId("55555555-5555-4555-8555-555555555511");
    const projectOwner = decodeComputerUseOwner({ ...owner, mode: "work" });
    const projectAuthority = decodeToolActionAuthority({
      hostId: "44444444-4444-4444-8444-444444444444",
      mode: "work",
      projectId,
      providerInstanceId: owner.providerInstanceId,
      extension: { kind: "core" },
    });

    for (const drift of ["revoked-or-plan", "disabled"] as const) {
      let current = true;
      let enabled = true;
      const rememberProjectApp = vi.fn();
      const execute = vi.fn(async () =>
        decodeComputerControlResult({
          kind: "windows",
          appId: "com.example.Fixture",
          windows: [{ windowId: 9, title: "Fixture" }],
        }),
      );
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
          release: async () => {},
        },
        settings: () => ({ enabled, automaticUpdates: true }),
        authority: () => projectAuthority,
        ownerIsCurrent: () => current,
        toolConstraints: () => [],
        fullAccess: () => false,
        strict: () => false,
        externalContentIngested: () => false,
        rememberProjectApp,
        threadTitle: () => "Project task",
        record: async () => {},
        now: () => Date.now(),
      });
      try {
        const tools = service.toolSet(projectOwner);
        if (tools === undefined) throw new Error("Expected offered tool.");
        const pendingCall = tools.execute({
          name: "octant_computer",
          inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
        });
        await vi.waitFor(() =>
          expect(service.runtime.list(projectOwner.windowId)[0]?.pendingApproval).toBeDefined(),
        );
        const view = service.runtime.list(projectOwner.windowId)[0];
        if (view?.pendingApproval === undefined) throw new Error("Expected pending approval.");
        expect(view.pendingApproval.canRememberForProject).toBe(true);

        // Thread is archived / moved to Plan (ownerIsCurrent turns false) or Computer use disabled.
        if (drift === "revoked-or-plan") current = false;
        else enabled = false;

        await expect(
          service.runtime.decide({
            ownerWindowId: projectOwner.windowId,
            threadId: projectOwner.threadId,
            authority: projectAuthority,
            sessionId: view.sessionId,
            actionId: view.pendingApproval.actionId,
            approvalId: view.pendingApproval.approvalId,
            decision: "approved",
            rememberForProject: true,
          }),
        ).rejects.toMatchObject({ category: "approval-denied" });
        expect(await pendingCall).toMatchObject({ isError: true });
        expect(rememberProjectApp).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await service.close();
      }
    }
  });

  it("refuses to persist a Project grant when outside content enters a Strict thread while approval waits", async () => {
    const projectId = decodeProjectId("55555555-5555-4555-8555-555555555512");
    const projectOwner = decodeComputerUseOwner({ ...owner, mode: "work" });
    const projectAuthority = decodeToolActionAuthority({
      hostId: "44444444-4444-4444-8444-444444444444",
      mode: "work",
      projectId,
      providerInstanceId: owner.providerInstanceId,
      extension: { kind: "core" },
    });
    let tainted = false;
    const rememberProjectApp = vi.fn();
    const execute = vi.fn(async () =>
      decodeComputerControlResult({
        kind: "windows",
        appId: "com.example.Fixture",
        windows: [{ windowId: 9, title: "Fixture" }],
      }),
    );
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
        release: async () => {},
      },
      settings: () => ({ enabled: true, automaticUpdates: true }),
      authority: () => projectAuthority,
      ownerIsCurrent: () => true,
      toolConstraints: () => [],
      fullAccess: () => false,
      strict: () => true,
      externalContentIngested: () => tainted,
      rememberProjectApp,
      threadTitle: () => "Strict project task",
      record: async () => {},
      now: () => Date.now(),
    });
    try {
      const tools = service.toolSet(projectOwner);
      if (tools === undefined) throw new Error("Expected offered tool.");
      const pendingCall = tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      await vi.waitFor(() =>
        expect(service.runtime.list(projectOwner.windowId)[0]?.pendingApproval).toBeDefined(),
      );
      const view = service.runtime.list(projectOwner.windowId)[0];
      if (view?.pendingApproval === undefined) throw new Error("Expected pending approval.");
      expect(view.pendingApproval.canRememberForProject).toBe(true);

      // Outside content arrives under Strict before the person clicks Remember for this Project.
      tainted = true;

      await expect(
        service.runtime.decide({
          ownerWindowId: projectOwner.windowId,
          threadId: projectOwner.threadId,
          authority: projectAuthority,
          sessionId: view.sessionId,
          actionId: view.pendingApproval.actionId,
          approvalId: view.pendingApproval.approvalId,
          decision: "approved",
          rememberForProject: true,
        }),
      ).rejects.toMatchObject({ category: "approval-denied" });
      expect(await pendingCall).toMatchObject({ isError: true });
      expect(rememberProjectApp).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("outside Strict lets an app grant carry later actions below Full access after the thread read outside content", async () => {
    const f = fixture({ strict: false });
    const windows = {
      name: "octant_computer",
      inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
    };
    try {
      const first = f.tools.execute(windows);
      await approvePending(f);
      await first;
      f.taint();
      expect(await f.tools.execute(windows)).toMatchObject({ result: { kind: "windows" } });
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.close();
    }
  });

  it("lets an app grant carry later actions at Full access after the thread read outside content", async () => {
    // A Work owner never carries its thread's level, so the host reads it
    // from the thread.
    const fullAccess = decodeComputerUseOwner({ ...owner, mode: "work" });
    const f = fixture({ toolOwner: fullAccess, fullAccess: true });
    const windows = (appId: string) => ({
      name: "octant_computer",
      inputJson: JSON.stringify({ operation: "windows", appId }),
    });
    try {
      const first = f.tools.execute(windows("com.example.Fixture"));
      await approvePending(f, fullAccess);
      await first;
      f.taint();
      expect(await f.tools.execute(windows("com.example.Fixture"))).toMatchObject({
        result: { kind: "windows" },
      });
      expect(f.execute).toHaveBeenCalledTimes(2);
      // The first action on another app still asks, for a grant that lasts
      // the thread rather than for one action.
      const other = f.tools.execute(windows("com.example.Other"));
      const asked = await approvePending(f, fullAccess);
      expect(asked.scope).toBe("application-session");
      expect(asked.summary).toBe(
        'Allow control of com.example.Other for "Fixture task" for this thread.',
      );
      await other;
      expect(await f.tools.execute(windows("com.example.Other"))).toMatchObject({
        result: { kind: "windows" },
      });
      expect(f.execute).toHaveBeenCalledTimes(4);
    } finally {
      await f.service.close();
    }
  });

  it("shows the agent's reason on the approval it asks", async () => {
    const f = fixture();
    try {
      const call = f.tools.execute({
        name: "octant_computer",
        inputJson: JSON.stringify({
          operation: "windows",
          appId: "com.example.Fixture",
          reason: "Open the notes the person asked about",
        }),
      });
      const asked = await approvePending(f);
      expect(asked.summary).toContain('The agent says: "Open the notes the person asked about"');
      expect(await call).toMatchObject({ result: { kind: "windows" } });
    } finally {
      await f.service.close();
    }
  });

  it("keeps the approval summary within its contract limit for a long reason", async () => {
    const f = fixture();
    try {
      const call = f.tools.execute({
        name: "octant_computer",
        inputJson: JSON.stringify({
          operation: "windows",
          appId: "com.example.Fixture",
          reason: "r".repeat(600),
        }),
      });
      const asked = await approvePending(f);
      expect(asked.summary.length).toBeLessThanOrEqual(512);
      expect(asked.summary).toContain("The agent says:");
      expect(await call).toMatchObject({ result: { kind: "windows" } });
    } finally {
      await f.service.close();
    }
  });

  it("asks again for a Computer action once a Browser page entered the thread, naming the page", async () => {
    const connection = openDatabase();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-10-30T12:00:00.000Z",
    });
    const ingestions = new ExternalContentIngestionStore({
      journal,
      connection,
      uuid: () => crypto.randomUUID(),
      clock: () => "2026-10-30T12:00:00.000Z",
      actor: decodeEventActor({ kind: "system", actorId: "99999999-9999-4999-8999-999999999999" }),
    });
    const f = fixture({
      marks: {
        ingested: () =>
          readThreadExternalContentTaint(connection, owner.threadId).externalContentIngested,
        outsideContent: () => readApprovalOutsideContent(connection, owner.threadId),
      },
    });
    try {
      const first = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      expect((await approvePending(f)).scope).toBe("application-session");
      await first;
      // The record the Browser writes when it reads a page into the thread.
      ingestions.record({
        threadId: owner.threadId,
        provenance: { origin: "tool-result", sourceLabel: "browser-observation" },
        contentReference: "browser-observation-fixture",
        correlationId: crypto.randomUUID(),
        authorized: true,
      });
      const after = f.tools.execute({
        name: "octant_computer",
        inputJson: '{"operation":"windows","appId":"com.example.Fixture"}',
      });
      const asked = await approvePending(f);
      expect(asked.scope).toBeUndefined();
      expect(asked.summary).toContain("this one action");
      expect(asked.outsideContent?.sources.map((source) => source.sourceLabel)).toContain(
        "browser-observation",
      );
      await after;
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.close();
      connection.close();
    }
  });

  it("offers no definition while Computer use is disabled", async () => {
    const f = fixture({ enabled: false });
    try {
      expect(f.service.toolSet(owner)).toBeUndefined();
    } finally {
      await f.service.close();
    }
  });

  it("offers no definition when the thread's tool constraints exclude it", async () => {
    const f = fixture({ toolConstraints: ["octant_terminal"] });
    try {
      expect(f.service.toolSet(owner)).toBeUndefined();
    } finally {
      await f.service.close();
    }
  });

  it("offers no definition in Plan", async () => {
    const f = fixture();
    try {
      expect(
        f.service.toolSet(decodeComputerUseOwner({ ...owner, executionPolicy: "plan" })),
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
    const extend = vi.fn(
      async (
        _owner: ComputerUseOwner,
        byMinutes: number,
        confirm: (request: DesktopExtensionConfirmation) => Promise<"approved" | "declined">,
      ): Promise<ComputerControlResult> => {
        const expiresAt = "2026-10-26T13:00:00.000Z";
        const answer = await confirm({
          owner: { mode: "code", threadId: onDesktop.threadId },
          leaseId,
          provider: {
            providerId: decodeDesktopProviderId("host-local"),
            displayName: "This host",
            locality: "host-local",
            billed: false,
          },
          byMinutes,
          expiresAt,
        });
        return answer === "approved"
          ? decodeComputerControlResult({ kind: "extended", expiresAt })
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
      now: () => Date.now(),
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
      leases: { bindable: () => options.bindable ?? true, control, sendFile, extend },
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
      fullAccess: () => false,
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
      extend,
      transfers,
      ask,
      asked,
      recorded,
      macExecute,
      taint: () => {
        tainted = true;
      },
      tools(target: ComputerUseOwner = onDesktop, imagesSupported = true) {
        const tools = service.toolSet(target, imagesSupported, ask);
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
      expect(unbindable.service.toolSet(onDesktop, true, bound.ask)).toBeUndefined();
      expect(bound.service.toolSet(onDesktop)).toBeUndefined();
      // A host with no screen of its own offers no Mac tool at all, and still
      // reports itself leasable rather than a screen.
      expect(bound.service.runtime.destination()).toMatchObject({ status: "leasable" });
      expect(bound.service.toolSet(owner)).toBeUndefined();
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
        `Allow control of notes-app on this thread's disposable desktop for "Notes app" for this thread.`,
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
      const tools = f.service.toolSet(onDesktop, true, ask);
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
      // The lease service is told the thread is marked, so an answer from before the mark does not cover it.
      await tools.execute(call({ operation: "send-file", path: "dist/notes-app" }));
      expect(f.sendFile.mock.calls[0]?.[3]).toBe(true);
    } finally {
      await f.service.close();
    }
  });

  it("offers no tool in Plan, so nothing asks or reaches the desktop", async () => {
    const f = desktop();
    try {
      expect(
        f.service.toolSet(
          decodeComputerUseOwner({ ...onDesktop, executionPolicy: "plan" }),
          true,
          f.ask,
        ),
      ).toBeUndefined();
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
        `Send dist/notes-app (9 bytes, SHA-256 ${"a".repeat(64)}) into this thread's disposable desktop on This host for "Notes app"? Approving also covers this thread's later files into that desktop.`,
      );
    } finally {
      await f.service.close();
    }
  });

  it("extends the desktop's lease through the host, asking in the thread with the minutes and the new end", async () => {
    const f = desktop({ answers: ["denied", "approved"] });
    try {
      const tools = f.tools();
      expect(JSON.stringify(tools.definitions[0]?.inputSchema)).toContain("extend");
      const extend = call({ operation: "extend", minutes: 30 });
      await expect(tools.execute(extend)).resolves.toMatchObject({
        isError: true,
        result: { kind: "refused", reason: "declined" },
      });
      await expect(tools.execute(extend)).resolves.toEqual({
        result: { kind: "extended", expiresAt: "2026-10-26T13:00:00.000Z" },
        isError: false,
      });
      expect(f.extend.mock.calls.map(([, minutes]) => minutes)).toEqual([30, 30]);
      expect(f.asked[0]).toBe(
        `Keep this thread's disposable desktop on This host running 30 more minutes, until 2026-10-26T13:00:00.000Z, for "Notes app"?`,
      );
      // Minutes the contract does not allow never reach the host.
      for (const operation of [
        { operation: "extend", minutes: 0 },
        { operation: "extend", minutes: 241 },
        { operation: "extend" },
      ]) {
        await expect(tools.execute(call(operation))).resolves.toMatchObject({
          isError: true,
          result: { kind: "refused", reason: "invalid-command" },
        });
      }
      expect(f.extend).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.close();
    }
  });

  it("asks for an app again once a file of its name is sent, leaving other apps' grants alone", async () => {
    const f = desktop();
    try {
      const tools = f.tools();
      await tools.execute(call({ operation: "launch", appId: "notes-app" }));
      await tools.execute(call({ operation: "launch", appId: "other-app" }));
      expect(f.asked).toHaveLength(2);
      await expect(
        tools.execute(call({ operation: "send-file", path: "dist/notes-app" })),
      ).resolves.toEqual({ result: sent, isError: false });
      expect(f.asked).toHaveLength(3);
      // The file under that name may now be a different program than the one
      // the person approved, so its next launch asks again.
      await tools.execute(call({ operation: "launch", appId: "notes-app" }));
      await tools.execute(call({ operation: "windows", appId: "other-app" }));
      expect(f.asked.slice(3)).toEqual([
        `Allow control of notes-app on this thread's disposable desktop for "Notes app" for this thread.`,
      ]);
      expect(f.control).toHaveBeenCalledTimes(4);
    } finally {
      await f.service.close();
    }
  });

  it("keeps keyboard-focus typing to the desktop and refuses it on this Mac", async () => {
    const f = desktop({ withMac: true });
    try {
      const mac = f.service.toolSet(owner);
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
