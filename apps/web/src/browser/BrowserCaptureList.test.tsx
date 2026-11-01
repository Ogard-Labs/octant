import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import type { BrowserCapture, BrowserStep, BrowserThreadId } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceContentViewContext } from "../shell/WorkspaceContentView";
import { ThreadActivityRevisionsContext } from "../polling/ThreadActivityRevisions";
import { BrowserCaptureList } from "./BrowserCaptureList";
import { BrowserProofPanel } from "./BrowserProofPanel";
import type { OctantHostBridge } from "../shell/hostBridge";

const threadId = "c1000000-0000-4000-8000-000000000001" as BrowserThreadId;

function capture(index: number, overrides: Partial<BrowserCapture> = {}): BrowserCapture {
  return {
    captureId: `c2000000-0000-4000-8000-00000000000${index}`,
    threadId,
    origin: "https://example.com",
    url: `https://example.com/page-${index}`,
    title: `Page ${index}`,
    hash: "a".repeat(64),
    size: 128,
    mime: "image/png",
    capturedAt: "2026-10-12T09:00:00.000Z",
    ...overrides,
  } as BrowserCapture;
}

function clientWith(captures: ReadonlyArray<BrowserCapture>) {
  const listCaptures = vi.fn(async () => ({ captures }));
  const readCapture = vi.fn(async (input: { readonly captureId: string }) => ({
    captureId: input.captureId,
    dataUrl: "data:image/png;base64,AAAA",
  }));
  return {
    listCaptures,
    readCapture,
    client: { listCaptures, readCapture } as unknown as BrowserAutomationClient,
  };
}

afterEach(() => vi.useRealTimers());

