import { describe, expect, it } from "vitest";
import { resolveZenTerminalPinTarget } from "./zenThreadActions";

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
