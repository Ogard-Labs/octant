import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import {
  decodeDesktopLease,
  decodeDesktopProviderId,
  decodeDesktopViewId,
  type DesktopInputEvent,
  type DesktopLease,
  type DesktopPaneAnswer,
  type DesktopPaneRequest,
} from "@octant/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopPane } from "./DesktopPane";

const threadId = "80000000-0000-4000-8000-000000000001";
const leaseId = "80000000-0000-4000-8000-000000000002";
const viewId = decodeDesktopViewId("80000000-0000-4000-8000-000000000003");
const provider = {
  providerId: decodeDesktopProviderId("host-local"),
  displayName: "This host",
  locality: "host-local",
  billed: false,
} as const;

function lease(overrides: Partial<Record<keyof DesktopLease, unknown>> = {}): DesktopLease {
  return decodeDesktopLease({
    leaseId,
    owner: { mode: "code", threadId },
    providerId: "host-local",
    locality: "host-local",
    billed: false,
    state: "ready",
    requestedAt: "2026-10-27T12:00:00.000Z",
    expiresAt: "2026-10-27T12:30:00.000Z",
    maximumExpiresAt: "2026-10-27T16:00:00.000Z",
    idleMinutes: 15,
    updatedAt: "2026-10-27T12:00:05.000Z",
    ...overrides,
  });
}

type Overview = Extract<DesktopPaneAnswer, { status: "overview" }>;

function overviewOf(
  leases: ReadonlyArray<DesktopLease>,
  start: Overview["start"] = { status: "available", provider },
): Overview {
  return { status: "overview", leases, providers: [provider], start };
}

function fakeClient(state: { overview: Overview }) {
  const requests: Array<DesktopPaneRequest> = [];
  const frame = vi.fn<DesktopPaneClient["frame"]>(async () => ({
    status: "frame",
    image: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
  }));
  const client: DesktopPaneClient = {
    request: async (request) => {
      requests.push(request);
      switch (request.kind) {
        case "overview":
          return state.overview;
        case "acquire":
          state.overview = overviewOf([lease()]);
          return { status: "acquired", lease: lease() };
        case "open-view":
          return { status: "viewing", viewId };
        case "input":
          return { status: "delivered" };
        case "close-view":
          return { status: "view-closed" };
        case "retry-release":
          return { status: "release-failed", lease: lease({ state: "release-failed" }) };
        default:
          return { status: "refused", reason: "lease-ended" };
      }
    },
    frame,
  };
  return { client, requests, frame };
}

const kinds = (requests: ReadonlyArray<DesktopPaneRequest>) =>
  requests.map((request) => request.kind).filter((kind) => kind !== "overview");

