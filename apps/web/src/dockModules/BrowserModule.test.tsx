import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BrowserModule from "./BrowserModule";

const threadId = "21000000-0000-4000-8000-0000000000aa";
const pageId = "61000000-0000-4000-8000-000000000001";
const savedContextId = "25000000-0000-4000-8000-0000000000c1";
const otherContextId = "25000000-0000-4000-8000-0000000000c2";
const authority = {
  kind: "browser-thread",
  mode: "work",
  threadId,
  projectId: "20000000-0000-4000-8000-000000000001",
};

const offer = { pageId, status: "offered", profile: { kind: "personal" } };
const emptyThread = { status: "ready", threadId, evidence: [] };
const stale = () =>
  new BrowserAutomationClientFailure("stale", "Browser context is stale or no longer owned");

function liveContext(contextId: string) {
  return {
    contextId,
    actionId: "10000000-0000-4000-8000-000000000001",
    correlationId: "90000000-0000-4000-8000-000000000001",
    authority,
    policy: {
      profileMode: "isolated",
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 4,
      sessionTimeoutMs: 300_000,
    },
    state: "active",
    createdAt: "2026-07-27T20:00:00.000Z",
  };
}

function client(thread: object): BrowserAutomationClient {
  return {
    resolve: vi.fn(async () => ({ threadId, authority }) as never),
    create: vi.fn(async () => emptyThread as never),
    inspect: vi.fn(async () => {
      throw stale();
    }),
    inspectThread: vi.fn(async () => thread as never),
    releaseThread: vi.fn(async () => emptyThread as never),
    act: vi.fn(async () => emptyThread as never),
    cancel: vi.fn(async () => emptyThread as never),
    stop: vi.fn(async () => emptyThread as never),
    claimPageOffer: vi.fn(async () => ({ status: "claimed", profile: { kind: "personal" } })),
    dismissPageOffer: vi.fn(async () => ({ status: "dismissed" })),
    releasePageOffer: vi.fn(async () => ({ status: "released" })),
  } as unknown as BrowserAutomationClient;
}

function dock(
  browser: BrowserAutomationClient,
  extra: { browserContextId?: string; utilityTabId?: string } = {},
) {
  return render(
    <BrowserModule
      browserAutomationClient={browser}
      subject={{ mode: "work", threadId }}
      {...extra}
    />,
  );
}

afterEach(() => cleanup());

describe("Browser dock tab offering a page a restart took", () => {
  it("offers the page in a saved tab whose page is gone after the restart", async () => {
    const browser = client({ ...emptyThread, reopenOffer: offer });
    dock(browser, { browserContextId: savedContextId });
    expect(
      await screen.findByRole("button", { name: "Reopen page" }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(browser.claimPageOffer).not.toHaveBeenCalled();
  });

  it("offers the page in a tab added after the restart", async () => {
    const browser = client({ ...emptyThread, reopenOffer: offer });
    dock(browser, { utilityTabId: "90000000-0000-4000-8000-0000000000a2" });
    expect(
      await screen.findByRole("button", { name: "Reopen page" }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("shows no offer and adopts no page in a tab while another tab of the thread has a live page", async () => {
    const live = {
      status: "running",
      threadId,
      context: liveContext(otherContextId),
      evidence: [],
    };
    for (const extra of [
      { browserContextId: savedContextId },
      { utilityTabId: "90000000-0000-4000-8000-0000000000a2" },
    ]) {
      const browser = client(live);
      dock(browser, extra);
      await waitFor(() => expect(browser.inspectThread).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: "Reopen page" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Browser URL" })).toHaveValue("");
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("does not read the thread while the saved page is live", async () => {
    const browser = client({ ...emptyThread, reopenOffer: offer });
    vi.mocked(browser.inspect).mockResolvedValue({
      status: "running",
      threadId,
      context: liveContext(savedContextId),
      evidence: [],
    } as never);
    dock(browser, { browserContextId: savedContextId });
    await waitFor(() => expect(browser.inspect).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(browser.inspectThread).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Reopen page" })).not.toBeInTheDocument();
  });
});
