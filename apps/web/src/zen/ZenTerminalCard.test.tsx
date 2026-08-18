import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZenTerminalCard } from "./ZenTerminalCard";

const scope = {
  threadId: "00000000-0000-4000-8000-000000000081" as never,
  checkoutId: "00000000-0000-4000-8000-000000000082" as never,
};
const terminalId = "00000000-0000-4000-8000-000000000083" as never;
const operationId = "00000000-0000-4000-8000-000000000084" as never;

function client(overrides: Record<string, unknown> = {}) {
  return {
    inspectTerminal: vi.fn(async () => ({ terminalId, state: "running" as const })),
    executeOperation: vi.fn(async () => ({
      kind: "terminal-state" as const,
      operationId,
      terminalId,
      state: "running" as const,
    })),
    operationContent: vi.fn(async () => new Uint8Array()),
    subscribeOperation: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
    })),
    ...overrides,
  };
}

const createOperationId = () => operationId;

describe("ZenTerminalCard", () => {
  it("binds the terminal it was pinned to rather than starting one", async () => {
    const bound = client();
    render(
      <ZenTerminalCard
        client={bound as never}
        createOperationId={createOperationId}
        executionPolicy="full-access"
        live
        scope={scope}
        terminalId={terminalId}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Terminal pane" })).toBeInTheDocument();
    });
    expect(bound.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attach-terminal", terminalId, ...scope }),
    );
    // Pinning is a second window onto a shell, never a way to open one.
    expect(bound.executeOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "start-terminal" }),
    );
  });

  it("stops following the shell while the card is out of the reader's view", () => {
    const paused = client();
    render(
      <ZenTerminalCard
        client={paused as never}
        createOperationId={createOperationId}
        executionPolicy="full-access"
        live={false}
        scope={scope}
        terminalId={terminalId}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/paused while this card is out of view/i);
    expect(paused.inspectTerminal).not.toHaveBeenCalled();
  });

  it("says so plainly when the terminal it names is gone", async () => {
    const missing = client({
      inspectTerminal: vi.fn(async () => {
        throw new Error("Terminal is unavailable.");
      }),
    });
    render(
      <ZenTerminalCard
        client={missing as never}
        createOperationId={createOperationId}
        executionPolicy="full-access"
        live
        scope={scope}
        terminalId={terminalId}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/this terminal is unavailable/i);
    });
  });

  it("offers no keystrokes on a thread that is planning", async () => {
    render(
      <ZenTerminalCard
        client={client() as never}
        createOperationId={createOperationId}
        executionPolicy="plan"
        live
        scope={scope}
        terminalId={terminalId}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Terminal pane" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Pin to focus zone" })).not.toBeInTheDocument();
  });
});
