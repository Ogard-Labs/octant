import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { McpServerSignInView } from "@octant/contracts/extension-rpc";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SecretStoresClientContext } from "../settings/SecretStoresClientContext";
import { McpServerSignInControl } from "./McpServerSignInControl";

const target = { extensionId: "44000000-0000-4000-8000-000000000002", componentId: "mcp-docs" };
const prepared: Extract<McpServerSignInView, { kind: "client-setup" }> = {
  kind: "client-setup",
  resource: "https://mcp.example/mcp",
  issuer: "https://auth.example",
  tokenEndpoint: "https://auth.example/token",
  callback: "http://127.0.0.1:43125/oauth/callback",
  metadataClientSupported: true,
  authenticationMethods: ["none", "client_secret_post", "client_secret_basic"],
  secretStoreAvailable: true,
};

const binding = {
  resource: prepared.resource,
  issuer: prepared.issuer,
  tokenEndpoint: prepared.tokenEndpoint,
  callback: prepared.callback,
};

function setup(
  options: {
    readonly view?: typeof prepared;
    readonly refuseSave?: boolean;
    readonly removed?: boolean;
    readonly linked?: boolean;
    readonly disabled?: boolean;
  } = {},
) {
  const mcpServerSignIn = vi.fn<ExtensionClient["mcpServerSignIn"]>(async (request) => {
    if (request.kind === "prepare-client") return options.view ?? prepared;
    if (request.kind === "save-client" && options.removed) return { kind: "not-applicable" };
    if (request.kind === "save-client" && options.refuseSave)
      return {
        kind: "refused",
        reason: "unavailable",
        message: "Unlock the linked store and try again.",
      };
    return request.kind === "save-client" ? { kind: "client-configured" } : { kind: "signed-out" };
  });
  const control = (
    <McpServerSignInControl
      client={{ mcpServerSignIn }}
      {...target}
      disabled={options.disabled ?? false}
    />
  );
  render(
    options.linked ? (
      <SecretStoresClientContext.Provider
        value={
          {
            read: async () => ({
              kind: "secret-stores-view",
              stores: [{ kind: "onepassword", linked: true, label: "1Password" }],
            }),
          } as never
        }
      >
        {control}
      </SecretStoresClientContext.Provider>
    ) : (
      control
    ),
  );
  return { mcpServerSignIn };
}

