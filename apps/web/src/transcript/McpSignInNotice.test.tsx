import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ExtensionClientFailure,
  type ExtensionClient,
} from "@octant/client-runtime/extension-client";
import type { McpServerConnection, McpServerSignInView } from "@octant/contracts/extension-rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerExtensionSelection } from "../composer/composerExtensionSelection";
import { McpSignInNotice } from "./McpSignInNotice";
// Loaded up front: the first load of the lazy half can outlast a findBy wait.
import "./McpSignInNotices";

const extensionId = "46000000-0000-4000-8000-000000000002";
let threadId = "";
let threads = 0;

// A dismissal lasts as long as the window, so each test opens its own thread.
beforeEach(() => {
  threads += 1;
  threadId = `46000000-0000-4000-8000-0000000001${String(threads).padStart(2, "0")}`;
});

const linear = {
  extensionId,
  packageId: "46000000-0000-4000-8000-000000000003",
  componentId: "mcp",
  packageName: "Linear",
  serverName: "Linear",
  transport: "streamable-http",
  state: "needs-sign-in",
  reason: "The sign-in expired. Sign in again.",
} as unknown as McpServerConnection;

const receipt = {
  label: "Linear",
  reference: "@linear",
  selection: {
    kind: "plugin",
    extensionId,
    packageId: linear.packageId,
    componentId: "mcp",
    packageVersion: "1.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    catalogEpoch: `sha256:${"b".repeat(64)}`,
    origin: { kind: "draft", reference: "@linear" },
  },
  status: { kind: "selected" },
} as unknown as ComposerExtensionSelection;

/** A host that needs a sign-in until `signedIn` is set, as its own record says. */
function host(
  options: {
    readonly person?: boolean;
    readonly begin?: McpServerSignInView;
    readonly unused?: boolean;
  } = {},
) {
  const state: {
    signedIn: boolean;
    read: "ok" | "unreachable" | "refused";
  } = { signedIn: false, read: "ok" };
  const client = {
    toolGrantsAvailable: options.person ?? true,
    mcpServersAwaitingSignIn: vi.fn(async () => {
      if (state.read === "unreachable") throw new TypeError("offline");
      if (state.read === "refused") throw new ExtensionClientFailure("unauthorized", "No.");
      return { servers: state.signedIn || options.unused === true ? [] : [linear] };
    }),
    mcpServerSignIn: vi.fn(async (request: { readonly kind: string }) =>
      request.kind === "begin" && options.begin !== undefined
        ? options.begin
        : state.signedIn
          ? { kind: "signed-in", issuer: "linear.app" }
          : { kind: "sign-in-again", reason: "expired" },
    ),
    relayMcpServerSignIn: vi.fn(async () => {
      state.signedIn = true;
      return { kind: "signed-in", issuer: "linear.app" };
    }),
  };
  return { client: client as unknown as ExtensionClient, calls: client, state };
}

function notice(
  client: ExtensionClient | undefined,
  overrides: Partial<Parameters<typeof McpSignInNotice>[0]> = {},
) {
  return (
    <McpSignInNotice
      className="thread-column"
      client={client}
      mode="code"
      onResolveReference={async () => true}
      receipts={[]}
      selections={[]}
      threadId={threadId}
      turnActive={false}
      {...overrides}
    />
  );
}

const card = () => screen.findByRole("status", { name: "Linear needs sign-in" });

