import { describe, expect, it } from "vitest";
import {
  changeMobileThreadLevel,
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
