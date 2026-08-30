import { describe, expect, it } from "vitest";
import {
  EMPTY_STEERED_SEND,
  disarmSteeredSend,
  settleSteeredSend,
  steerSend,
  type SteeredSendState,
} from "./steeredSend";

interface Message {
  readonly prompt: string;
}

const message: Message = { prompt: "and then run the tests" };
const steering: SteeredSendState<Message> = {
  status: "steering",
  threadKey: "thread-1",
  message,
};

describe("a message sent while a turn is running", () => {
  it("is only held back while a turn is actually running", () => {
    expect(steerSend(EMPTY_STEERED_SEND, "thread-1", message, "completed")).toEqual(
      EMPTY_STEERED_SEND,
    );
    expect(steerSend(EMPTY_STEERED_SEND, "thread-1", message, "running")).toEqual(steering);
  });

  it("keeps the first message when a second is sent before it runs", () => {
    const second = steerSend(steering, "thread-1", { prompt: "no, wait" }, "running");
    expect(second).toBe(steering);
  });

  it("runs as soon as the thread stops running a response", () => {
    for (const settlement of ["completed", "cancelled", "failed", "refused", "waiting"] as const) {
      expect(settleSteeredSend(steering, "thread-1", settlement).fire).toBe(true);
    }
    expect(settleSteeredSend(steering, "thread-1", "running").fire).toBe(false);
  });

  it("is dropped rather than sent into a thread the user has left", () => {
    expect(disarmSteeredSend(steering, "thread-2")).toEqual(EMPTY_STEERED_SEND);
    expect(disarmSteeredSend(steering, undefined)).toEqual(EMPTY_STEERED_SEND);
    expect(disarmSteeredSend(steering, "thread-1")).toBe(steering);
    expect(settleSteeredSend(steering, "thread-2", "completed")).toEqual({
      next: EMPTY_STEERED_SEND,
      fire: false,
    });
  });
});
