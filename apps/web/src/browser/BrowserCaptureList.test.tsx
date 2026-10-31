import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import type { BrowserCapture, BrowserThreadId } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceContentViewContext } from "../shell/WorkspaceContentView";
import { ThreadActivityRevisionsContext } from "../polling/ThreadActivityRevisions";
import { BrowserCaptureList } from "./BrowserCaptureList";

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
