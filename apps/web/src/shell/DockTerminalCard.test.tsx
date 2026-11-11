import { CodeClientFailure } from "@octant/client-runtime/code-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const mounted: { interactive: boolean; fontSize: number | undefined; outputs: string[] }[] = [];
  const runtime: XtermAdapterRuntime = {
    mount: (_element, options) => {
      const record = {
        interactive: options.interactive,
        fontSize: options.typography?.fontSize,
        outputs: [options.output],
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
  const onClose = vi.fn();
  const view = render(
    <DockTerminalCard
      checkoutId={"checkout" in options ? options.checkout : checkoutId}
      client={client}
      loadRuntime={runtime.load}
      onClose={onClose}
      onExpand={onExpand}
      threadId={threadId}
    />,
  );
  return { ...view, client, onClose, onExpand, operations, runtime, stream };
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
    const { stream, onClose } = setup();
    stream.fail(new CodeClientFailure({ category: "unavailable", message: "Too many streams." }));
    expect(await screen.findByText("Preview unavailable")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close Terminal" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("aborts its stream when it goes away", async () => {
    const { stream, unmount, client } = setup();
    stream.push({ text: "x", replace: true });
    await waitFor(() => expect(client.watchTerminal).toHaveBeenCalledOnce());
    expect(stream.aborted).toBe(false);
    await act(async () => unmount());
    expect(stream.aborted).toBe(true);
  });
});
