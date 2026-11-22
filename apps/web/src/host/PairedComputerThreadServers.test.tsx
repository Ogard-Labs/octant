import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { LocalServerClient } from "@octant/client-runtime";
import { LocalServerCommandResult } from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodeProjectId } from "@octant/contracts/projects";
import { PairedComputerThreadServers } from "./PairedComputerThreadServers";

const THREAD = decodeCodeThreadId("10000000-0000-4000-8000-000000000001");
const OTHER_THREAD = decodeCodeThreadId("10000000-0000-4000-8000-000000000002");
const PROJECT = decodeProjectId("20000000-0000-4000-8000-000000000001");
const LISTENER = `lsn_${"0".repeat(31)}1`;

function listener(input: {
  readonly id: string;
  readonly port: number;
  readonly healthy?: boolean;
  readonly startSource?: string;
}) {
  const healthy = input.healthy ?? true;
  return {
    listenerId: input.id,
    port: input.port,
    url: `http://127.0.0.1:${String(input.port)}/`,
    processName: "node",
    framework: "vite",
    attribution: "current-checkout",
    startSource: input.startSource ?? "octant",
    bindScope: "loopback",
    health: healthy ? "listening" : "unresponsive",
    openAvailable: healthy,
    stop: { status: "unavailable", reason: "Only a local window stops this server." },
  };
}

/** A listing as the host answers it, decoded as the real client decodes it. */
function listed(threadId: string, currentCheckout: ReadonlyArray<unknown>) {
  return Schema.decodeUnknownSync(LocalServerCommandResult)({
    kind: "local-servers-listed",
    requestId: "30000000-0000-4000-8000-000000000001",
    snapshot: {
      threadId,
      projectId: PROJECT,
      observedAt: "2026-11-20T10:00:00.000Z",
      currentCheckout,
      other: [],
    },
  });
}

function client(
  answer: () => Promise<LocalServerCommandResult> = async () =>
    listed(THREAD, [
      listener({ id: LISTENER, port: 5173 }),
      listener({ id: `lsn_${"0".repeat(31)}2`, port: 5432, healthy: false }),
    ]),
): LocalServerClient {
  return {
    execute: vi.fn(answer),
    executeRunningServices: vi.fn(),
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
        inOwnWorktree
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
        inOwnWorktree
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

  it("offers no Open for a server Octant did not start or one in the shared Project folder, and says why", async () => {
    const outside = client(async () =>
      listed(THREAD, [listener({ id: LISTENER, port: 5173, startSource: "unknown" })]),
    );
    const view = render(
      <PairedComputerThreadServers
        client={outside}
        hostName="Studio"
        inOwnWorktree
        open={vi.fn()}
        projectId={PROJECT}
        threadId={THREAD}
      />,
    );
    expect(
      await screen.findByText("Octant didn't start this server, so it opens only on Studio."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    view.unmount();

    render(
      <PairedComputerThreadServers
        client={client()}
        hostName="Studio"
        inOwnWorktree={false}
        open={vi.fn()}
        projectId={PROJECT}
        threadId={THREAD}
      />,
    );
    expect(await screen.findByText(/runs in the Project folder/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never shows the last thread's servers under the thread now open", async () => {
    let answer: () => Promise<LocalServerCommandResult> = async () =>
      listed(THREAD, [listener({ id: LISTENER, port: 5173 })]);
    const shared = client(() => answer());
    const view = render(
      <PairedComputerThreadServers
        client={shared}
        hostName="Studio"
        inOwnWorktree
        open={vi.fn()}
        projectId={PROJECT}
        threadId={THREAD}
      />,
    );
    await screen.findByText("vite on port 5173");
    // The next thread's listing never arrives.
    answer = () => new Promise(() => undefined);
    view.rerender(
      <PairedComputerThreadServers
        client={shared}
        hostName="Studio"
        inOwnWorktree
        open={vi.fn()}
        projectId={PROJECT}
        threadId={OTHER_THREAD}
      />,
    );
    await waitFor(() => expect(screen.queryByText("vite on port 5173")).toBeNull());
  });

  it("keeps the last rows and says so when a later read of that computer fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    render(
      <PairedComputerThreadServers
        client={client(async () => {
          calls += 1;
          if (calls === 1) return listed(THREAD, [listener({ id: LISTENER, port: 5173 })]);
          throw new Error("Studio is not answering.");
        })}
        hostName="Studio"
        inOwnWorktree
        open={vi.fn()}
        projectId={PROJECT}
        threadId={THREAD}
      />,
    );
    try {
      await screen.findByText("vite on port 5173");
      // The next read is the controller's regular refresh, five seconds on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Couldn't list this thread's servers on Studio.",
      );
      expect(screen.getByText("vite on port 5173")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when that computer could not list the thread's servers", async () => {
    render(
      <PairedComputerThreadServers
        client={client(async () => {
          throw new Error("Studio is not answering.");
        })}
        hostName="Studio"
        inOwnWorktree
        open={vi.fn()}
        projectId={PROJECT}
        threadId={THREAD}
      />,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Couldn't list this thread's servers on Studio.",
    );
  });
});
