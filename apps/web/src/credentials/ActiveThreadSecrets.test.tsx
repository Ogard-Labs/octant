import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveThreadSecret } from "@octant/contracts/thread-secrets";
import { ActiveThreadSecrets, threadSecretTimeLeft } from "./ActiveThreadSecrets";
import { ThreadSecrets } from "./ThreadSecrets";

const secret: ActiveThreadSecret = {
  id: "00000000-0000-4000-8000-000000000001",
  threadId: "thread",
  name: "DEPLOY_TOKEN",
  label: "Deploy token",
  kind: "token",
  source: "onepassword",
  lifetime: "24-hours",
  delivery: "file-and-environment",
  remainingMs: 84_240_000,
};
const place = {
  threadId: "thread",
  serverUrl: "http://127.0.0.1:1",
  windowCapability: "capability",
};

afterEach(() => vi.unstubAllGlobals());

describe("the active secrets of a thread", () => {
  it("lists each with its source and time left, and ends one", async () => {
    let active = [secret];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ requests: [], active });
      active = [];
      return Response.json({ status: "accepted" });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ActiveThreadSecrets {...place} />);
    await userEvent.click(await screen.findByText(/Active secrets/));
    expect(screen.getByText("DEPLOY_TOKEN · 1Password · 23 h left")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke Deploy token, DEPLOY_TOKEN" }),
    );
    await waitFor(() => expect(screen.queryByText(/Active secrets/)).not.toBeInTheDocument());
    const sent = fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
    expect(JSON.parse(String(sent?.body))).toEqual({
      kind: "revoke",
      threadId: "thread",
      secretId: secret.id,
    });
  });

  it("says so when one could not be ended, and keeps it listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({}, { status: 503 })
          : Response.json({ requests: [], active: [secret] }),
      ),
    );
    render(<ActiveThreadSecrets {...place} />);
    await userEvent.click(await screen.findByText(/Active secrets/));
    await userEvent.click(screen.getByRole("button", { name: /Revoke/ }));
    expect(await screen.findByText(/could not be revoked/)).toBeInTheDocument();
    expect(screen.getByText("Deploy token")).toBeInTheDocument();
  });

  it("reads the thread once for the cards and the list together", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => Response.json({ requests: [], active: [secret] }));
      vi.stubGlobal("fetch", fetch);
      const { unmount } = render(
        <>
          <ThreadSecrets {...place} />
          <ActiveThreadSecrets {...place} />
        </>,
      );
      await vi.advanceTimersByTimeAsync(3_500);
      expect(fetch.mock.calls.length).toBe(4);
      unmount();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetch.mock.calls.length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ remainingMs: 20_000 }, "Ends in a minute"],
    [{ remainingMs: 59 * 60_000 }, "59 min left"],
    [{ remainingMs: 24 * 3_600_000 }, "24 h left"],
    [{ lifetime: "this-command", remainingMs: undefined }, "For one command"],
    [{ lifetime: "this-turn", remainingMs: undefined }, "Until this turn ends"],
    [{ lifetime: "until-archived", remainingMs: undefined }, "Until archived"],
    [{ lifetime: "remember", remainingMs: undefined }, "Until archived"],
  ] as const)("says when a secret ends (%#)", (over, text) => {
    const { remainingMs, ...rest } = { ...secret, ...over };
    expect(
      threadSecretTimeLeft({ ...rest, ...(remainingMs === undefined ? {} : { remainingMs }) }),
    ).toBe(text);
  });
});
