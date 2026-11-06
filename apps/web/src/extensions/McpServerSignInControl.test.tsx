import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServerSignInView } from "@octant/contracts/extension-rpc";
import { describe, expect, it, vi } from "vitest";
import { McpServerSignInControl } from "./McpServerSignInControl";
import { createExtensionClient } from "@octant/client-runtime/extension-client";

const extensionId = "44000000-0000-4000-8000-000000000002";
const componentId = "mcp-docs";

describe("Sign in to a hosted server", () => {
  it("offers only explicit cleanup retry for an unconfirmed completed sign-out", async () => {
    const user = userEvent.setup();
    const pending = {
      kind: "sign-out-pending",
      message: "Restore the broker, then finish signing out.",
    } as const;
    const mcpServerSignIn = vi.fn(async (request: { kind: string }) =>
      request.kind === "sign-out" ? ({ kind: "signed-out" } as const) : pending,
    );
    render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: mcpServerSignIn as never }}
        extensionId={extensionId}
        componentId={componentId}
        disabled={false}
      />,
    );
    await screen.findByRole("button", { name: "Finish signing out" });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Finish signing out" }));
    await screen.findByRole("button", { name: "Sign in" });
    expect(mcpServerSignIn.mock.calls.map(([request]) => request.kind)).toEqual([
      "status",
      "sign-out",
    ]);
  });

  it("keeps completed-grant cleanup retry after the real client deadline and ignores late success", async () => {
    const held = Promise.withResolvers<Response>();
    let signOuts = 0;
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1:9",
      windowCapability: "synthetic-window",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        return request.kind === "status"
          ? Response.json({ kind: "signed-in", issuer: "fixture.example" })
          : ++signOuts === 1
            ? held.promise
            : Response.json({ kind: "signed-out" });
      },
    });
    render(
      <McpServerSignInControl
        client={client}
        componentId={componentId}
        extensionId={extensionId}
        disabled={false}
      />,
    );
    const button = await screen.findByRole("button", { name: "Sign out" });
    vi.useFakeTimers();
    try {
      fireEvent.click(button);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_001);
      });
      expect(screen.getByRole("button", { name: "Finish signing out" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
      await act(async () => {
        held.resolve(Response.json({ kind: "signed-out" }));
        await held.promise;
      });
      expect(screen.getByRole("button", { name: "Finish signing out" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Finish signing out" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("Not signed in")).toBeInTheDocument();
      expect(signOuts).toBe(2);
    } finally {
      held.resolve(Response.json({ kind: "signed-out" }));
      vi.useRealTimers();
    }
  });

  it("does not schedule a poll into the generation of an interactive cancellation", async () => {
    vi.useFakeTimers();
    const cancel = Promise.withResolvers<McpServerSignInView>();
    const poll = Promise.withResolvers<McpServerSignInView>();
    const awaiting: McpServerSignInView = {
      kind: "awaiting-consent",
      attemptId: "55000000-0000-4000-8000-000000000001",
      authorizationUrl: "https://auth.example/authorize",
      expiresAt: "2026-11-02T01:00:00.000Z" as never,
    };
    const mcpServerSignIn = vi.fn(async (request: { kind: string }) =>
      request.kind === "status"
        ? awaiting
        : request.kind === "poll"
          ? poll.promise
          : cancel.promise,
    );
    try {
      render(
        <McpServerSignInControl
          client={{ mcpServerSignIn: mcpServerSignIn as never }}
          componentId={componentId}
          extensionId={extensionId}
          disabled={false}
          pollIntervalMs={50}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(51);
      });
      await act(async () => {
        cancel.resolve({ kind: "signed-out" });
        await cancel.promise;
      });
      expect(screen.getByText("Not signed in")).toBeInTheDocument();
      await act(async () => {
        poll.resolve({ kind: "signed-in", issuer: "reordered.example" });
        await poll.promise;
      });
      expect(screen.queryByText("Signed in through reordered.example")).not.toBeInTheDocument();
      expect(screen.getByText("Not signed in")).toBeInTheDocument();
      expect(mcpServerSignIn.mock.calls.some(([request]) => request.kind === "poll")).toBe(false);
    } finally {
      await act(async () => {
        cancel.resolve({ kind: "signed-out" });
        poll.resolve(awaiting);
        await Promise.all([cancel.promise, poll.promise]);
      });
      vi.useRealTimers();
    }
  });

  it("recovers a never-settling host Cancel through the real client deadline and ignores its late response", async () => {
    const held = Promise.withResolvers<Response>();
    let cancellations = 0;
    const awaiting = {
      kind: "awaiting-consent",
      attemptId: "55000000-0000-4000-8000-000000000001",
      authorizationUrl: "https://auth.example/authorize",
      expiresAt: "2026-11-02T01:00:00.000Z",
    };
    const client = createExtensionClient({
      baseUrl: "http://127.0.0.1:9",
      windowCapability: "synthetic-window",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        return request.kind === "status"
          ? Response.json(awaiting)
          : ++cancellations === 1
            ? held.promise
            : Response.json({ kind: "signed-out" });
      },
    });
    render(
      <McpServerSignInControl
        client={client}
        componentId={componentId}
        extensionId={extensionId}
        disabled={false}
        pollIntervalMs={60_000}
      />,
    );
    const cancel = await screen.findByRole("button", { name: "Cancel sign-in" });
    vi.useFakeTimers();
    try {
      fireEvent.click(cancel);
      expect(cancel).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_001);
      });
      expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
      expect(screen.getByText(/cancellation is not confirmed/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
      await act(async () => {
        held.resolve(Response.json({ kind: "signed-in", issuer: "late.example" }));
        await held.promise;
      });
      expect(screen.queryByText("Signed in through late.example")).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      });
      expect(screen.getByText("Not signed in")).toBeInTheDocument();
      expect(cancellations).toBe(2);
    } finally {
      held.resolve(Response.json({ kind: "signed-out" }));
      vi.useRealTimers();
    }
  });
  it("checks an unavailable pending status without starting another consent flow", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const mcpServerSignIn = vi.fn(async () =>
      reads++ === 0
        ? {
            kind: "status-unavailable",
            message: "Restore the broker, then check sign-in or cancel.",
          }
        : { kind: "signed-in", issuer: "auth.example" },
    );
    render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: mcpServerSignIn as never }}
        componentId={componentId}
        extensionId={extensionId}
        disabled={false}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Check sign-in" }));
    expect(await screen.findByText("Signed in through auth.example")).toBeInTheDocument();
    expect(mcpServerSignIn.mock.calls).toHaveLength(2);
  });
  it("keeps Cancel enabled during a held background poll and ignores the late poll after cancellation", async () => {
    const user = userEvent.setup();
    const held = Promise.withResolvers<McpServerSignInView>();
    const awaiting: McpServerSignInView = {
      kind: "awaiting-consent",
      attemptId: "55000000-0000-4000-8000-000000000001",
      authorizationUrl: "https://auth.example/authorize",
      expiresAt: "2026-11-02T01:00:00.000Z" as never,
    };
    const mcpServerSignIn = vi.fn(async (request: { kind: string }) =>
      request.kind === "status"
        ? awaiting
        : request.kind === "poll"
          ? held.promise
          : { kind: "signed-out" },
    );
    render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: mcpServerSignIn as never }}
        componentId={componentId}
        extensionId={extensionId}
        disabled={false}
        pollIntervalMs={1}
      />,
    );
    try {
      await waitFor(() =>
        expect(mcpServerSignIn.mock.calls.some(([request]) => request.kind === "poll")).toBe(true),
      );
      expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      expect(await screen.findByText("Not signed in")).toBeInTheDocument();
      await act(async () => {
        held.resolve({ kind: "signed-in", issuer: "late.example" });
        await held.promise;
      });
      expect(screen.queryByText("Signed in through late.example")).not.toBeInTheDocument();
      expect(screen.getByText("Not signed in")).toBeInTheDocument();
    } finally {
      await act(async () => {
        held.resolve(awaiting);
        await held.promise;
      });
    }
  });
  it("offers explicit cancellation and keeps an unavailable cancellation retry separate from new consent", async () => {
    const user = userEvent.setup();
    const views: McpServerSignInView[] = [
      {
        kind: "awaiting-consent",
        attemptId: "55000000-0000-4000-8000-000000000001",
        authorizationUrl: "https://auth.example/authorize",
        expiresAt: "2026-11-02T01:00:00.000Z" as never,
      },
      { kind: "cancel-pending", message: "Cancellation is not confirmed. Try again." },
      { kind: "signed-out" },
    ];
    const mcpServerSignIn = vi.fn(async () => views.shift() ?? { kind: "signed-out" });
    render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: mcpServerSignIn as never }}
        componentId={componentId}
        extensionId={extensionId}
        disabled={false}
        pollIntervalMs={60_000}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    expect(
      await screen.findByText("Cancellation is not confirmed. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the sign-in page" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    expect(mcpServerSignIn.mock.calls.slice(1)).toEqual([
      [{ kind: "sign-out", extensionId, componentId }],
      [{ kind: "sign-out", extensionId, componentId }],
    ]);
  });
  it("starts a sign-in, links to the page, keeps asking until it is done, and offers Sign out", async () => {
    const user = userEvent.setup();
    const views: McpServerSignInView[] = [
      { kind: "signed-out" },
      {
        kind: "awaiting-consent",
        attemptId: "55000000-0000-4000-8000-000000000001",
        authorizationUrl: "https://auth.example/authorize?x=1",
        expiresAt: "2026-10-20T12:10:00.000Z" as never,
      },
      { kind: "signed-in", issuer: "auth.example" },
      { kind: "signed-out" },
    ];
    const mcpServerSignIn = vi.fn(async () => views.shift() ?? { kind: "signed-out" });
    render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: mcpServerSignIn as never }}
        componentId={componentId}
        disabled={false}
        extensionId={extensionId}
        pollIntervalMs={10}
      />,
    );
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("link", { name: "Open the sign-in page" })).toHaveAttribute(
      "href",
      "https://auth.example/authorize?x=1",
    );
    expect(await screen.findByText("Signed in through auth.example")).toBeInTheDocument();
    expect(mcpServerSignIn).toHaveBeenNthCalledWith(3, {
      kind: "poll",
      extensionId,
      componentId,
      attemptId: "55000000-0000-4000-8000-000000000001",
    });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    expect(mcpServerSignIn).toHaveBeenLastCalledWith({
      kind: "sign-out",
      extensionId,
      componentId,
    });
  });

  it("shows nothing for a command server and the host's refusal for one that cannot register", async () => {
    const { container } = render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: async () => ({ kind: "not-applicable" }) }}
        componentId={componentId}
        disabled={false}
        extensionId={extensionId}
      />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    render(
      <McpServerSignInControl
        client={{
          mcpServerSignIn: async () => ({
            kind: "refused",
            reason: "client-registration-unavailable",
            message: "This server's sign-in needs a client id Octant cannot register for itself.",
          }),
        }}
        componentId={componentId}
        disabled={false}
        extensionId={extensionId}
      />,
    );
    expect(
      await screen.findByText(
        "This server's sign-in needs a client id Octant cannot register for itself.",
      ),
    ).toBeInTheDocument();
  });
});
