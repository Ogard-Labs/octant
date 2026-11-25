import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { expect, it, vi } from "vitest";
import { canOpenActiveWork, openActiveWork } from "./openActiveWork";

const here = { hostId: String(LOCAL_HOST_ID) };
const mini = { hostId: "00000000-0000-4000-8000-0000000000b1" };
const threadId = "00000000-0000-4000-8000-000000000021";

function openers() {
  return {
    selectChatThread: vi.fn(),
    selectWorkThread: vi.fn(),
    selectCodeThread: vi.fn(),
    openPairedComputerThread: vi.fn(),
  };
}

it("opens a thread here through its own mode's sidebar choice", () => {
  const made = openers();
  openActiveWork(made, here, { mode: "chat", threadId });
  openActiveWork(made, here, { mode: "work", threadId });
  openActiveWork(made, here, { mode: "code", threadId });
  expect(made.selectChatThread).toHaveBeenCalledWith(threadId);
  expect(made.selectWorkThread).toHaveBeenCalledWith(threadId);
  expect(made.selectCodeThread).toHaveBeenCalledWith(threadId);
  expect(made.openPairedComputerThread).not.toHaveBeenCalled();
});

it("opens a Code thread on the computer that listed it, and no thread a paired computer's screen cannot show", () => {
  const made = openers();
  openActiveWork(made, mini, { mode: "code", threadId });
  openActiveWork(made, mini, { mode: "work", threadId });
  openActiveWork(made, mini, { mode: "chat", threadId });
  expect(made.openPairedComputerThread.mock.calls).toEqual([[mini.hostId, threadId]]);
  expect(made.selectWorkThread).not.toHaveBeenCalled();
  expect(made.selectChatThread).not.toHaveBeenCalled();
  expect(canOpenActiveWork(mini, { mode: "work" })).toBe(false);
});