describe("BrowserCaptureList", () => {
  it("shows nothing for a thread that kept no captures", async () => {
    const { client, listCaptures } = clientWith([]);
    render(<BrowserCaptureList client={client} threadId={threadId} />);
    await waitFor(() => expect(listCaptures).toHaveBeenCalled());
    expect(screen.queryByTestId("browser-capture-list")).not.toBeInTheDocument();
    expect(screen.queryByText("Browser captures")).not.toBeInTheDocument();
  });

  it("shows nothing when the host cannot list captures", () => {
    render(<BrowserCaptureList client={{} as BrowserAutomationClient} threadId={threadId} />);
    expect(screen.queryByTestId("browser-capture-list")).not.toBeInTheDocument();
  });

  it("lists captures as the host ordered them with the page title and origin", async () => {
    const { client } = clientWith([capture(2), capture(1, { title: undefined })]);
    render(<BrowserCaptureList client={client} threadId={threadId} />);

    const list = await screen.findByRole("region", { name: "Browser captures" });
    expect(list).toHaveTextContent("Browser captures");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Page 2");
    expect(items[0]).toHaveTextContent("https://example.com");
    // A page with no title is named by its origin.
    expect(items[1]).toHaveTextContent("https://example.comhttps://example.com");
    await waitFor(() => expect(screen.getAllByRole("img", { name: /Capture of/ })).toHaveLength(2));
  });

  it("names the profile of a capture taken in a signed-in page, and none for a Private page", async () => {
    const { client } = clientWith([capture(2, { profile: { kind: "personal" } }), capture(1)]);
    render(<BrowserCaptureList client={client} threadId={threadId} />);

    await screen.findByRole("region", { name: "Browser captures" });
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("https://example.com · Personal profile");
    expect(items[1]).not.toHaveTextContent("profile");
  });

  it("opens the full image in the workspace when a capture is chosen", async () => {
    const open =
      vi.fn<(key: string, title: string, render: (close: () => void) => ReactNode) => void>();
    const { client } = clientWith([capture(1)]);
    render(
      <WorkspaceContentViewContext.Provider value={{ open }}>
        <BrowserCaptureList client={client} threadId={threadId} />
      </WorkspaceContentViewContext.Provider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Open capture of Page 1" }));
    expect(open).toHaveBeenCalledWith(
      "browser-capture:c2000000-0000-4000-8000-000000000001",
      "Page 1",
      expect.any(Function),
    );
    const rendered = render(<>{open.mock.calls[0]?.[2](() => undefined)}</>);
    expect(await rendered.findByText("https://example.com/page-1")).toBeVisible();
  });

  it("expands the full image in place when no workspace can hold it", async () => {
    const { client } = clientWith([capture(1)]);
    render(<BrowserCaptureList client={client} threadId={threadId} />);

    await userEvent.click(await screen.findByRole("button", { name: "Open capture of Page 1" }));
    expect(await screen.findByTestId("browser-capture-view")).toHaveTextContent(
      "https://example.com/page-1",
    );
  });

  it("picks up a capture taken after the list first loaded", async () => {
    vi.useFakeTimers();
    const listCaptures = vi
      .fn()
      .mockResolvedValueOnce({ captures: [] })
      .mockResolvedValue({ captures: [capture(1)] });
    const client = {
      listCaptures,
      readCapture: vi.fn(async () => ({ captureId: "x", dataUrl: "data:image/png;base64,AAAA" })),
    } as unknown as BrowserAutomationClient;
    render(<BrowserCaptureList client={client} threadId={threadId} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByTestId("browser-capture-list")).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByTestId("browser-capture-list")).toBeVisible();
  });

  it("stops asking for a thread once the host refuses this window, but retries a transient failure", async () => {
    vi.useFakeTimers();
    const refused = vi
      .fn()
      .mockRejectedValue(new BrowserAutomationClientFailure("unauthorized", "No."));
    render(<BrowserCaptureList client={{ listCaptures: refused } as never} threadId={threadId} />);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(refused).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("browser-capture-list")).not.toBeInTheDocument();

    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationClientFailure("unavailable", "Down."))
      .mockResolvedValue({ captures: [capture(1)] });
    render(
      <BrowserCaptureList
        client={
          {
            listCaptures: flaky,
            readCapture: vi.fn(async () => ({
              captureId: "x",
              dataUrl: "data:image/png;base64,AAAA",
            })),
          } as never
        }
        threadId={threadId}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("browser-capture-list")).toBeVisible();
  });

  it("says a capture is unavailable when its picture cannot be read", async () => {
    const { client, readCapture } = clientWith([capture(1)]);
    readCapture.mockRejectedValue(new Error("gone"));
    render(<BrowserCaptureList client={client} threadId={threadId} />);
    expect(await screen.findByRole("img", { name: "Capture is unavailable" })).toBeInTheDocument();
  });

  it("keeps asking the new thread after an old thread's read comes back refused", async () => {
    const otherThreadId = "c1000000-0000-4000-8000-000000000099" as BrowserThreadId;
    let rejectOld!: (error: unknown) => void;
    const oldRead = new Promise<never>((_resolve, reject) => {
      rejectOld = reject;
    });
    const listCaptures = vi
      .fn()
      .mockImplementationOnce(() => oldRead)
      .mockResolvedValue({ captures: [capture(1)] });
    const client = {
      listCaptures,
      readCapture: vi.fn(async () => ({ captureId: "x", dataUrl: "data:image/png;base64,AAAA" })),
    } as unknown as BrowserAutomationClient;
    const revisions = (browserCaptures: number) => (
      <ThreadActivityRevisionsContext.Provider
        value={{
          browserCaptures,
          toolApprovals: 0,
          threadFollowUps: 0,
          threadMessageQueue: 0,
        }}
      >
        <BrowserCaptureList client={client} threadId={otherThreadId} />
      </ThreadActivityRevisionsContext.Provider>
    );
    const view = render(
      <ThreadActivityRevisionsContext.Provider
        value={{
          browserCaptures: 0,
          toolApprovals: 0,
          threadFollowUps: 0,
          threadMessageQueue: 0,
        }}
      >
        <BrowserCaptureList client={client} threadId={threadId} />
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(listCaptures).toHaveBeenCalledTimes(1));

    view.rerender(
      <ThreadActivityRevisionsContext.Provider
        value={{
          browserCaptures: 0,
          toolApprovals: 0,
          threadFollowUps: 0,
          threadMessageQueue: 0,
        }}
      >
        <BrowserCaptureList client={client} threadId={otherThreadId} />
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() => expect(listCaptures).toHaveBeenCalledTimes(2));
    await screen.findByTestId("browser-capture-list");

    // The old thread's deferred read comes back refused after its abort; the
    // refusal is for the old thread, so the new thread still answers notices.
    await act(async () => {
      rejectOld(new BrowserAutomationClientFailure("unauthorized", "No."));
      await oldRead.catch(() => undefined);
    });
    view.rerender(revisions(1));
    await waitFor(() => expect(listCaptures).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("browser-capture-list")).toBeVisible();
  });
});

function step(index: number, overrides: Partial<BrowserStep> = {}): BrowserStep {
  return {
    stepId: `c3000000-0000-4000-8000-00000000000${index}`,
    threadId,
    operation: "click",
    origin: "https://example.com",
    path: `/page-${index}`,
    recordedAt: `2026-10-12T09:00:0${index}.000Z`,
    ...overrides,
  } as BrowserStep;
}

