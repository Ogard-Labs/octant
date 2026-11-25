import { describe, expect, it, vi } from "vitest";
import {
  decodeSideTaskReportOwed,
  type ChatThread,
  type SideTaskReportOwed,
  type WorkThread,
} from "@octant/contracts";
import { ChatServiceError } from "../chat/chatService";
import {
  createChatSideTaskReportDeliveryPort,
  createWorkSideTaskReportDeliveryPort,
} from "./sideTaskReportDeliveryPorts";

const now = "2026-11-24T12:00:00.000Z";
const parent = "00000000-0000-4000-8000-0000000000aa";

const report = (parentMode: SideTaskReportOwed["parentMode"]) =>
  decodeSideTaskReportOwed({
    reportId: "00000000-0000-4000-8000-0000000000b1",
    parentThreadId: parent,
    parentMode,
    title: "Fix stale install docs",
    outcome: "completed",
    text: "Done.",
    endedAt: now,
    owedAt: now,
  });

function chatPort(lifecycle: ChatThread["lifecycle"], refusal?: ChatServiceError) {
  const thread = { id: parent, version: 1, lifecycle } as unknown as ChatThread;
  const execute = vi.fn(async () => {
    throw (
      refusal ??
      new ChatServiceError({ category: "invalid", message: `Chat thread is ${lifecycle}.` })
    );
  });
  const port = createChatSideTaskReportDeliveryPort({
    readThread: () => thread,
    readThreadView: () => undefined,
    chat: { read: () => ({ thread }) as never, execute },
  });
  return { port, execute };
}

describe("a parent that cannot take a side task's report", () => {
  it.each(["deleting", "deleted"] as const)(
    "settles the report for good when the Chat parent is %s",
    async (lifecycle) => {
      const { port, execute } = chatPort(lifecycle);
      await expect(port.dispatch(parent, [report("chat")])).resolves.toMatchObject({
        kind: "refused",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["archived", chatPort("archived")],
    [
      "on a provider that takes no unattended turn",
      chatPort(
        "active",
        new ChatServiceError({
          category: "unauthorized",
          message: "This sign-in only runs turns a person sends.",
        }),
      ),
    ],
  ])("keeps the report owed when the Chat parent is %s", async (_standing, { port }) => {
    await expect(port.dispatch(parent, [report("chat")])).resolves.toMatchObject({
      kind: "deferred",
    });
  });

  it("settles the report for good when the Work parent is deleted", async () => {
    const startFirstTurn = vi.fn();
    const port = createWorkSideTaskReportDeliveryPort({
      uuid: () => "00000000-0000-4000-8000-0000000000b2",
      isEnabled: () => true,
      readThread: () => ({ id: parent, lifecycle: "deleted" }) as unknown as WorkThread,
      listTurns: () => [],
      startFirstTurn,
    });
    await expect(port.dispatch(parent, [report("work")])).resolves.toMatchObject({
      kind: "refused",
    });
    expect(startFirstTurn).not.toHaveBeenCalled();
  });
});
