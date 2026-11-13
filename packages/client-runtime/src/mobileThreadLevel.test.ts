import { describe, expect, it } from "vitest";
import {
  changeMobileDefaultLevel,
  changeMobileProjectLevel,
  changeMobileThreadLevel,
  mobileDefaultLevel,
  mobileProjectLevel,
  mobileThreadLevel,
  mobileThreadLevelChoices,
} from "./mobileThreadLevel";

const codeThread = {
  id: "50000000-0000-4000-8000-000000000001",
  version: 6,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  autoApprove: true,
} as const;
const workThread = {
  id: "20000000-0000-4000-8000-000000000001",
  version: 3,
  access: "auto-accept-edits",
} as const;

function host(status: number, answer: unknown) {
  const sent: Array<{ readonly path: string; readonly body: unknown }> = [];
  return {
    sent,
    transport: {
      hostId: "host",
      authenticatedFetch: async (input: { readonly path: string; readonly body?: unknown }) => {
        sent.push({ path: input.path, body: JSON.parse(String(input.body)) });
        return new Response(JSON.stringify(answer), { status });
      },
    },
  };
}

describe("a thread's level on the phone", () => {
  it("reads a Code and a Work thread's level in the product's own five modes", () => {
    expect(mobileThreadLevel({ mode: "code", thread: codeThread as never })).toBe("auto");
    expect(mobileThreadLevel({ mode: "work", thread: workThread as never })).toBe("accept-edits");
    expect(mobileThreadLevelChoices("code")).toContain("plan");
    expect(mobileThreadLevelChoices("work")).not.toContain("plan");
    expect(mobileThreadLevelChoices("work")).toContain("full-access");
  });

  it("sends a Code thread's Full access as the command a window sends, with nothing unlocked first", async () => {
    const { transport, sent } = host(200, { kind: "thread-updated" });
    const result = await changeMobileThreadLevel({
      transport,
      subject: { mode: "code", thread: codeThread as never },
      level: "full-access",
    });

    expect(result).toEqual({ status: "changed" });
    expect(sent).toEqual([
      {
        path: "/api/code/commands",
        body: {
          kind: "change-code-thread-access",
          threadId: codeThread.id,
          expectedVersion: 6,
          executionPolicy: "full-access",
          permissionPersistence: "current-session",
          autoApprove: false,
        },
      },
    ]);
  });

  it("sends a Work thread's Full access to the Work thread commands", async () => {
    const { transport, sent } = host(200, { kind: "thread-updated" });
    await changeMobileThreadLevel({
      transport,
      subject: { mode: "work", thread: workThread as never },
      level: "full-access",
    });

    expect(sent).toEqual([
      {
        path: "/api/work/threads/commands",
        body: {
          kind: "change-work-thread-access",
          threadId: workThread.id,
          expectedVersion: 3,
          access: "full-access",
        },
      },
    ]);
  });

  it("reports the host's refusal instead of a change, and never sends Work a Plan", async () => {
    const refusing = host(403, { category: "unauthorized" });
    expect(
      await changeMobileThreadLevel({
        transport: refusing.transport,
        subject: { mode: "code", thread: codeThread as never },
        level: "full-access",
      }),
    ).toEqual({ status: "refused", message: "The host did not change this thread's mode." });

    const work = host(200, { kind: "thread-updated" });
    expect(
      await changeMobileThreadLevel({
        transport: work.transport,
        subject: { mode: "work", thread: workThread as never },
        level: "plan",
      }),
    ).toMatchObject({ status: "refused" });
    expect(work.sent).toEqual([]);
  });
});

