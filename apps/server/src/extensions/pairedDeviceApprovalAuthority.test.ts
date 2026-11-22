import { describe, expect, it } from "vitest";
import {
  chatThreadStandsInProject,
  isDeviceRegistrationCurrent,
  windowReachesPromptThread,
} from "./pairedDeviceApprovalAuthority";

const now = Date.parse("2026-10-15T12:00:00.000Z");

describe("paired device approval authority", () => {
  it("stops counting a device as paired once its deadline passes, before the expiry is reconciled", () => {
    expect(
      isDeviceRegistrationCurrent({ state: "active", expiresAt: "2026-10-16T00:00:00.000Z" }, now),
    ).toBe(true);
    expect(
      isDeviceRegistrationCurrent({ state: "active", expiresAt: "2026-10-15T12:00:00.000Z" }, now),
    ).toBe(false);
    expect(isDeviceRegistrationCurrent({ state: "active", expiresAt: "not a date" }, now)).toBe(
      false,
    );
    expect(
      isDeviceRegistrationCurrent({ state: "revoked", expiresAt: "2026-10-16T00:00:00.000Z" }, now),
    ).toBe(false);
    expect(isDeviceRegistrationCurrent(undefined, now)).toBe(false);
  });

  it("refuses a Chat thread that was archived, moved to another Project, or is gone", () => {
    const projectId = "77000000-0000-4000-8000-000000000001";
    expect(chatThreadStandsInProject({ lifecycle: "active", projectId }, projectId)).toBe(true);
    expect(chatThreadStandsInProject({ lifecycle: "active" }, undefined)).toBe(true);
    expect(chatThreadStandsInProject({ lifecycle: "archived", projectId }, projectId)).toBe(false);
    expect(
      chatThreadStandsInProject(
        { lifecycle: "active", projectId: "77000000-0000-4000-8000-000000000002" },
        projectId,
      ),
    ).toBe(false);
    expect(chatThreadStandsInProject({ lifecycle: "active", projectId }, undefined)).toBe(false);
    expect(chatThreadStandsInProject({ lifecycle: "active" }, projectId)).toBe(false);
    expect(chatThreadStandsInProject(undefined, undefined)).toBe(false);
  });
});

describe("a local window reaching a waiting prompt's thread", () => {
  const threadId = "77000000-0000-4000-8000-0000000000a1";
  const chatProject = "77000000-0000-4000-8000-0000000000c1";
  const workProject = "77000000-0000-4000-8000-0000000000c2";

  function reach(
    projectId: string | undefined,
    facts: {
      readonly chat?: { readonly lifecycle: string; readonly projectId?: string };
      readonly projectLifecycle?: string;
      readonly windowDrives?: boolean;
    },
  ) {
    return windowReachesPromptThread(
      { threadId, projectId },
      {
        readChatThread: () => facts.chat,
        readProject: (id) =>
          id === chatProject
            ? { type: "chat", lifecycle: facts.projectLifecycle ?? "active" }
            : id === workProject
              ? { type: "work", lifecycle: "active" }
              : undefined,
        windowDrivesProjectThread: (_thread, type, project) =>
          facts.windowDrives === true && type === "work" && project === workProject,
      },
    );
  }

  it("reaches a Chat thread, which no window binding holds, while it stands where the prompt recorded it", () => {
    expect(reach(undefined, { chat: { lifecycle: "active" } })).toBe(true);
    expect(reach(chatProject, { chat: { lifecycle: "active", projectId: chatProject } })).toBe(
      true,
    );
    expect(reach(undefined, { chat: { lifecycle: "archived" } })).toBe(false);
    expect(reach(undefined, { chat: { lifecycle: "active", projectId: chatProject } })).toBe(false);
    expect(
      reach(chatProject, {
        chat: { lifecycle: "active", projectId: chatProject },
        projectLifecycle: "archived",
      }),
    ).toBe(false);
    expect(reach(undefined, {})).toBe(false);
  });

  it("reaches a Work or Code thread only through the window's own Project binding", () => {
    expect(reach(workProject, { windowDrives: true })).toBe(true);
    expect(reach(workProject, { windowDrives: false })).toBe(false);
    // A Chat thread that happens to share the id never stands in for it.
    expect(reach(workProject, { chat: { lifecycle: "active", projectId: workProject } })).toBe(
      false,
    );
  });
});
