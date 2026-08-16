import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMentionClient } from "@octant/client-runtime";
import type { MentionableThreadId, SideChatSidecar } from "@octant/contracts";
import { SideChatPanel } from "./SideChatPanel";

const requestId = "00000000-0000-4000-8000-000000000001" as never;
const sourceThreadId = "00000000-0000-4000-8000-000000000101" as MentionableThreadId;

const sidecar = {
  sourceThreadId,
  sourceMode: "work",
  sidecarThreadId: "00000000-0000-4000-8000-000000000201",
  title: "Side Chat about Release notes",
  createdAt: "2026-08-14T10:00:00.000Z",
} as unknown as SideChatSidecar;

function stubClient(overrides: Partial<ThreadMentionClient> = {}): ThreadMentionClient {
  return {
    search: vi.fn(),
    resolve: vi.fn(),
    openSideChat: vi.fn().mockResolvedValue({ sidecar, created: true }),
    execute: vi.fn(),
    ...overrides,
  } as ThreadMentionClient;
}

function renderPanel(overrides: Partial<Parameters<typeof SideChatPanel>[0]> = {}) {
  const renderSidecar = vi.fn((sidecarThreadId: unknown) => (
    <p>sidecar surface {String(sidecarThreadId)}</p>
  ));
  render(
    <SideChatPanel
      client={stubClient()}
      renderSidecar={renderSidecar}
      requestId={() => requestId}
      sourceThreadId={sourceThreadId}
      sourceTitle="Release notes"
      {...overrides}
    />,
  );
  return { renderSidecar };
}

describe("SideChatPanel", () => {
  it("asks the host for the sidecar and renders the ordinary Chat surface it returns", async () => {
    const client = stubClient();
    const { renderSidecar } = renderPanel({ client });

    await waitFor(() =>
      expect(
        screen.getByText(/sidecar surface 00000000-0000-4000-8000-000000000201/),
      ).toBeVisible(),
    );
    expect(client.openSideChat).toHaveBeenCalledWith(requestId, sourceThreadId);
    expect(renderSidecar).toHaveBeenCalledWith(sidecar.sidecarThreadId, sidecar);
  });

  it("titles itself as being about the source thread and states its read-only posture", async () => {
    renderPanel();

    const panel = screen.getByRole("region", { name: "Side Chat" });
    expect(panel).toHaveTextContent("Side Chat about Release notes");
    expect(panel).toHaveTextContent(
      "Ordinary Chat. It reads this thread and cannot steer, approve, or change it.",
    );
    await waitFor(() => expect(screen.getByText(/sidecar surface/)).toBeVisible());
  });

  it("asks for a thread when none is open rather than inventing a sidecar", () => {
    const client = stubClient();
    render(<SideChatPanel client={client} renderSidecar={vi.fn()} requestId={() => requestId} />);

    expect(screen.getByText("Open a thread to ask about it here.")).toBeVisible();
    expect(client.openSideChat).not.toHaveBeenCalled();
  });

  it("shows an unavailable state when the host refuses, and can retry", async () => {
    const user = userEvent.setup();
    const openSideChat = vi
      .fn()
      .mockRejectedValueOnce(new Error("unauthorized"))
      .mockResolvedValueOnce({ sidecar, created: false });
    const { renderSidecar } = renderPanel({ client: stubClient({ openSideChat }) });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Side Chat is unavailable for this thread.",
      ),
    );
    expect(renderSidecar).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByText(/sidecar surface/)).toBeVisible());
  });

  it("reopens the sidecar when the source thread changes", async () => {
    const client = stubClient();
    const { rerender } = render(
      <SideChatPanel
        client={client}
        renderSidecar={() => null}
        requestId={() => requestId}
        sourceThreadId={sourceThreadId}
      />,
    );
    await waitFor(() => expect(client.openSideChat).toHaveBeenCalledTimes(1));

    const other = "00000000-0000-4000-8000-000000000102" as MentionableThreadId;
    rerender(
      <SideChatPanel
        client={client}
        renderSidecar={() => null}
        requestId={() => requestId}
        sourceThreadId={other}
      />,
    );

    await waitFor(() => expect(client.openSideChat).toHaveBeenCalledTimes(2));
    expect(client.openSideChat).toHaveBeenLastCalledWith(requestId, other);
  });

  it("says Side Chat is unavailable on a host with no mention client", () => {
    render(<SideChatPanel renderSidecar={vi.fn()} sourceThreadId={sourceThreadId} />);

    expect(screen.getByText("Side Chat is not available on this host.")).toBeVisible();
  });
});
