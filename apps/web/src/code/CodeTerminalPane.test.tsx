import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { XtermAdapterRuntime } from "./XtermTerminalAdapter";
import { CodeClientFailure } from "@octant/client-runtime/code-client";
import { CodeTerminalPane } from "./CodeTerminalPane";
import { codeClient, ids, scope, terminalResult } from "./CodeDeliveryPane.test-fixtures";

const codeStyles = readFileSync(resolve(process.cwd(), "src/styles/code.css"), "utf8");

describe("CodeTerminalPane", () => {
  it("lets the emulator fill the pane without a second terminal toolbar", () => {
    expect(codeStyles).not.toContain(".code-terminal-pane .code-delivery-pane__toolbar {");
    expect(codeStyles).toContain(
      ".code-terminal-pane__context-menu {\n  display: block;\n  width: 100%;\n  height: 100%;",
    );
    expect(codeStyles).toContain(
      '.code-terminal-pane > [aria-label="Repository terminal"] {\n  min-height: 0;',
    );
    expect(codeStyles).not.toContain(
      '.code-terminal-pane > [aria-label="Repository terminal"] {\n  min-height: 0;\n  flex: 1;\n  padding: var(--oct-space-3)',
    );
    expect(codeStyles).toContain("overflow: hidden;");
  });

  it("puts the terminal canvas directly under the tool tabs and groups secondary actions", async () => {
    const onAddSelectionToChat = vi.fn();
    const onOpenAnotherTerminal = vi.fn();
    render(
      <CodeTerminalPane
        client={codeClient({ evidence: "ready" })}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={xtermRuntime("selected output").loadRuntime}
        onAddSelectionToChat={onAddSelectionToChat}
        onOpenAnotherTerminal={onOpenAnotherTerminal}
        result={terminalResult}
        scope={scope}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Repository terminal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More terminal actions" })).toBeVisible();
    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    expect(await screen.findByRole("menuitem", { name: "Add selection to chat" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "New terminal" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Stop terminal" })).toBeVisible();
  });

  it("loads authoritative replay and routes input and resize through codeClient", async () => {
    const client = codeClient({ evidence: "ready\n" });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.options?.output).toBe("ready\n"));
    runtime.options?.onData("bun test\r");
    runtime.options?.onResize(120, 40);

    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(2));
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "write-terminal", data: "bun test\r" }),
    );
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "resize-terminal", columns: 120, rows: 40 }),
    );
  });

  it("makes Plan replay read-only and shows truncation and exit evidence", async () => {
    const client = codeClient({ evidence: "older output" });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="plan"
        loadRuntime={runtime.loadRuntime}
        result={{
          ...terminalResult,
          state: "exited",
          exitCode: 2,
          transcript: { ...terminalResult.transcript!, truncated: true },
        }}
        scope={scope}
      />,
    );

    expect(await screen.findByText(/output is truncated/i)).toBeVisible();
    expect(screen.getByText(/Exited with code 2/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /restart|stop/i })).not.toBeInTheDocument();
    await waitFor(() => expect(runtime.options?.interactive).toBe(false));
    runtime.options?.onData("ignored");
    fireEvent.click(screen.getByRole("region", { name: "Repository terminal" }));
    expect(client.executeOperation).not.toHaveBeenCalled();
  });

  it("keeps a running terminal interactive for input and resize", async () => {
    const client = codeClient({ evidence: "ready" });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("pwd\r");
    runtime.options?.onResize(120, 40);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(2));
  });

  it("keeps the terminal adapter mounted when an authoritative resize result arrives", async () => {
    const client = codeClient({ evidence: "ready" });
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...terminalResult,
      operationId: "70000000-0000-4000-8000-000000000002",
    });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onResize(120, 40);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.operationContent).toHaveBeenCalledOnce();
    expect(runtime.loadRuntime).toHaveBeenCalledOnce();
  });

  it("coalesces adjacent printable keystrokes into one terminal write", async () => {
    const client = codeClient({ evidence: "ready" });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("p");
    runtime.options?.onData("w");
    runtime.options?.onData("d");
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    expect(client.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "write-terminal", data: "pwd" }),
    );
  });

  it("keeps printable keystrokes that arrive during an in-flight write as one follow-up write", async () => {
    const client = codeClient({ evidence: "ready" });
    let resolveFirst: ((value: typeof terminalResult) => void) | undefined;
    (client.executeOperation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(terminalResult);
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("a");
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    runtime.options?.onData("b");
    runtime.options?.onData("c");
    runtime.options?.onData("d");
    expect(client.executeOperation).toHaveBeenCalledOnce();
    resolveFirst?.(terminalResult);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(2));
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "write-terminal", data: "a" }),
    );
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "write-terminal", data: "bcd" }),
    );
  });

  it("does not merge a newline, paste, or control key into a printable burst", async () => {
    const client = codeClient({ evidence: "ready" });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("e");
    runtime.options?.onData("c");
    runtime.options?.onData("h");
    runtime.options?.onData("o");
    runtime.options?.onData("\r");
    runtime.options?.onData("y");
    runtime.options?.onData("pasted");
    runtime.options?.onData("z");
    runtime.options?.onData("\u0003");
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(6));
    expect(terminalWriteData(client)).toEqual(["echo", "\r", "y", "pasted", "z", "\u0003"]);
  });

  it("flushes coalesced keystrokes before a resize", async () => {
    const client = codeClient({ evidence: "ready" });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("l");
    runtime.options?.onData("s");
    runtime.options?.onResize(120, 40);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(2));
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "write-terminal", data: "ls" }),
    );
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "resize-terminal", columns: 120, rows: 40 }),
    );
  });

  it("preserves a hundred printable characters without loss, reordering, or duplication", async () => {
    const client = codeClient({ evidence: "ready" });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    const typed = Array.from({ length: 100 }, (_, index) =>
      "abcdefghijklmnopqrstuvwxyz".charAt(index % 26),
    ).join("");
    for (const key of typed) runtime.options?.onData(key);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    expect(terminalWriteData(client).join("")).toBe(typed);
  });

  it("keeps buffered input bound to the terminal that received it", async () => {
    const client = codeClient({ evidence: "ready" });
    let resolveFirst: ((value: typeof terminalResult) => void) | undefined;
    (client.executeOperation as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise<typeof terminalResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(terminalResult);
    const runtime = xtermRuntime();
    const { rerender } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("a");
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    rerender(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        result={{ ...terminalResult, terminalId: "80000000-0000-4000-8000-000000000002" as never }}
        scope={scope}
      />,
    );
    runtime.options?.onData("b");
    runtime.options?.onData("c");
    resolveFirst?.(terminalResult);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(2));
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "write-terminal", data: "a", terminalId: ids.terminal }),
    );
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "write-terminal",
        data: "bc",
        terminalId: "80000000-0000-4000-8000-000000000002",
      }),
    );
  });

  it("turns a disconnected input command into an actionable pane error", async () => {
    const client = codeClient({ evidence: "ready" });
    (client.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("transport closed"),
    );
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("input");
    expect(await screen.findByRole("alert")).toHaveTextContent(/terminal command failed/i);
  });

  it("names the transport failure and the lost keystroke when a terminal write is refused", async () => {
    const client = codeClient({ evidence: "ready" });
    (client.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new CodeClientFailure({
        category: "disconnected",
        message: "Octant Code service is unavailable.",
      }),
    );
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("x");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Octant Code service is unavailable\..*Retype the last keystroke/s,
    );
  });

  it("does not reload cumulative terminal replay from input command results", async () => {
    const client = codeClient();
    (client.operationContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new TextEncoder().encode("before\n"))
      .mockResolvedValueOnce(new TextEncoder().encode("after\n"));
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...terminalResult,
      operationId: "70000000-0000-4000-8000-000000000002",
      transcript: {
        ...terminalResult.transcript!,
        contentId: "30000000-0000-4000-8000-000000000002",
      },
    });
    const runtime = xtermRuntime();
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.options?.output).toBe("before\n"));
    runtime.options?.onData("echo after\r");
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    expect(client.operationContent).toHaveBeenCalledOnce();
    expect(runtime.setOutput).not.toHaveBeenCalledWith("after\n");
    expect(runtime.loadRuntime).toHaveBeenCalledOnce();
  });

  it("streams asynchronous terminal output without requiring a second command", async () => {
    const client = codeClient();
    (client.operationContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new TextEncoder().encode("ready\n"))
      .mockResolvedValueOnce(new TextEncoder().encode("TERMINAL_OK\n"));
    async function* outputFrames(signal: AbortSignal) {
      yield {
        threadId: ids.thread,
        operationId: ids.operation,
        cursor: 2,
        occurredAt: "2026-08-06T00:00:00.000Z",
        event: {
          kind: "terminal-output",
          terminalId: ids.terminal,
          content: {
            contentId: "30000000-0000-4000-8000-000000000002",
            digest: "d".repeat(64),
            byteLength: 18,
          },
        },
      } as never;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    (client.subscribeOperation as ReturnType<typeof vi.fn>).mockImplementation(
      (_threadId, _operationId, _cursor, signal) => outputFrames(signal),
    );
    const runtime = xtermRuntime();

    const { unmount } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.setOutput).toHaveBeenCalledWith("ready\nTERMINAL_OK\n"));
    expect(client.executeOperation).not.toHaveBeenCalled();
    unmount();
  });

  it("uses text inlined in the stream instead of reading each chunk again", async () => {
    const client = codeClient();
    (client.operationContent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new TextEncoder().encode("ready\n"),
    );
    async function* outputFrames(signal: AbortSignal) {
      yield { ...terminalOutputFrame(2), displayText: "TERMINAL_OK\n" } as never;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    (client.subscribeOperation as ReturnType<typeof vi.fn>).mockImplementation(
      (_threadId, _operationId, _cursor, signal) => outputFrames(signal),
    );
    const runtime = xtermRuntime();

    const { unmount } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.setOutput).toHaveBeenCalledWith("ready\nTERMINAL_OK\n"));
    expect(client.operationContent).toHaveBeenCalledOnce();
    unmount();
  });

  it("loads replay before subscribing so a slower baseline cannot overwrite live output", async () => {
    const client = codeClient();
    let resolveReplay: ((value: Uint8Array) => void) | undefined;
    (client.operationContent as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise<Uint8Array>((resolve) => {
            resolveReplay = resolve;
          }),
      )
      .mockResolvedValueOnce(new TextEncoder().encode("TERMINAL_OK\n"));
    async function* outputFrames(signal: AbortSignal) {
      yield terminalOutputFrame(2);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    (client.subscribeOperation as ReturnType<typeof vi.fn>).mockImplementation(
      (_threadId, _operationId, _cursor, signal) => outputFrames(signal),
    );
    const runtime = xtermRuntime();

    const { unmount } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(client.operationContent).toHaveBeenCalledOnce());
    expect(client.subscribeOperation).not.toHaveBeenCalled();
    resolveReplay?.(new TextEncoder().encode("ready\n"));
    await waitFor(() => expect(runtime.setOutput).toHaveBeenLastCalledWith("ready\nTERMINAL_OK\n"));
    unmount();
  });

  it("keeps accumulated live output when the terminal exits naturally", async () => {
    const client = codeClient();
    (client.operationContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new TextEncoder().encode("ready\n"))
      .mockResolvedValueOnce(new TextEncoder().encode("TERMINAL_OK\n"));
    async function* outputFrames() {
      yield terminalOutputFrame(2);
      yield {
        threadId: ids.thread,
        operationId: ids.operation,
        cursor: 3,
        occurredAt: "2026-08-06T00:00:01.000Z",
        event: {
          kind: "terminal-state-changed",
          terminalId: ids.terminal,
          state: "exited",
          exitCode: 0,
        },
      } as never;
    }
    (client.subscribeOperation as ReturnType<typeof vi.fn>).mockImplementation(() =>
      outputFrames(),
    );
    const runtime = xtermRuntime();

    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    expect(await screen.findByText("Exited with code 0")).toBeVisible();
    await waitFor(() => expect(runtime.setOutput).toHaveBeenLastCalledWith("ready\nTERMINAL_OK\n"));
    expect(client.operationContent).toHaveBeenCalledTimes(2);
  });

  it("paints output from the live stream without reading the journal", async () => {
    const client = codeClient({ evidence: "ready\n" });
    const frames = [
      { text: "ready\n", replace: true, characters: 6, state: "running" },
      { text: "TERMINAL_OK\n", replace: false, characters: 18, state: "running" },
    ];
    (client.watchTerminal as ReturnType<typeof vi.fn>).mockImplementation(async function* (
      _request: unknown,
      signal: AbortSignal,
    ) {
      for (const frame of frames) yield { terminalId: ids.terminal, ...frame } as never;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const runtime = xtermRuntime();

    const { unmount } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.setOutput).toHaveBeenCalledWith("ready\nTERMINAL_OK\n"));
    expect(client.watchTerminal).toHaveBeenCalledWith(
      { threadId: scope.threadId, checkoutId: scope.checkoutId, terminalId: ids.terminal },
      expect.any(AbortSignal),
    );
    expect(client.subscribeOperation).not.toHaveBeenCalled();
    unmount();
  });

  it("resumes a dropped live stream from the last offset it received", async () => {
    const client = codeClient({ evidence: "" });
    const requests: unknown[] = [];
    let attempt = 0;
    (client.watchTerminal as ReturnType<typeof vi.fn>).mockImplementation(async function* (
      request: unknown,
      signal: AbortSignal,
    ) {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) {
        yield {
          terminalId: ids.terminal,
          text: "one\n",
          replace: true,
          characters: 4,
          state: "running",
        } as never;
        return;
      }
      yield {
        terminalId: ids.terminal,
        text: "two\n",
        replace: false,
        characters: 8,
        state: "running",
      } as never;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const runtime = xtermRuntime();

    const { unmount } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.setOutput).toHaveBeenCalledWith("one\ntwo\n"));
    expect(requests[1]).toMatchObject({ afterCharacters: 4 });
    unmount();
  });

  it("reads the journal once the host refuses the live stream, without showing a byte twice", async () => {
    const client = codeClient();
    (client.operationContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new TextEncoder().encode("ready\n"))
      .mockResolvedValueOnce(new TextEncoder().encode("TERMINAL_OK\n"));
    let attempt = 0;
    (client.watchTerminal as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      attempt += 1;
      // The stream delivers a frame, drops, and the host then refuses it.
      if (attempt === 1) {
        yield {
          terminalId: ids.terminal,
          text: "live\n",
          replace: true,
          characters: 5,
          state: "running",
        } as never;
        return;
      }
      throw new CodeClientFailure({ category: "unauthorized", message: "Refused." });
    });
    (client.subscribeOperation as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      (async function* () {
        yield terminalOutputFrame(2);
      })(),
    );
    const runtime = xtermRuntime();

    const { unmount } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.setOutput).toHaveBeenLastCalledWith("ready\nTERMINAL_OK\n"));
    unmount();
  });

  it("shows the shell's exit from the live stream and stops reading", async () => {
    const client = codeClient({ evidence: "" });
    (client.watchTerminal as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        terminalId: ids.terminal,
        text: "bye\n",
        replace: true,
        characters: 4,
        state: "running",
      } as never;
      yield {
        terminalId: ids.terminal,
        text: "",
        replace: false,
        characters: 4,
        state: "exited",
        exitCode: 2,
      } as never;
    });
    const runtime = xtermRuntime();

    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    expect(await screen.findByText("Exited with code 2")).toBeVisible();
    expect(runtime.setOutput).toHaveBeenLastCalledWith("bye\n");
    expect(client.subscribeOperation).not.toHaveBeenCalled();
  });

  it("replays a terminal-output frame when its content fetch fails transiently", async () => {
    const client = codeClient();
    (client.operationContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new TextEncoder().encode("ready\n"))
      .mockRejectedValueOnce(new Error("temporary content failure"))
      .mockResolvedValueOnce(new TextEncoder().encode("TERMINAL_OK\n"));
    async function* outputFrames(signal: AbortSignal) {
      yield terminalOutputFrame(2);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    (client.subscribeOperation as ReturnType<typeof vi.fn>).mockImplementation(
      (_threadId, _operationId, _cursor, signal) => outputFrames(signal),
    );
    const runtime = xtermRuntime();

    const { unmount } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(client.subscribeOperation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(runtime.setOutput).toHaveBeenLastCalledWith("ready\nTERMINAL_OK\n"));
    unmount();
  });

  it("stops running terminals and explicitly restarts terminal results", async () => {
    const client = codeClient();
    const operationIds = [
      "70000000-0000-4000-8000-000000000002",
      "70000000-0000-4000-8000-000000000003",
    ];
    const { rerender } = render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => operationIds.shift() as never}
        executionPolicy="full-access"
        restart={{
          columns: 120,
          createTerminalId: () => "80000000-0000-4000-8000-000000000002" as never,
          credentialRefs: ["OCTANT_TEST_TOKEN"],
          rows: 40,
        }}
        result={terminalResult}
        scope={scope}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop terminal" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "stop-terminal", terminalId: ids.terminal }),
      ),
    );

    rerender(
      <CodeTerminalPane
        client={client}
        createOperationId={() => operationIds.shift() as never}
        executionPolicy="full-access"
        restart={{
          columns: 120,
          createTerminalId: () => "80000000-0000-4000-8000-000000000002" as never,
          credentialRefs: ["OCTANT_TEST_TOKEN"],
          rows: 40,
        }}
        result={{ ...terminalResult, state: "interrupted" }}
        scope={scope}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart terminal" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith({
        kind: "start-terminal",
        operationId: "70000000-0000-4000-8000-000000000003",
        terminalId: "80000000-0000-4000-8000-000000000002",
        columns: 120,
        rows: 40,
        credentialRefs: ["OCTANT_TEST_TOKEN"],
        ...scope,
      }),
    );
  });

  it("adds the text selected in the terminal to the chat, fenced", async () => {
    const onAddSelectionToChat = vi.fn();
    const runtime = xtermRuntime("error: missing token\n");
    render(
      <CodeTerminalPane
        client={codeClient({ evidence: "ready" })}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        onAddSelectionToChat={onAddSelectionToChat}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.options).toBeDefined());
    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add selection to chat" }));

    expect(onAddSelectionToChat).toHaveBeenCalledWith("error: missing token\n");
  });

  it("says nothing is selected instead of adding an empty block to the chat", async () => {
    const onAddSelectionToChat = vi.fn();
    const runtime = xtermRuntime("   ");
    render(
      <CodeTerminalPane
        client={codeClient({ evidence: "ready" })}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={runtime.loadRuntime}
        onAddSelectionToChat={onAddSelectionToChat}
        result={terminalResult}
        scope={scope}
      />,
    );

    await waitFor(() => expect(runtime.options).toBeDefined());
    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add selection to chat" }));

    expect(onAddSelectionToChat).not.toHaveBeenCalled();
    expect(await screen.findByText(/Select terminal output first/i)).toBeVisible();
  });

  it("opens another terminal without disturbing this one", async () => {
    const onOpenAnotherTerminal = vi.fn();
    const client = codeClient({ evidence: "ready" });
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        loadRuntime={xtermRuntime().loadRuntime}
        onOpenAnotherTerminal={onOpenAnotherTerminal}
        result={terminalResult}
        scope={scope}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New terminal" }));

    expect(onOpenAnotherTerminal).toHaveBeenCalledTimes(1);
    expect(client.executeOperation).not.toHaveBeenCalled();
  });
});

