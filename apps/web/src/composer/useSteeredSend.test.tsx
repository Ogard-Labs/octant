import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TurnSettlement } from "./steeredSend";
import { useSteeredSend } from "./useSteeredSend";

interface Message {
  readonly prompt: string;
}

const message: Message = { prompt: "and then run the tests" };

function harness(input: {
  readonly send: (message: Message) => Promise<boolean>;
  readonly restore?: (message: Message) => void;
  readonly threadKey?: string;
}) {
  return renderHook(
    (props: { settlement: TurnSettlement | "idle"; threadKey: string }) =>
      useSteeredSend<Message>({
        threadKey: props.threadKey,
        settlement: props.settlement,
        send: input.send,
        restore: input.restore ?? (() => {}),
      }),
    { initialProps: { settlement: "running" as TurnSettlement | "idle", threadKey: "thread-a" } },
  );
}

describe("sending a message while a response is running", () => {
  it("sends it as soon as the running response finishes", async () => {
    const send = vi.fn(async () => true);
    const { rerender, result } = harness({ send });

    act(() => {
      expect(result.current.steer(message)).toBe(true);
    });
    expect(result.current.pending).toEqual(message);
    expect(send).not.toHaveBeenCalled();

    rerender({ settlement: "completed", threadKey: "thread-a" });
    await waitFor(() => expect(send).toHaveBeenCalledWith(message));
    await waitFor(() => expect(result.current.pending).toBeUndefined());
  });

  it("sends it after a cancelled response rather than leaving it unsent", async () => {
    const send = vi.fn(async () => true);
    const { rerender, result } = harness({ send });

    act(() => {
      result.current.steer(message);
    });
    rerender({ settlement: "cancelled", threadKey: "thread-a" });
    await waitFor(() => expect(send).toHaveBeenCalledWith(message));
    await waitFor(() => expect(result.current.pending).toBeUndefined());
  });

  it("hands the words back when the host refuses it", async () => {
    const send = vi.fn(async () => false);
    const restore = vi.fn();
    const { rerender, result } = harness({ send, restore });

    act(() => {
      result.current.steer(message);
    });
    rerender({ settlement: "failed", threadKey: "thread-a" });
    await waitFor(() => expect(restore).toHaveBeenCalledWith(message));
    await waitFor(() => expect(result.current.pending).toBeUndefined());
  });

  it("hands the words back rather than sending into a thread the user left", async () => {
    const send = vi.fn(async () => true);
    const restore = vi.fn();
    const { rerender, result } = harness({ send, restore });

    act(() => {
      result.current.steer(message);
    });
    rerender({ settlement: "running", threadKey: "thread-b" });
    await waitFor(() => expect(restore).toHaveBeenCalledWith(message));
    expect(send).not.toHaveBeenCalled();
  });

  it("gives up on a thread that will never run it, keeping the words", async () => {
    const send = vi.fn(async () => true);
    const restore = vi.fn();
    const { result } = harness({ send, restore });

    act(() => {
      result.current.steer(message);
    });
    act(() => {
      result.current.drop();
    });
    await waitFor(() => expect(restore).toHaveBeenCalledWith(message));
    expect(result.current.pending).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
