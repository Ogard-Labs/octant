import { describe, expect, it } from "vitest";
import { resolveZenProjectTerminalTarget, resolveZenTerminalPinTarget } from "./zenThreadActions";

const threadId = "10000000-0000-4000-8000-000000000001";
const checkoutId = "20000000-0000-4000-8000-000000000002";

describe("resolveZenTerminalPinTarget", () => {
  it("names the Code thread's existing default terminal without starting a process", () => {
    const target = resolveZenTerminalPinTarget(
      {
        hostId: "local-host",
        mode: "code",
        projectId: "30000000-0000-4000-8000-000000000003",
        threadKind: "code",
        threadId,
      } as never,
      [
        {
          id: threadId,
          checkoutId,
          title: "Release work",
          executionPolicy: "approval-gated",
        } as never,
      ],
    );

    expect(target).toEqual({
      checkoutId,
      terminalId: threadId,
      threadId,
      title: "Release work",
    });
  });

  it("refuses non-Code or unavailable thread sources", () => {
    expect(
      resolveZenTerminalPinTarget(
        {
          hostId: "local-host",
          mode: "work",
          projectId: null,
          threadKind: "work",
          threadId,
        } as never,
        [],
      ),
    ).toBeUndefined();
    expect(
      resolveZenTerminalPinTarget(
        {
          hostId: "local-host",
          mode: "code",
          projectId: null,
          threadKind: "code",
          threadId,
        } as never,
        [],
      ),
    ).toBeUndefined();
    expect(
      resolveZenTerminalPinTarget(
        {
          hostId: "local-host",
          mode: "code",
          projectId: null,
          threadKind: "code",
          threadId,
        } as never,
        [
          {
            id: threadId,
            checkoutId,
            title: "Plan only",
            executionPolicy: "plan",
          } as never,
        ],
      ),
    ).toBeUndefined();
  });
});

describe("resolveZenProjectTerminalTarget", () => {
  const project = (id: string, type: "work" | "code", developerTools = false) =>
    ({
      id,
      name: `${type} project`,
      type,
      lifecycle: "active",
      ...(developerTools
        ? {
            developerTools: {
              enabled: true,
              changedBy: { kind: "local-user", actorId: "local" },
              changedAt: "2026-10-31T12:00:00.000Z",
            },
          }
        : {}),
    }) as never;
  const workspace = (activeMode: "work" | "code") =>
    ({
      activeMode,
      contextByMode: {
        chat: { projectId: null },
        work: { projectId: "work-1" },
        code: { projectId: "code-1" },
      },
    }) as never;

  it("opens the Project of the mode the window is showing, a Work one only with Developer tools on", () => {
    const projects = [project("work-1", "work", true), project("code-1", "code")];
    expect(resolveZenProjectTerminalTarget(workspace("work"), projects)?.projectId).toBe("work-1");
    expect(resolveZenProjectTerminalTarget(workspace("code"), projects)?.projectId).toBe("code-1");
    expect(
      resolveZenProjectTerminalTarget(workspace("work"), [
        project("work-1", "work"),
        project("code-1", "code"),
      ])?.projectId,
    ).toBe("code-1");
  });
});