describe("MCP application identity setup", () => {
  it("selects the only advertised confidential method and saves the exact displayed localhost callback separately from consent", async () => {
    const user = userEvent.setup();
    const slack = {
      ...prepared,
      resource: "https://mcp.slack.com",
      issuer: "https://mcp.slack.com",
      tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
      callback: "http://localhost:43125/oauth/callback",
      metadataClientSupported: false,
      authenticationMethods: ["client_secret_post"] as const,
    };
    const { mcpServerSignIn } = setup({ linked: true, view: slack });
    await user.click(await screen.findByRole("button", { name: "Client setup" }));
    expect(await screen.findByLabelText("Callback address")).toHaveValue(slack.callback);
    await user.type(screen.getByLabelText("Client ID"), "owned-slack-client");
    const item = await screen.findByLabelText("Client secret item reference");
    await waitFor(() => expect(item).toBeEnabled());
    await user.type(item, "op://Private/Slack/client secret");
    await user.click(screen.getByRole("button", { name: "Save client setup" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mcpServerSignIn).toHaveBeenCalledWith({
      kind: "save-client",
      ...target,
      setup: {
        binding: {
          resource: slack.resource,
          issuer: slack.issuer,
          tokenEndpoint: slack.tokenEndpoint,
          callback: slack.callback,
        },
        kind: "registered",
        clientId: "owned-slack-client",
        authentication: "client_secret_post",
        secret: { store: "onepassword", reference: "op://Private/Slack/client secret" },
      },
    });
    expect(mcpServerSignIn.mock.calls.some(([request]) => request.kind === "begin")).toBe(false);
  });
  it("discovers only after a click, shows and copies the exact callback, and saves separately from consent", async () => {
    const user = userEvent.setup();
    const { mcpServerSignIn } = setup();
    await screen.findByText("Not signed in");
    expect(mcpServerSignIn).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Client setup" }));
    expect(await screen.findByRole("dialog", { name: "Client setup" })).toBeInTheDocument();
    expect(screen.getByLabelText("Callback address")).toHaveValue(prepared.callback);
    expect(screen.getByLabelText("Authorization server")).toHaveValue(prepared.issuer);
    await user.click(screen.getByRole("button", { name: "Copy callback" }));
    expect(await navigator.clipboard.readText()).toBe(prepared.callback);
    await user.click(screen.getByRole("button", { name: "Save client setup" }));
    expect(screen.getByLabelText("Client ID")).toHaveFocus();
    await user.type(screen.getByLabelText("Client ID"), "owned-public-client");
    await user.click(screen.getByRole("button", { name: "Save client setup" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Client setup saved.")).toBeInTheDocument();
    expect(mcpServerSignIn).toHaveBeenCalledWith({
      kind: "save-client",
      ...target,
      setup: {
        binding,
        kind: "registered",
        clientId: "owned-public-client",
        authentication: "none",
      },
    });
    expect(mcpServerSignIn.mock.calls.some(([request]) => request.kind === "begin")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mcpServerSignIn).toHaveBeenLastCalledWith({ kind: "begin", ...target });
  });

  it("offers advertised metadata identity and preserves input on a refused save", async () => {
    const user = userEvent.setup();
    const { mcpServerSignIn } = setup({ refuseSave: true });
    await user.click(await screen.findByRole("button", { name: "Client setup" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Client metadata URL" }));
    await user.type(
      screen.getByLabelText("Client metadata URL"),
      "https://client.example/app.json",
    );
    await user.click(screen.getByRole("button", { name: "Save client setup" }));
    expect(await screen.findByText("Unlock the linked store and try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Client metadata URL")).toHaveValue(
      "https://client.example/app.json",
    );
    expect(mcpServerSignIn).toHaveBeenCalledWith({
      kind: "save-client",
      ...target,
      setup: {
        binding,
        kind: "metadata-document",
        clientId: "https://client.example/app.json",
        authentication: "none",
      },
    });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Client setup" })).toHaveFocus());
  });

  it("disables unadvertised metadata and unavailable secret setup with a reason", async () => {
    const user = userEvent.setup();
    setup({ view: { ...prepared, metadataClientSupported: false, secretStoreAvailable: false } });
    await user.click(await screen.findByRole("button", { name: "Client setup" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Client metadata URL" })).toBeDisabled();
    expect(
      screen.getByText("This authorization server does not advertise client metadata URLs."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Client secret (POST)" }));
    expect(screen.getByLabelText("Client secret item reference")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save client setup" })).toBeDisabled();
    expect(screen.getByText(/Link a secret store in Settings to choose/)).toBeInTheDocument();
  });

  it("uses a linked item address without exposing a broker id or a raw-secret input", async () => {
    const user = userEvent.setup();
    const { mcpServerSignIn } = setup({ linked: true });
    await user.click(await screen.findByRole("button", { name: "Client setup" }));
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Client ID"), "owned-confidential-client");
    await user.click(screen.getByRole("button", { name: "Client secret (Basic)" }));
    const item = await screen.findByLabelText("Client secret item reference");
    await waitFor(() => expect(item).toBeEnabled());
    await user.type(item, "op://Private/My app/client secret");
    await user.click(screen.getByRole("button", { name: "Save client setup" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mcpServerSignIn).toHaveBeenCalledWith({
      kind: "save-client",
      ...target,
      setup: {
        binding,
        kind: "registered",
        clientId: "owned-confidential-client",
        authentication: "client_secret_basic",
        secret: { store: "onepassword", reference: "op://Private/My app/client secret" },
      },
    });
  });
  it("does not acknowledge a removed target as saved application setup", async () => {
    const user = userEvent.setup();
    setup({ removed: true });
    await user.click(await screen.findByRole("button", { name: "Client setup" }));
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Client ID"), "kept-client");
    await user.click(screen.getByRole("button", { name: "Save client setup" }));
    expect(
      await screen.findByText("The server is no longer available for client setup."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Client ID")).toHaveValue("kept-client");
    expect(screen.queryByText("Client setup saved.")).not.toBeInTheDocument();
  });
});