describe("signing in to a server from the thread", () => {
  it("names the server the thread needs and offers the existing sign-in", async () => {
    const { client, calls } = host();
    render(notice(client, { receipts: [receipt] }));
    const shown = await card();
    expect(shown).toHaveTextContent("Linear needs sign-in");
    expect(await within(shown).findByRole("button", { name: "Sign in again" })).toBeEnabled();
    expect(calls.mcpServersAwaitingSignIn).toHaveBeenCalledWith(
      { mode: "code", threadId, selections: [receipt.selection], references: [] },
      expect.any(AbortSignal),
    );
  });

  it("asks about a name the composer refused, and selects it again once signed in", async () => {
    const user = userEvent.setup();
    const { client, calls } = host({
      begin: {
        kind: "awaiting-consent",
        attemptId: "46000000-0000-4000-8000-000000000009",
        authorizationUrl: "https://linear.app/authorize",
        relayable: true,
        expiresAt: "2026-11-25T23:00:00.000Z",
      } as never,
    });
    const onResolveReference = vi.fn(async () => true);
    const refused = {
      label: "@linear",
      reference: "@linear",
      status: { kind: "blocked", reason: "unavailable" },
    } as const;
    render(notice(client, { receipts: [refused], onResolveReference }));
    await user.click(await screen.findByRole("button", { name: "Sign in again" }));
    expect(calls.mcpServersAwaitingSignIn).toHaveBeenCalledWith(
      { mode: "code", threadId, selections: [], references: ["@linear"] },
      expect.any(AbortSignal),
    );
    expect(onResolveReference).not.toHaveBeenCalled();
    await user.type(
      await screen.findByRole("textbox", { name: "Callback address" }),
      "http://127.0.0.1:4000/oauth/callback",
    );
    await user.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => expect(onResolveReference).toHaveBeenCalledExactlyOnceWith("@linear"));
  });

  it("shows nothing in a thread that uses no server needing sign-in", async () => {
    const { client, calls } = host({ unused: true });
    const { container } = render(notice(client));
    await waitFor(() => expect(calls.mcpServersAwaitingSignIn).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(calls.mcpServerSignIn).not.toHaveBeenCalled();
  });

  it("asks and shows nothing for a device that may not sign in, or a read-only thread", async () => {
    const restricted = host({ person: false });
    const { container, rerender } = render(notice(restricted.client));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restricted.calls.mcpServersAwaitingSignIn).not.toHaveBeenCalled();
    rerender(notice(undefined));
    expect(container).toBeEmptyDOMElement();
  });

  it("finishes a paired device's sign-in by pasting the address back, then says the next message can use it", async () => {
    const user = userEvent.setup();
    const { client, calls } = host({
      begin: {
        kind: "awaiting-consent",
        attemptId: "46000000-0000-4000-8000-000000000009",
        authorizationUrl: "https://linear.app/authorize",
        relayable: true,
        expiresAt: "2026-11-25T23:00:00.000Z",
      } as never,
    });
    render(notice(client));
    await user.click(await screen.findByRole("button", { name: "Sign in again" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Callback address" }),
      "http://127.0.0.1:4000/oauth/callback?code=x&state=y",
    );
    await user.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect(calls.relayMcpServerSignIn).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("Signed in to Linear. You can use it from the next message."),
    ).toBeVisible();
    expect(screen.queryByText("Linear needs sign-in")).toBeNull();
  });

  it("clears when the server is signed in elsewhere, at the next read", async () => {
    const { client, state } = host();
    const { rerender } = render(notice(client));
    await card();
    state.signedIn = true;
    rerender(notice(client, { turnActive: true }));
    await waitFor(() => expect(screen.queryByText("Linear needs sign-in")).toBeNull());
  });

  it("stays through a read that could not reach the host, and goes when the host refuses it", async () => {
    const { client, calls, state } = host();
    const { rerender } = render(notice(client));
    await card();
    state.read = "unreachable";
    rerender(notice(client, { turnActive: true }));
    await waitFor(() => expect(calls.mcpServersAwaitingSignIn).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Linear needs sign-in")).toBeVisible();
    state.read = "refused";
    rerender(notice(client, { turnActive: false }));
    await waitFor(() => expect(screen.queryByText("Linear needs sign-in")).toBeNull());
  });

  it("stays dismissed in this thread until the thread stops waiting on it and then does again", async () => {
    const user = userEvent.setup();
    const { client, calls, state } = host();
    const first = render(notice(client));
    await user.click(
      within(await card()).getByRole("button", { name: "Dismiss the Linear sign-in notice" }),
    );
    expect(screen.queryByText("Linear needs sign-in")).toBeNull();
    first.unmount();

    const { rerender } = render(notice(client));
    await waitFor(() => expect(calls.mcpServersAwaitingSignIn).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Linear needs sign-in")).toBeNull();

    state.signedIn = true;
    rerender(notice(client, { turnActive: true }));
    await waitFor(() => expect(calls.mcpServersAwaitingSignIn).toHaveBeenCalledTimes(3));
    state.signedIn = false;
    rerender(notice(client, { turnActive: false }));
    expect(await card()).toBeVisible();
  });

  it("starts clean when the pane shows another thread", async () => {
    const { client, calls } = host();
    const { rerender } = render(notice(client));
    await card();
    calls.mcpServersAwaitingSignIn.mockResolvedValue({ servers: [] });
    rerender(notice(client, { threadId: "46000000-0000-4000-8000-000000000999" }));
    expect(screen.queryByText("Linear needs sign-in")).toBeNull();
  });
});