describe("CodeTerminalPane Browser switch", () => {
  const restart = {
    columns: 100,
    createTerminalId: () => ids.terminal as never,
    credentialRefs: [],
    rows: 30,
  };
  const granted = {
    status: "granted",
    grantId: "90000000-0000-4000-8000-000000000001",
    threadId: ids.thread,
    terminalId: ids.terminal,
    issuedAt: "2026-10-14T09:00:00.000Z",
  } as const;

  function renderSwitch(
    client: ReturnType<typeof codeClient>,
    overrides: Partial<Parameters<typeof CodeTerminalPane>[0]> = {},
  ) {
    let next = 0;
    return render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => `70000000-0000-4000-8000-00000000010${next++}` as never}
        executionPolicy="approval-gated"
        loadRuntime={xtermRuntime().loadRuntime}
        offerBrowserGrant
        restart={restart}
        result={terminalResult}
        scope={scope}
        {...overrides}
      />,
    );
  }

  it("restarts the terminal with the Browser only after the person agrees, and shows it on from the host's answer", async () => {
    const client = codeClient({ evidence: "ready" });
    vi.mocked(client.executeOperation).mockImplementation(async (command) => {
      if (command.kind === "stop-terminal") {
        return {
          ...terminalResult,
          operationId: command.operationId,
          state: "interrupted",
        } as never;
      }
      if (command.kind === "start-terminal") {
        return {
          kind: "terminal-state",
          operationId: command.operationId,
          terminalId: command.terminalId,
          state: "running",
          browserGrant: granted,
        } as never;
      }
      return { kind: "operation-accepted", operationId: command.operationId } as never;
    });
    renderSwitch(client);
    expect(screen.queryByRole("status", { name: /Browser on/ })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Let this terminal use the Browser…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Let this terminal use the Browser?",
    });
    expect(dialog).toHaveTextContent("The terminal restarts, so anything running in it stops.");
    expect(dialog).toHaveTextContent(
      "The Octant app for macOS adds octant to this terminal's PATH",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.executeOperation).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Let this terminal use the Browser…" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Restart with the Browser" }));

    expect(await screen.findByText("Browser on")).toBeVisible();
    expect(screen.getByText(/If this window changes Project, start the CLI again/)).toBeVisible();
    const commands = vi.mocked(client.executeOperation).mock.calls.map(([command]) => command);
    expect(commands.map((command) => command.kind)).toEqual(["stop-terminal", "start-terminal"]);
    expect(commands[1]).toMatchObject({
      kind: "start-terminal",
      terminalId: ids.terminal,
      browserGrant: "on",
    });
  });

  it("shows a grant the host reports and switches it off without restarting the shell", async () => {
    const client = codeClient({ evidence: "ready" });
    vi.mocked(client.executeOperation).mockImplementation(
      async (command) =>
        ({
          kind: "terminal-state",
          operationId: command.operationId,
          terminalId: ids.terminal,
          state: "running",
          browserGrant: {
            ...granted,
            status: "revoked",
            reason: "switched-off",
            revokedAt: "2026-10-14T09:05:00.000Z",
          },
        }) as never,
    );
    renderSwitch(client, { result: { ...terminalResult, browserGrant: granted as never } });

    expect(screen.getByText("Browser on")).toBeVisible();
    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    expect(
      screen.queryByRole("menuitem", { name: "Let this terminal use the Browser…" }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Switch the Browser off" }));

    expect(await screen.findByText(/Browser off for this terminal/)).toHaveTextContent(
      "start the CLI again",
    );
    expect(screen.queryByText("Browser on")).not.toBeInTheDocument();
    expect(client.executeOperation).toHaveBeenCalledOnce();
    expect(client.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "revoke-terminal-browser-grant",
        terminalId: ids.terminal,
      }),
    );
  });

  it.each([
    [
      "not-local-window",
      "Only the person at a window on the host can let a terminal use the Browser.",
    ],
    [
      "thread-not-active",
      "This thread is archived or put away, so its terminal cannot use the Browser.",
    ],
  ] as const)(
    "says why the host refused with %s, and does not pretend the terminal has the Browser",
    async (reason, sentence) => {
      const client = codeClient({ evidence: "ready" });
      vi.mocked(client.executeOperation).mockImplementation(
        async (command) =>
          (command.kind === "start-terminal"
            ? {
                kind: "terminal-state",
                operationId: command.operationId,
                terminalId: command.terminalId,
                state: "unavailable",
                browserGrant: { status: "refused", reason },
              }
            : {
                ...terminalResult,
                operationId: command.operationId,
                state: "interrupted",
              }) as never,
      );
      renderSwitch(client);

      fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Let this terminal use the Browser…" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Restart with the Browser" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
      expect(screen.queryByText("Browser on")).not.toBeInTheDocument();
      expect(screen.getByText("Unavailable")).toBeVisible();
    },
  );

  it("offers no Browser in Plan or on a terminal this window cannot restart", async () => {
    const plan = renderSwitch(codeClient(), {
      executionPolicy: "plan",
      onOpenAnotherTerminal: vi.fn(),
    });
    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    expect(await screen.findByRole("menuitem", { name: "New terminal" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Let this terminal use the Browser…" }),
    ).not.toBeInTheDocument();
    plan.unmount();

    render(
      <CodeTerminalPane
        client={codeClient()}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={xtermRuntime().loadRuntime}
        offerBrowserGrant
        result={terminalResult}
        scope={scope}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("region", { name: "Terminal pane" }));
    expect(await screen.findByRole("menuitem", { name: "Stop terminal" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Let this terminal use the Browser…" }),
    ).not.toBeInTheDocument();
  });
});

function terminalWriteData(client: ReturnType<typeof codeClient>): readonly string[] {
  return (client.executeOperation as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => {
    const command = call[0] as { readonly kind?: string; readonly data?: string };
    return command.kind === "write-terminal" && command.data !== undefined ? [command.data] : [];
  });
}

function xtermRuntime(selection = "") {
  let options: Parameters<XtermAdapterRuntime["mount"]>[1] | undefined;
  const setOutput = vi.fn();
  const loadRuntime = vi.fn(
    async (): Promise<XtermAdapterRuntime> => ({
      mount: (_element, value) => {
        options = value;
        return {
          dispose: vi.fn(),
          focus: vi.fn(),
          readSelection: () => selection,
          setInteractive: vi.fn(),
          setOutput,
        };
      },
    }),
  );
  return {
    loadRuntime,
    setOutput,
    get options() {
      return options;
    },
  };
}

function terminalOutputFrame(cursor: number) {
  return {
    threadId: ids.thread,
    operationId: ids.operation,
    cursor,
    occurredAt: "2026-08-06T00:00:00.000Z",
    event: {
      kind: "terminal-output",
      terminalId: ids.terminal,
      content: {
        contentId: "30000000-0000-4000-8000-000000000002",
        digest: "d".repeat(64),
        byteLength: 12,
      },
    },
  } as const;
}
