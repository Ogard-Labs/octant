import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadSecrets } from "./threadSecretSurfaces";

const card = {
  id: "00000000-0000-4000-8000-000000000001",
  threadId: "thread",
  name: "DEPLOY_TOKEN",
  label: "Deploy token",
  kind: "token",
  reason: "Publish the preview build.",
  delivery: "file",
  fields: [{ name: "DEPLOY_TOKEN", label: "Deploy token", secret: true }],
  lifetimes: ["this-turn", "24-hours"],
  defaultLifetime: "24-hours",
  sources: ["pasted"],
  remembered: [],
  state: "pending",
};

afterEach(() => vi.unstubAllGlobals());

function host(reply: (init: RequestInit | undefined) => unknown) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(reply(init)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("secret requests in a thread", () => {
  it("shows the host's cards and sends the answer to the host alone, with the window's capability", async () => {
    const user = userEvent.setup();
    const fetch = host((init) =>
      init?.method === "POST" ? { status: "accepted" } : { requests: [card], active: [] },
    );
    render(
      <ThreadSecrets
        threadId="thread"
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );
    await user.type(
      await screen.findByLabelText("Deploy token", { selector: "input" }),
      "private-token{Enter}",
    );
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
    );
    const [url, init] = fetch.mock.calls.find(([, sent]) => sent?.method === "POST") ?? [];
    expect(url).toBe("http://127.0.0.1:1/api/thread-secrets");
    expect(init?.headers).toMatchObject({ "x-octant-window-capability": "capability" });
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "answer",
      threadId: "thread",
      answer: {
        id: card.id,
        action: "save",
        lifetime: "24-hours",
        fields: [{ name: "DEPLOY_TOKEN", source: "pasted", value: "private-token" }],
      },
    });
  });

  it.each(["https://evil.test", "http://evil.test", undefined])(
    "asks no other computer (%s)",
    async (serverUrl) => {
      const fetch = host(() => ({ requests: [card], active: [] }));
      render(
        <ThreadSecrets threadId="thread" serverUrl={serverUrl} windowCapability="capability" />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.queryByText("Deploy token")).not.toBeInTheDocument();
    },
  );

  it("keeps what was typed when the host took nothing, and clears it when that is not known", async () => {
    const user = userEvent.setup();
    let status = 413;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ status: "invalid" }, { status })
          : Response.json({ requests: [card], active: [] }),
      ),
    );
    render(
      <ThreadSecrets
        threadId="thread"
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );
    const input = await screen.findByLabelText("Deploy token", { selector: "input" });
    await user.type(input, "private-token{Enter}");
    expect(await screen.findByText(/could not send it/)).toBeInTheDocument();
    expect(input).toHaveValue("private-token");
    status = 503;
    await user.type(input, "{Enter}");
    expect(await screen.findByText(/result is not known/)).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("asks the host less often while it does not answer, and not at all in a hidden window", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const fetch = vi.fn(async () => new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", fetch);
      render(
        <ThreadSecrets
          threadId="thread"
          serverUrl="http://127.0.0.1:1"
          windowCapability="capability"
        />,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const calls = fetch.mock.calls.length;
      expect(calls).toBeGreaterThan(3);
      expect(calls).toBeLessThan(10);
      visibility.mockReturnValue("hidden");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
      visibility.mockRestore();
    }
  });

  it("shows nothing for an answer it cannot read", async () => {
    const fetch = host(() => ({ requests: [{ ...card, value: "private" }], active: [] }));
    render(
      <ThreadSecrets
        threadId="thread"
        serverUrl="http://127.0.0.1:1"
        windowCapability="capability"
      />,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("Deploy token")).not.toBeInTheDocument();
  });
});
