import { CodeClientFailure } from "@octant/client-runtime/code-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { XtermAdapterRuntime } from "../code/XtermTerminalAdapter";
import { DockTerminalCard } from "./DockTerminalCard";

const threadId = "40000000-0000-4000-8000-000000000001" as CodeThreadId;
const checkoutId = "41000000-0000-4000-8000-000000000001" as CodeCheckoutId;

/** A live stream the test feeds by hand and that ends when its signal aborts. */
function streamOf() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let failure: unknown;
  return {
    get aborted() {
      return signal?.aborted === true;
    },
    push(frame: {
      readonly text: string;
      readonly replace?: boolean;
      readonly state?: "running" | "exited" | "interrupted";
      readonly exitCode?: number | null;
    }) {
      queue.push({
        terminalId: threadId,
        replace: false,
        characters: 0,
        state: "running",
        ...frame,
      });
      wake?.();
    },
    fail(error: unknown) {
      failure = error;
      wake?.();
    },
    watch(_request: unknown, abort: AbortSignal): AsyncIterable<never> {
      signal = abort;
      return {
        async *[Symbol.asyncIterator]() {
          while (!abort.aborted) {
            if (failure !== undefined) throw failure;
            const frame = queue.shift();
            if (frame !== undefined) {
              yield frame as never;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              abort.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      };
    },
  };
}

function fakeRuntime() {
  const mounted: {
    interactive: boolean;
    fontSize: number | undefined;
    outputs: string[];
    onData: (data: string) => void;
    onResize: (columns: number, rows: number) => void;
  }[] = [];
  const runtime: XtermAdapterRuntime = {
    mount: (_element, options) => {
      const record = {
        interactive: options.interactive,
        fontSize: options.typography?.fontSize,
        outputs: [options.output],
        onData: options.onData,
        onResize: options.onResize,
      };
      mounted.push(record);
      return {
        dispose: () => undefined,
        focus: () => undefined,
        setInteractive: () => undefined,
        setOutput: (output: string) => {
          record.outputs.push(output);
        },
      };
    },
  };
  return { mounted, load: async () => runtime };
}

function setup(
  options: {
    readonly state?: "running" | "exited" | "interrupted";
    readonly inspectFails?: unknown;
    readonly checkout?: CodeCheckoutId | undefined;
  } = {},
) {
  const stream = streamOf();
  const operations = {
    executeOperation: vi.fn(),
    subscribeOperation: vi.fn(),
    operationContent: vi.fn(),
  };
  const client = {
    ...operations,
    inspectTerminal: vi.fn(async (request: { readonly terminalId: unknown }) => {
      if (options.inspectFails !== undefined) throw options.inspectFails;
      return { terminalId: request.terminalId, state: options.state ?? "running" };
    }),
    watchTerminal: vi.fn((request: unknown, signal: AbortSignal) => stream.watch(request, signal)),
  } as unknown as Pick<CodeClient, "inspectTerminal" | "watchTerminal">;
  const runtime = fakeRuntime();
  const onExpand = vi.fn();
  const onHide = vi.fn();
  const view = render(
    <DockTerminalCard
      checkoutId={"checkout" in options ? options.checkout : checkoutId}
      client={client}
      loadRuntime={runtime.load}
      onHide={onHide}
      onExpand={onExpand}
      threadId={threadId}
    />,
  );
  return { ...view, client, onHide, onExpand, operations, runtime, stream };
}

const tailOf = (runtime: ReturnType<typeof fakeRuntime>) =>
  runtime.mounted[0]?.outputs.at(-1) ?? "";

describe("DockTerminalCard", () => {
  it("reads the shell's state once and follows its stream, and never attaches, starts or writes", async () => {
    const { client, operations, stream } = setup();
    stream.push({ text: "$ npm test\r\n", replace: true });
    await screen.findByRole("region", { name: "Minimised Terminal" });
    await waitFor(() => expect(client.watchTerminal).toHaveBeenCalledOnce());
    stream.push({ text: "ok\r\n" });
    await waitFor(() => expect(client.inspectTerminal).toHaveBeenCalledOnce());
    expect(client.inspectTerminal).toHaveBeenCalledWith({
      threadId,
      checkoutId,
      terminalId: threadId,
    });
    // The first request has no offset, so the host answers with the current tail.
    expect(vi.mocked(client.watchTerminal!).mock.calls[0]?.[0]).toEqual({
      threadId,
      checkoutId,
      terminalId: threadId,
    });
    expect(operations.executeOperation).not.toHaveBeenCalled();
    expect(operations.subscribeOperation).not.toHaveBeenCalled();
  });

  it("shows the tail and appends live frames in a read-only terminal at the smallest type", async () => {
    const { runtime, stream } = setup();
    stream.push({ text: "build started\r\n", replace: true });
    await waitFor(() => expect(runtime.mounted).toHaveLength(1));
    expect(runtime.mounted[0]?.interactive).toBe(false);
    expect(runtime.mounted[0]?.fontSize).toBe(8);
    await waitFor(() => expect(tailOf(runtime)).toBe("build started\r\n"));
    stream.push({ text: "build done\r\n" });
    await waitFor(() => expect(tailOf(runtime)).toBe("build started\r\nbuild done\r\n"));
  });

  it("marks new output with a quiet named dot, and clears it when the pointer or focus arrives", async () => {
    const user = userEvent.setup();
    const { stream } = setup();
    stream.push({ text: "tail", replace: true });
    const card = await screen.findByRole("region", { name: "Minimised Terminal" });
    await waitFor(() => expect(card).toBeVisible());
    // The tail the shell already had is not news.
    await new Promise((done) => setTimeout(done, 30));
    expect(screen.queryByRole("img", { name: "New output" })).not.toBeInTheDocument();

    stream.push({ text: " more" });
    expect(await screen.findByRole("img", { name: "New output" })).toBeInTheDocument();
    fireEvent.pointerEnter(card);
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "New output" })).not.toBeInTheDocument(),
    );

    // Output while the pointer is on the card has been seen.
    stream.push({ text: " seen" });
    await new Promise((done) => setTimeout(done, 30));
    expect(screen.queryByRole("img", { name: "New output" })).not.toBeInTheDocument();

    fireEvent.pointerLeave(card);
    stream.push({ text: " later" });
    expect(await screen.findByRole("img", { name: "New output" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Terminal" }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "New output" })).not.toBeInTheDocument(),
    );
  });

  it("says no terminal is running when the thread has none, and expanding still opens the tool", async () => {
    const user = userEvent.setup();
    const { client, onExpand } = setup({
      inspectFails: new CodeClientFailure(
        { category: "unavailable", message: "No terminal." },
        404,
      ),
    });
    expect(await screen.findByText("No terminal running")).toBeVisible();
    expect(client.watchTerminal).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Show Terminal, live preview" }));
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("says no terminal is running for a thread with no checkout to ask about", async () => {
    const { client } = setup({ checkout: undefined });
    expect(await screen.findByText("No terminal running")).toBeVisible();
    expect(client.inspectTerminal).not.toHaveBeenCalled();
  });

  it("says in its head that the shell exited, with its code, and that it was interrupted", async () => {
    const { stream, unmount } = setup({ state: "exited" });
    stream.push({ text: "bye\r\n", replace: true, state: "exited", exitCode: 1 });
    expect(await screen.findByText("Exited (1)")).toBeVisible();
    unmount();
    const interrupted = setup({ state: "interrupted" });
    interrupted.stream.push({ text: "", replace: true, state: "interrupted" });
    expect(await screen.findByText("Interrupted")).toBeVisible();
  });

  it("says the preview is unavailable when the host refuses the stream, and the card stays usable", async () => {
    const user = userEvent.setup();
    const { stream, onHide } = setup();
    stream.fail(new CodeClientFailure({ category: "unavailable", message: "Too many streams." }));
    expect(await screen.findByText("Preview unavailable")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide Terminal card" }));
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("aborts its stream when it goes away", async () => {
    const { stream, unmount, client } = setup();
    stream.push({ text: "x", replace: true });
    await waitFor(() => expect(client.watchTerminal).toHaveBeenCalledOnce());
    expect(stream.aborted).toBe(false);
    await act(async () => unmount());
    expect(stream.aborted).toBe(true);
  });

  it("never sends a resize or any input to the shell, whatever its terminal engine reports", async () => {
    const { operations, runtime, stream } = setup();
    stream.push({ text: "x", replace: true });
    await waitFor(() => expect(runtime.mounted).toHaveLength(1));
    runtime.mounted[0]?.onResize(80, 6);
    runtime.mounted[0]?.onData("rm -rf\r");
    expect(operations.executeOperation).not.toHaveBeenCalled();
  });

  it("shows loading, never the previous thread's text, when the thread changes", async () => {
    const stream = streamOf();
    const other = streamOf();
    const otherThread = "40000000-0000-4000-8000-000000000002" as CodeThreadId;
    const client = {
      inspectTerminal: vi.fn(async (request: { readonly terminalId: unknown }) => ({
        terminalId: request.terminalId,
        state: "running" as const,
      })),
      watchTerminal: vi.fn((request: { readonly threadId: unknown }, signal: AbortSignal) =>
        (request.threadId === threadId ? stream : other).watch(request, signal),
      ),
    } as unknown as Pick<CodeClient, "inspectTerminal" | "watchTerminal">;
    const runtime = fakeRuntime();
    const ui = (id: CodeThreadId) => (
      <DockTerminalCard
        checkoutId={checkoutId}
        client={client}
        loadRuntime={runtime.load}
        onExpand={vi.fn()}
        onHide={vi.fn()}
        threadId={id}
      />
    );
    const { rerender, container } = render(ui(threadId));
    stream.push({ text: "SECRET of thread one", replace: true });
    await waitFor(() => expect(tailOf(runtime)).toBe("SECRET of thread one"));
    stream.push({ text: "!" });
    await screen.findByRole("img", { name: "New output" });

    rerender(ui(otherThread));
    // Until the other thread's own tail arrives: a skeleton, no text, no mark.
    expect(container.querySelector(".skeleton")).not.toBeNull();
    expect(screen.queryByRole("img", { name: "New output" })).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("SECRET");
    other.push({ text: "other thread", replace: true });
    await waitFor(() => expect(runtime.mounted.at(-1)?.outputs.at(-1)).toBe("other thread"));
  });

  it("rewrites its terminal rarely, not on every frame, when a shell is chatty", async () => {
    const { runtime, stream } = setup();
    stream.push({ text: "start\r\n", replace: true });
    await waitFor(() => expect(runtime.mounted).toHaveLength(1));
    for (let index = 0; index < 1500; index += 1) {
      stream.push({ text: `line ${index} of the build log\r\n` });
      if (index % 100 === 0) await new Promise((done) => setTimeout(done, 20));
    }
    await waitFor(() => expect(tailOf(runtime)).toContain("line 1499 of the build log"));
    const outputs = runtime.mounted[0]?.outputs ?? [];
    let rewrites = 0;
    for (let index = 1; index < outputs.length; index += 1) {
      if (!(outputs[index] ?? "").startsWith(outputs[index - 1] ?? "")) rewrites += 1;
    }
    // About 40 KiB came through; with a few KiB kept that is a handful of
    // rewrites, never one per frame, and the tail is small.
    expect(rewrites).toBeLessThan(15);
    expect(outputs.length).toBeLessThan(400);
    expect((outputs.at(-1) ?? "").length).toBeLessThan(10 * 1024);
    // A cut falls on a line start, so no sequence is cut at its head.
    for (const output of outputs.slice(1)) expect(output).toMatch(/^(start|line \d+ )/);
  });
});

describe("DockTerminalCard asking again", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function retrying(
    inspect: () => Promise<{ readonly terminalId: unknown; readonly state: "running" | "exited" }>,
    watch: (signal: AbortSignal) => AsyncIterable<unknown> = () =>
      streamOf().watch(undefined, new AbortController().signal),
  ) {
    const client = {
      inspectTerminal: vi.fn(inspect),
      watchTerminal: vi.fn((_request: unknown, signal: AbortSignal) => watch(signal)),
    } as unknown as Pick<CodeClient, "inspectTerminal" | "watchTerminal">;
    const runtime = fakeRuntime();
    const view = render(
      <DockTerminalCard
        checkoutId={checkoutId}
        client={client}
        loadRuntime={runtime.load}
        onExpand={vi.fn()}
        onHide={vi.fn()}
        threadId={threadId}
      />,
    );
    return { ...view, client, runtime };
  }
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const none = () =>
    Promise.reject(
      new CodeClientFailure({ category: "unavailable", message: "No terminal." }, 404),
    );

  it("picks up a shell that starts after the card said no terminal was running", async () => {
    vi.useFakeTimers();
    let started = false;
    const stream = streamOf();
    const { client, runtime } = retrying(
      async () => (started ? { terminalId: threadId, state: "running" as const } : none()),
      (signal) => stream.watch(undefined, signal),
    );
    await advance(0);
    expect(screen.getByText("No terminal running")).toBeVisible();
    started = true;
    stream.push({ text: "$ ready\r\n", replace: true });
    await advance(5_000);
    await advance(100);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(2);
    expect(runtime.mounted[0]?.outputs.at(-1)).toBe("$ ready\r\n");
    expect(screen.queryByText("No terminal running")).not.toBeInTheDocument();
  });

  it("gives up after six tries with 5 s doubling to 60 s, and says the preview ended", async () => {
    vi.useFakeTimers();
    const { client } = retrying(none);
    await advance(0);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(1);
    // 5, 10, 20, 40, 60 and 60 seconds apart.
    let waited = 0;
    for (const [index, delay] of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000].entries()) {
      await advance(delay - 1);
      expect(client.inspectTerminal).toHaveBeenCalledTimes(index + 1);
      await advance(1);
      expect(client.inspectTerminal).toHaveBeenCalledTimes(index + 2);
      waited += delay;
    }
    expect(waited).toBe(195_000);
    await advance(0);
    expect(screen.getByText("Preview ended")).toBeVisible();
    await advance(600_000);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(7);
  });

  it("never loops tightly when the host keeps ending the stream", async () => {
    vi.useFakeTimers();
    const { client } = retrying(
      async () => ({ terminalId: threadId, state: "running" as const }),
      () => ({
        async *[Symbol.asyncIterator]() {
          // Ends at once, with no frame: a stream the host closed.
        },
      }),
    );
    await advance(4_000);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(1);
    expect(client.watchTerminal).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of the host while the window is hidden, and again when it is back", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const { client } = retrying(none);
    await advance(0);
    hidden.mockReturnValue("hidden");
    await advance(30_000);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(0);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(2);
  });

  it("starts counting again once frames flow after a retry", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const { client } = retrying(
      async () => {
        attempt += 1;
        if (attempt <= 2) return none();
        return { terminalId: threadId, state: "running" as const };
      },
      () => ({
        async *[Symbol.asyncIterator]() {
          yield { terminalId: threadId, text: "a", replace: true, characters: 1, state: "running" };
          yield {
            terminalId: threadId,
            text: "b",
            replace: false,
            characters: 2,
            state: "running",
          };
        },
      }),
    );
    await advance(0);
    await advance(5_000);
    await advance(10_000);
    // The third read gets frames; the next retry waits the first delay again.
    expect(client.inspectTerminal).toHaveBeenCalledTimes(3);
    await advance(4_999);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(client.inspectTerminal).toHaveBeenCalledTimes(4);
  });
});