const codeProject = {
  id: "10000000-0000-4000-8000-000000000001",
  type: "code",
  name: "Octant",
  version: 4,
  defaultPermissionMode: "ask-first",
  defaultFullAccessSandbox: true,
} as const;
const workProject = {
  id: "10000000-0000-4000-8000-000000000002",
  type: "work",
  name: "Reports",
  version: 2,
} as const;
const codeSettings = {
  version: 9,
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  defaultAutoApprove: true,
} as const;
const workSettings = {
  version: 5,
  defaultAccess: "ask-first",
  defaultProviderInstanceId: "30000000-0000-4000-8000-000000000001",
  defaultModelId: "model-a",
} as const;

describe("the Project and default levels on the phone", () => {
  it("reads a Project's own level, and the default it follows when it has none", () => {
    expect(mobileProjectLevel(codeProject as never)).toBe("ask-first");
    expect(mobileProjectLevel(workProject as never)).toBeUndefined();
    expect(mobileDefaultLevel({ mode: "code", settings: codeSettings as never })).toBe("auto");
    expect(mobileDefaultLevel({ mode: "work", settings: workSettings as never })).toBe("ask-first");
  });

  it("sets a Code Project to Full access with the command a window sends, keeping its sandbox choice", async () => {
    const { transport, sent } = host(200, { kind: "code-project-access-changed" });
    const result = await changeMobileProjectLevel({
      transport,
      project: codeProject as never,
      level: "full-access",
    });

    expect(result).toEqual({ status: "changed" });
    expect(sent).toEqual([
      {
        path: "/api/projects/commands",
        body: {
          kind: "change-code-project-permission-mode",
          projectId: codeProject.id,
          expectedVersion: 4,
          permissionMode: "full-access",
          fullAccessSandbox: true,
        },
      },
    ]);
  });

  it("returns a Work Project to the default by naming no level, and never sends Work a Plan", async () => {
    const { transport, sent } = host(200, { kind: "work-project-permission-mode-changed" });
    await changeMobileProjectLevel({ transport, project: workProject as never, level: undefined });
    expect(
      await changeMobileProjectLevel({ transport, project: workProject as never, level: "plan" }),
    ).toMatchObject({ status: "refused" });

    expect(sent).toEqual([
      {
        path: "/api/projects/commands",
        body: {
          kind: "change-work-project-permission-mode",
          projectId: workProject.id,
          expectedVersion: 2,
        },
      },
    ]);
  });

  it("sets Code's default to Full access against the settings version it read", async () => {
    const { transport, sent } = host(200, { kind: "settings-updated" });
    const result = await changeMobileDefaultLevel({
      transport,
      subject: { mode: "code", settings: codeSettings as never },
      level: "full-access",
    });

    expect(result).toEqual({ status: "changed" });
    expect(sent).toEqual([
      {
        path: "/api/code/commands",
        body: {
          kind: "update-code-settings",
          expectedVersion: 9,
          defaultExecutionPolicy: "full-access",
          defaultPermissionPersistence: "current-session",
          defaultAutoApprove: false,
        },
      },
    ]);
  });

  it("sets Work's default to Full access and keeps the default model the host holds", async () => {
    const { transport, sent } = host(200, { kind: "settings-updated" });
    await changeMobileDefaultLevel({
      transport,
      subject: { mode: "work", settings: workSettings as never },
      level: "full-access",
    });

    expect(sent).toEqual([
      {
        path: "/api/work/threads/commands",
        body: {
          kind: "update-work-settings",
          expectedVersion: 5,
          defaultProviderInstanceId: workSettings.defaultProviderInstanceId,
          defaultModelId: "model-a",
          defaultAccess: "full-access",
        },
      },
    ]);
  });

  it("reports the host's refusal of a Project or default level from a restricted session", async () => {
    const refusing = host(403, { category: "unauthorized" });
    expect(
      await changeMobileProjectLevel({
        transport: refusing.transport,
        project: codeProject as never,
        level: "full-access",
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await changeMobileDefaultLevel({
        transport: refusing.transport,
        subject: { mode: "code", settings: codeSettings as never },
        level: "full-access",
      }),
    ).toMatchObject({ status: "refused" });
  });
});