beforeEach(() => {
  let next = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => `blob:frame-${(next += 1)}`,
      revokeObjectURL: () => undefined,
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Desktop pane", () => {
  it("says honestly that the Project has no recipe, and offers no Start", async () => {
    const { client, requests } = fakeClient({
      overview: overviewOf([], { status: "refused", reason: "no-provider-configured" }),
    });
    render(<DesktopPane client={client} threadId={threadId} />);
    expect(await screen.findByText("No desktop to start")).toBeTruthy();
    expect(screen.getByText(/no desktop recipe yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start desktop" })).toBeNull();
    expect(kinds(requests)).toEqual([]);
  });

  it("starts a desktop, shows it live, and sends the person's click on the screen", async () => {
    const { client, requests, frame } = fakeClient({ overview: overviewOf([]) });
    render(<DesktopPane client={client} threadId={threadId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start desktop" }));
    const picture = await screen.findByRole("img", { name: "Desktop live screen" });
    expect(frame).toHaveBeenCalledWith({ threadId, leaseId, viewId }, expect.anything());
    Object.defineProperty(picture, "naturalWidth", { value: 1280 });
    Object.defineProperty(picture, "naturalHeight", { value: 800 });
    picture.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400 }) as DOMRect;
    fireEvent.load(picture);
    const surface = screen.getByRole("application");
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
    await waitFor(() =>
      expect(requests).toContainEqual({
        kind: "input",
        threadId,
        leaseId,
        viewId,
        event: { kind: "pointer", action: "down", button: "left", x: 200, y: 100 },
      }),
    );
    expect(kinds(requests).slice(0, 2)).toEqual(["acquire", "open-view"]);
    expect(screen.getByText(/^Live · /)).toBeTruthy();
  });

  it("sends a person's moves, scrolls, and presses in the order they made them", async () => {
    const fake = fakeClient({ overview: overviewOf([lease()]) });
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: Array<DesktopInputEvent> = [];
    const client: DesktopPaneClient = {
      ...fake.client,
      request: async (request) => {
        if (request.kind !== "input") return fake.client.request(request);
        events.push(request.event);
        if (events.length === 1) await firstHeld;
        return { status: "delivered" };
      },
    };
    render(<DesktopPane client={client} threadId={threadId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show desktop" }));
    const picture = await screen.findByRole("img", { name: "Desktop live screen" });
    Object.defineProperty(picture, "naturalWidth", { value: 1280 });
    Object.defineProperty(picture, "naturalHeight", { value: 800 });
    picture.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400 }) as DOMRect;
    fireEvent.load(picture);
    const surface = screen.getByRole("application");
    const at = (x: number) => ({ clientX: x, clientY: 10, button: 0, pointerId: 1 });

    fireEvent.pointerDown(surface, at(1));
    fireEvent.pointerMove(surface, at(2));
    fireEvent.pointerDown(surface, at(3));
    fireEvent.pointerMove(surface, at(4));
    fireEvent.wheel(surface, { ...at(5), deltaY: 120 });
    fireEvent.pointerDown(surface, at(6));
    releaseFirst();

    await waitFor(() => expect(events).toHaveLength(6));
    expect(events.map((event) => [event.kind, "x" in event ? event.x : undefined])).toEqual([
      ["pointer", 2],
      ["pointer", 4],
      ["pointer", 6],
      ["pointer", 8],
      ["scroll", 10],
      ["pointer", 12],
    ]);
  });

  it("does not reconnect to a running desktop when it mounts, until the person shows it", async () => {
    const { client, requests, frame } = fakeClient({ overview: overviewOf([lease()]) });
    render(<DesktopPane client={client} threadId={threadId} />);
    const show = await screen.findByRole("button", { name: "Show desktop" });
    expect(screen.getByText("Desktop not shown here")).toBeTruthy();
    expect(kinds(requests)).toEqual([]);
    expect(frame).not.toHaveBeenCalled();
    fireEvent.click(show);
    await screen.findByRole("img", { name: "Desktop live screen" });
    expect(kinds(requests)).toEqual(["open-view"]);
  });

  it("shows a desktop the host restart ended as ended, and never opens a view of it", async () => {
    const { client, requests } = fakeClient({
      overview: overviewOf([lease({ state: "released", endReason: "host-restart" })]),
    });
    render(<DesktopPane client={client} threadId={threadId} />);
    expect(await screen.findByText("Desktop ended")).toBeTruthy();
    expect(screen.getByText(/never reconnects to a desktop that ended/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a new desktop" })).toBeTruthy();
    expect(kinds(requests)).toEqual([]);
  });

  it("shows a desktop whose release was not verified as still running, with Retry", async () => {
    const { client, requests } = fakeClient({
      overview: overviewOf([lease({ state: "release-failed", endReason: "released" })]),
    });
    render(<DesktopPane client={client} threadId={threadId} />);
    expect(await screen.findByRole("heading", { name: "Still running" })).toBeTruthy();
    expect(screen.getByText(/could not confirm that This host destroyed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(kinds(requests)).toEqual(["retry-release"]));
  });

  it("shows a view the host ended as interrupted, and reconnects only when asked", async () => {
    const { client, requests, frame } = fakeClient({ overview: overviewOf([lease()]) });
    frame.mockResolvedValue({ status: "refused", reason: "view-ended" });
    render(<DesktopPane client={client} threadId={threadId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show desktop" }));
    const reconnect = await screen.findByRole("button", { name: "Reconnect" });
    expect(screen.getByText("Live view interrupted")).toBeTruthy();
    const opened = kinds(requests).filter((kind) => kind === "open-view").length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(kinds(requests).filter((kind) => kind === "open-view")).toHaveLength(opened);
    fireEvent.click(reconnect);
    await waitFor(() =>
      expect(kinds(requests).filter((kind) => kind === "open-view")).toHaveLength(opened + 1),
    );
  });
});
