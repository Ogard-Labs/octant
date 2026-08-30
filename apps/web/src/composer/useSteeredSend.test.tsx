import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TurnSettlement } from "./steeredSend";
import { useSteeredSend } from "./useSteeredSend";

interface Message {
  readonly prompt: string;
}

const message: Message = { prompt: "and then run the tests" };
const noopRestore = (): void => {};

interface HarnessProps {
  readonly settlement: TurnSettlement | "idle";
  readonly threadKey: string;
  readonly restore?: (message: Message) => void;
}

function harness(input: {
  readonly send: (message: Message) => Promise<boolean>;
  readonly restore?: (message: Message) => void;
}) {
  const initialProps: HarnessProps =
    input.restore === undefined
      ? { settlement: "running", threadKey: "thread-a" }
      : { settlement: "running", threadKey: "thread-a", restore: input.restore };
  return renderHook(
    (props: HarnessProps) =>
      useSteeredSend<Message>({
        threadKey: props.threadKey,
        settlement: props.settlement,
        send: input.send,
        restore: props.restore ?? input.restore ?? noopRestore,
      }),
    { initialProps },
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

  it("does not restore a message when an in-flight send succeeds after leaving the thread", async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const restoreA = vi.fn();
    const restoreB = vi.fn();
    const { rerender, result } = harness({ send, restore: restoreA });

    act(() => {
      result.current.steer(message);
    });
    rerender({ settlement: "completed", threadKey: "thread-a", restore: restoreA });
    await waitFor(() => expect(send).toHaveBeenCalledWith(message));

    rerender({ settlement: "running", threadKey: "thread-b", restore: restoreB });
    expect(restoreA).not.toHaveBeenCalled();
    expect(restoreB).not.toHaveBeenCalled();

    act(() => {
      resolveSend?.(true);
    });
    await waitFor(() => expect(result.current.pending).toBeUndefined());
    expect(restoreA).not.toHaveBeenCalled();
    expect(restoreB).not.toHaveBeenCalled();
  });

  it("restores through the origin callback when an in-flight send is refused after leaving the thread", async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const restoreA = vi.fn();
    const restoreB = vi.fn();
    const { rerender, result } = harness({ send, restore: restoreA });

    act(() => {
      result.current.steer(message);
    });
    rerender({ settlement: "completed", threadKey: "thread-a", restore: restoreA });
    await waitFor(() => expect(send).toHaveBeenCalledWith(message));

    rerender({ settlement: "running", threadKey: "thread-b", restore: restoreB });
    expect(restoreA).not.toHaveBeenCalled();
    expect(restoreB).not.toHaveBeenCalled();

    act(() => {
      resolveSend?.(false);
    });
    await waitFor(() => expect(restoreA).toHaveBeenCalledOnce());
    expect(restoreA).toHaveBeenCalledWith(message);
    expect(restoreB).not.toHaveBeenCalled();
  });

  it("restores through the origin callback when an in-flight send throws after leaving the thread", async () => {
    let rejectSend: ((reason: Error) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<boolean>((_, reject) => {
          rejectSend = reject;
        }),
    );
    const restoreA = vi.fn();
    const restoreB = vi.fn();
    const { rerender, result } = harness({ send, restore: restoreA });

    act(() => {
      result.current.steer(message);
    });
    rerender({ settlement: "completed", threadKey: "thread-a", restore: restoreA });
    await waitFor(() => expect(send).toHaveBeenCalledWith(message));

    rerender({ settlement: "running", threadKey: "thread-b", restore: restoreB });
    expect(restoreA).not.toHaveBeenCalled();
    expect(restoreB).not.toHaveBeenCalled();

    act(() => {
      rejectSend?.(new Error("send failed"));
    });
    await waitFor(() => expect(restoreA).toHaveBeenCalledOnce());
    expect(restoreA).toHaveBeenCalledWith(message);
    expect(restoreB).not.toHaveBeenCalled();
  });

  it("does not restore a message when an in-flight send succeeds after its composer unmounts", async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const restore = vi.fn();
    const { rerender, result, unmount } = harness({ send, restore });

    act(() => {
      result.current.steer(message);
    });
    // A settled turn starts the ordinary send while the composer is mounted.
    rerender({ settlement: "completed", threadKey: "thread-a" });
    await waitFor(() => expect(send).toHaveBeenCalledWith(message));
    unmount();
    expect(restore).not.toHaveBeenCalled();

    await act(async () => {
      resolveSend?.(true);
      await Promise.resolve();
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores through the origin callback when an in-flight send is refused after its composer unmounts", async () => {
    let resolveSend: ((sent: boolean) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const restore = vi.fn();
    const { rerender, result, unmount } = harness({ send, restore });

    act(() => {
      result.current.steer(message);
    });
    rerender({ settlement: "completed", threadKey: "thread-a" });
    await waitFor(() => expect(send).toHaveBeenCalledWith(message));
    unmount();
    expect(restore).not.toHaveBeenCalled();

    await act(async () => {
      resolveSend?.(false);
      await Promise.resolve();
    });
    await waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(restore).toHaveBeenCalledWith(message);
  });

  it("restores through the thread callback that accepted the message", async () => {
    const send = vi.fn(async () => true);
    const restoreA = vi.fn();
    const restoreB = vi.fn();
    const { rerender, result } = renderHook(
      (props: { threadKey: string; restore: (message: Message) => void }) =>
        useSteeredSend<Message>({
          threadKey: props.threadKey,
          settlement: "running",
          send,
          restore: props.restore,
        }),
      { initialProps: { threadKey: "thread-a", restore: restoreA } },
    );

    act(() => {
      result.current.steer(message);
    });
    rerender({ threadKey: "thread-b", restore: restoreB });

    await waitFor(() => expect(restoreA).toHaveBeenCalledWith(message));
    expect(restoreB).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("restores a waiting message when its composer unmounts", async () => {
    const send = vi.fn(async () => true);
    const restore = vi.fn();
    const { result, unmount } = harness({ send, restore });

    act(() => {
      result.current.steer(message);
    });
    unmount();

    await waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(restore).toHaveBeenCalledWith(message);
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