describe("Browser proof", () => {
  function proofClient(steps: ReadonlyArray<BrowserStep>, captures: ReadonlyArray<BrowserCapture>) {
    const { client } = clientWith(captures);
    const listSteps = vi.fn(async () => ({ steps }));
    return { client: { ...client, listSteps } as unknown as BrowserAutomationClient, listSteps };
  }

  it("shows a folded panel for a thread that took steps but no screenshot", async () => {
    const { client } = proofClient([step(1), step(2)], []);
    render(<BrowserCaptureList client={client} threadId={threadId} />);

    const panel = await screen.findByRole("region", { name: "Browser proof" });
    expect(panel).toHaveTextContent("Browser proof");
    expect(screen.queryByRole("region", { name: "Browser captures" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 2 steps" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("lists the steps as a numbered list with a capture right after the step that took it", async () => {
    const shot = capture(1, {
      capturedAt: "2026-10-12T09:00:02.500Z" as BrowserCapture["capturedAt"],
    });
    const { client } = proofClient(
      [
        step(1, { element: { role: "button", name: "Save" }, changed: "The page's text changed." }),
        step(2, { operation: "screenshot", captureId: shot.captureId }),
        step(3, { failure: "stale" }),
      ],
      [shot],
    );
    render(<BrowserCaptureList client={client} threadId={threadId} />);

    await userEvent.click(await screen.findByRole("button", { name: "Show 3 steps" }));
    const panel = screen.getByRole("region", { name: "Browser proof" });
    const steps = within(panel).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent(
      'click button "Save" on https://example.com/page-1 — The page\'s text changed.',
    );
    expect(steps[1]).toHaveTextContent("screenshot on https://example.com/page-2");
    // The picture belongs to the second step, not the first or the third.
    expect(within(steps[1] as HTMLElement).getByRole("img", { name: /Capture of/ })).toBeVisible();
    expect(within(steps[0] as HTMLElement).queryByRole("img")).not.toBeInTheDocument();
    expect(steps[2]).toHaveTextContent("failed (stale)");
    expect(within(panel).getByRole("list").tagName).toBe("OL");
  });

  it("shows nothing of the proof when the host refuses this window", async () => {
    const { client } = clientWith([]);
    const listSteps = vi
      .fn()
      .mockRejectedValue(new BrowserAutomationClientFailure("unauthorized", "No."));
    render(<BrowserCaptureList client={{ ...client, listSteps } as never} threadId={threadId} />);
    await waitFor(() => expect(listSteps).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Browser proof" })).not.toBeInTheDocument();
  });

  it("saves the screenshots through the desktop app's folder picker, numbered oldest first", async () => {
    const older = capture(1, {
      capturedAt: "2026-10-12T09:00:01.000Z" as BrowserCapture["capturedAt"],
    });
    const newer = capture(2, {
      capturedAt: "2026-10-12T09:00:05.000Z" as BrowserCapture["capturedAt"],
    });
    const { client } = proofClient([step(1)], [newer, older]);
    const saveBrowserProofScreenshots = vi.fn(async () => ({
      kind: "saved" as const,
      count: 2,
      folderName: "pr-12",
    }));
    render(
      <BrowserProofPanel
        captures={[newer, older]}
        client={client}
        hostBridge={{ saveBrowserProofScreenshots } as unknown as OctantHostBridge}
        steps={[step(1)]}
        threadId={threadId}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save screenshots…" }));
    expect(await screen.findByText("Saved 2 screenshots to “pr-12”.")).toBeVisible();
    expect(saveBrowserProofScreenshots).toHaveBeenCalledWith([
      { fileNumber: 1, dataUrl: "data:image/png;base64,AAAA" },
      { fileNumber: 2, dataUrl: "data:image/png;base64,AAAA" },
    ]);
    const read = vi.mocked(client.readCapture as never) as unknown as ReturnType<typeof vi.fn>;
    expect(read.mock.calls.map(([input]) => (input as { captureId: string }).captureId)).toEqual(
      expect.arrayContaining([older.captureId, newer.captureId]),
    );
  });

  it("offers no save outside the desktop app, such as a paired device's browser", () => {
    const { client } = proofClient([step(1)], [capture(1)]);
    render(
      <BrowserProofPanel
        captures={[capture(1)]}
        client={client}
        hostBridge={undefined}
        steps={[step(1)]}
        threadId={threadId}
      />,
    );
    expect(screen.queryByRole("button", { name: "Save screenshots…" })).not.toBeInTheDocument();
  });

  it("says why a save failed and writes nothing when the person cancels", async () => {
    const { client } = proofClient([step(1)], [capture(1)]);
    const cancel = vi.fn(async () => ({ kind: "cancelled" as const }));
    const view = render(
      <BrowserProofPanel
        captures={[capture(1)]}
        client={client}
        hostBridge={{ saveBrowserProofScreenshots: cancel } as unknown as OctantHostBridge}
        steps={[step(1)]}
        threadId={threadId}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save screenshots…" }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.unmount();

    const failing = vi.fn(async () => {
      throw new Error(
        "A file named browser-check-01.png is already in that folder. Nothing was written.",
      );
    });
    render(
      <BrowserProofPanel
        captures={[capture(1)]}
        client={client}
        hostBridge={{ saveBrowserProofScreenshots: failing } as unknown as OctantHostBridge}
        steps={[step(1)]}
        threadId={threadId}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save screenshots…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already in that folder");
  });
});
