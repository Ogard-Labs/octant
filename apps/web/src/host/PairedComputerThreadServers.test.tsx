import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LocalServerClient } from "@octant/client-runtime";
import { PairedComputerThreadServers } from "./PairedComputerThreadServers";

const THREAD = "10000000-0000-4000-8000-000000000001" as never;
const PROJECT = "20000000-0000-4000-8000-000000000001" as never;
const LISTENER = `lsn_${"0".repeat(31)}1`;

function listener(openAvailable: boolean, port: number) {
  return {
    listenerId: openAvailable ? LISTENER : `lsn_${"0".repeat(31)}2`,
    port,
    url: `http://127.0.0.1:${String(port)}/`,
    processName: "node",
    framework: "vite",
    attribution: "thread",
    startSource: "octant-terminal",
    bindScope: "loopback",
    health: openAvailable ? "listening" : "unresponsive",
    openAvailable,
    stop: { kind: "unavailable", reason: "not-owned" },
  };
}

function client(): LocalServerClient {
  return {
    execute: vi.fn(async () => ({
      kind: "local-servers-listed",
      requestId: "req",
      snapshot: {
        threadId: THREAD,
        observedAt: "2026-11-20T10:00:00.000Z",
        currentCheckout: [listener(true, 5173), listener(false, 5432)],
        other: [],
      },
    })),
  } as unknown as LocalServerClient;
}

describe("a thread's servers on another computer", () => {
  it("offers each server that computer can open and asks for a grant on that thread's listing", async () => {
    const user = userEvent.setup();
    const open = vi.fn(async () => ({ kind: "opened" as const }));
    render(
      <PairedComputerThreadServers
        client={client()}
        hostName="Studio"
        open={open}
        projectId={PROJECT}
        threadId={THREAD}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Open vite on port 5173 in Octant" }),
    );
    expect(open).toHaveBeenCalledWith(
      { surface: "local-servers", threadId: THREAD, projectId: PROJECT, listenerId: LISTENER },
      "octant-browser",
    );
    // A listener the host cannot open is not offered.
    expect(screen.queryByText(/port 5432/)).toBeNull();
  });

  it("says why the computer refused, in its own words", async () => {
    const user = userEvent.setup();
    const open = vi.fn(async () => ({
      kind: "refused" as const,
      message: "Studio refused this server.",
    }));
    render(
      <PairedComputerThreadServers
        client={client()}
        hostName="Studio"
        open={open}
        projectId={PROJECT}
        threadId={THREAD}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Open vite on port 5173 in your default browser" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Studio refused this server."),
    );
  });
});
