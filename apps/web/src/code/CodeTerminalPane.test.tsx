import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { XtermAdapterRuntime } from "./XtermTerminalAdapter";
import { CodeTerminalPane } from "./CodeTerminalPane";
import { codeClient, ids, scope, terminalResult } from "./CodeDeliveryPane.test-fixtures";

describe("CodeTerminalPane", () => {
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

  it("keeps an approved running terminal interactive without re-prompting for input or resize", async () => {
    const client = codeClient({ evidence: "ready" });
    const runtime = xtermRuntime();
    const requestApproval = vi.fn(async () => false);
    render(
      <CodeTerminalPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        loadRuntime={runtime.loadRuntime}
        requestApproval={requestApproval}
        result={terminalResult}
        scope={scope}
      />,
    );
    await waitFor(() => expect(runtime.options).toBeDefined());
    runtime.options?.onData("pwd\r");
    runtime.options?.onResize(120, 40);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(2));
    expect(requestApproval).not.toHaveBeenCalled();
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

  it("serializes terminal input chunks before sending the next chunk", async () => {
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
    runtime.options?.onData("p");
    runtime.options?.onData("w");
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    resolveFirst?.(terminalResult);
    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledTimes(2));
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "write-terminal", data: "p" }),
    );
    expect(client.executeOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "write-terminal", data: "w" }),
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

    fireEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
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
});

function xtermRuntime() {
  let options: Parameters<XtermAdapterRuntime["mount"]>[1] | undefined;
  const setOutput = vi.fn();
  const loadRuntime = vi.fn(
    async (): Promise<XtermAdapterRuntime> => ({
      mount: (_element, value) => {
        options = value;
        return {
          dispose: vi.fn(),
          focus: vi.fn(),
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
