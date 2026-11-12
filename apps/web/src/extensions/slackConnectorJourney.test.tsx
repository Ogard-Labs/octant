import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionClient } from "@octant/client-runtime/extension-client";
import { createSecretStoresClient } from "@octant/client-runtime/secret-stores-client";
import { connectorById } from "@octant/domain";
import {
  decodeMcpServerSignInRequest,
  decodeMcpServerSignInView,
  type McpServerSignInRequest,
} from "@octant/contracts/extension-rpc";
import { SecretStoresClientContext } from "../settings/SecretStoresClientContext";
import { LibraryView } from "./LibraryView";
import { buildLibrary } from "./libraryModel";
import { ConnectorsView } from "./ConnectorsView";
import { McpServerSignInControl } from "./McpServerSignInControl";

describe.each(["slack", "github-oauth", "github-repositories"] as const)(
  "registered %s connector journey",
  (connectorId) => {
    const entry = connectorById(connectorId);
    if (entry === undefined || entry.auth.kind !== "sign-in")
      throw new Error("Expected registered connector");
    const extensionId = "44000000-0000-4000-8000-000000000002";
    const componentId = `mcp-${connectorId}`;
    const resource = connectorId === "slack" ? "https://mcp.slack.com" : entry.url;
    const issuer = connectorId === "slack" ? resource : "https://github.com/login/oauth";
    const callback =
      connectorId === "slack"
        ? "http://localhost:43125/oauth/callback"
        : "http://127.0.0.1:43125/oauth/callback";
    const tokenEndpoint =
      connectorId === "slack"
        ? "https://slack.com/api/oauth.v2.user.access"
        : "https://github.com/login/oauth/access_token";
    const authorizationUrl =
      connectorId === "slack"
        ? "https://slack.com/oauth/v2_user/authorize"
        : "https://github.com/login/oauth/authorize";
    const displayName = entry.displayName;
    const guideUrl = entry.auth.setupGuide;
    if (guideUrl === undefined) throw new Error("Expected a documented setup guide");
    const requestedScopes = entry.auth.requestedScopes ?? [];
    const setupSteps = entry.auth.setupSteps ?? [];
    const registration = {
      guideUrl,
      requestedScopes,
      setupSteps,
      ...(entry.auth.permissionNotice === undefined
        ? {}
        : { permissionNotice: entry.auth.permissionNotice }),
    };
    beforeEach(() => localStorage.clear());

    function fixture() {
      let configured = false;
      const requests: McpServerSignInRequest[] = [];
      const adds: unknown[] = [];
      const fetchImpl: typeof fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/secret-stores/settings")
            return Response.json({
              kind: "secret-stores-view",
              brokerAvailable: true,
              stores: [{ kind: "onepassword", label: "1Password", linked: true, tool: "ready" }],
            });
          if (path === "/api/extensions/user-servers") {
            adds.push(JSON.parse(String(init?.body)));
            return Response.json({
              kind: "extension-state-updated",
              snapshot: {
                sequence: 1,
                snapshotAt: "2026-11-02T00:00:00.000Z",
                packages: [],
                collisions: [],
              },
              addedPackage: { extensionId, componentId },
            });
          }
          if (path !== "/api/extensions/sign-in") throw new Error("Unexpected fixture endpoint");
          const request = decodeMcpServerSignInRequest(JSON.parse(String(init?.body)));
          requests.push(request);
          if (request.kind === "prepare-client")
            return Response.json({
              kind: "client-setup",
              ...(connectorId === "github-repositories"
                ? { mcpPermissionProfile: "github-repositories-read-write" }
                : {}),
              resource,
              issuer,
              tokenEndpoint,
              callback,
              metadataClientSupported: false,
              authenticationMethods: ["client_secret_post"],
              secretStoreAvailable: true,
            });
          if (request.kind === "save-client") {
            configured = true;
            return Response.json({ kind: "client-configured" });
          }
          if (request.kind === "begin" || request.kind === "poll")
            return Response.json({
              kind: "awaiting-consent",
              attemptId: "55000000-0000-4000-8000-000000000001",
              authorizationUrl,
              expiresAt: "2026-11-02T23:59:59.000Z",
            });
          return Response.json(
            configured
              ? { kind: "signed-out" }
              : {
                  kind: "client-setup-required",
                  message: "Set up your registered app before signing in.",
                },
          );
        },
        { preconnect: () => undefined },
      );
      const options = {
        baseUrl: "http://127.0.0.1:9",
        windowCapability: "synthetic-window",
        fetch: fetchImpl,
      };
      return {
        client: createExtensionClient(options),
        secrets: createSecretStoresClient(options),
        requests,
        adds,
      };
    }

    function surface(
      kind: "library" | "connectors",
      setup: ReturnType<typeof fixture>,
      localHost = true,
    ) {
      const slack = connectorById(connectorId);
      if (slack === undefined) throw new Error("Expected registered connector entry");
      return kind === "library" ? (
        <LibraryView
          items={buildLibrary({ snapshot: undefined, connectors: [slack] })}
          actions={null}
          marketplaceFetchesEnabled={false}
          disabled={false}
          localHost={localHost}
          connectClient={setup.client}
          onOpen={vi.fn()}
          onTrust={vi.fn()}
          onPluginDesired={vi.fn()}
        />
      ) : (
        <ConnectorsView
          client={setup.client}
          snapshot={undefined}
          localHost={localHost}
          disabled={false}
          actions={null}
          onConnected={vi.fn()}
        />
      );
    }

    async function connect(
      kind: "library" | "connectors",
      user: ReturnType<typeof userEvent.setup>,
    ) {
      if (kind === "library") {
        await user.click(screen.getByRole("button", { name: `Connect… ${displayName}` }));
        await user.click(
          within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }),
        );
      } else await user.click(screen.getByRole("button", { name: `Connect ${displayName}` }));
    }

    it.each(["library", "connectors"] as const)(
      "refuses remote Connect before package or setup requests (%s)",
      async (kind) => {
        const setup = fixture();
        const user = userEvent.setup();
        render(surface(kind, setup, false));
        if (kind === "library") {
          await user.click(screen.getByRole("button", { name: `Connect… ${displayName}` }));
          expect(
            within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }),
          ).toBeDisabled();
        } else
          expect(screen.getByRole("button", { name: `Connect ${displayName}` })).toBeDisabled();
        expect(setup.adds).toEqual([]);
        expect(setup.requests).toEqual([]);
      },
    );

    it.each([
      "account-changed",
      "permission-missing",
      "permission-mismatch",
      "identity-unavailable",
    ] as const)(
      "requires explicit reconnect for a reported account or permission refusal (%s)",
      async (reason) => {
        const user = userEvent.setup();
        const mcpServerSignIn = vi.fn(async (request: { kind: string }) =>
          request.kind === "begin"
            ? decodeMcpServerSignInView({
                kind: "awaiting-consent",
                attemptId: "55000000-0000-4000-8000-000000000001",
                authorizationUrl,
                expiresAt: "2026-11-02T23:59:59.000Z",
              })
            : ({ kind: "sign-in-again", reason } as const),
        );
        render(
          <McpServerSignInControl
            client={{ mcpServerSignIn }}
            extensionId={extensionId}
            componentId={componentId}
            registration={registration}
            disabled={false}
          />,
        );
        await screen.findByRole("button", { name: "Sign in again" });
        expect(mcpServerSignIn.mock.calls.map(([request]) => request.kind)).toEqual(["status"]);
        await user.click(screen.getByRole("button", { name: "Sign in again" }));
        await screen.findByRole("link", { name: "Open the sign-in page" });
        expect(mcpServerSignIn.mock.calls.map(([request]) => request.kind)).toEqual([
          "status",
          "begin",
        ]);
      },
    );

    it.each(["library", "connectors"] as const)(
      "prepares app setup on explicit Connect, saves without consent and requires explicit Sign in (%s)",
      async (kind) => {
        const user = userEvent.setup();
        const setup = fixture();
        render(
          <SecretStoresClientContext.Provider value={setup.secrets}>
            {surface(kind, setup)}
          </SecretStoresClientContext.Provider>,
        );
        expect(setup.requests).toEqual([]);
        expect(setup.adds).toEqual([]);
        await connect(kind, user);
        const dialog = await screen.findByRole("dialog", { name: "Client setup" });
        expect(within(dialog).getByLabelText("Callback address")).toHaveValue(callback);
        for (const step of setupSteps) {
          expect(screen.getAllByText(step).length).toBeGreaterThan(0);
        }
        if (connectorId === "github-repositories")
          expect(
            within(dialog).getByText(
              /allows read and write access to public and private repositories/i,
            ),
          ).toBeInTheDocument();
        expect(setup.requests.map((request) => request.kind)).toEqual(["status", "prepare-client"]);
        expect(setup.adds).toEqual([
          {
            name: entry.displayName,
            connectorId,
            server: { type: "streamable-http", url: entry.url, headers: [] },
          },
        ]);
        await user.type(within(dialog).getByLabelText("Client ID"), "owned-fixture-client");
        await user.type(
          within(dialog).getByLabelText("Client secret item reference"),
          "op://Private/Slack/client secret",
        );
        await user.click(within(dialog).getByRole("button", { name: "Save client setup" }));
        await screen.findByRole("button", { name: "Sign in" });
        const saved = setup.requests.find((request) => request.kind === "save-client");
        expect(saved).toMatchObject({
          setup: {
            binding: { resource, issuer, tokenEndpoint, callback },
            authentication: "client_secret_post",
            clientId: "owned-fixture-client",
            secret: { store: "onepassword", reference: "op://Private/Slack/client secret" },
          },
        });
        if (connectorId === "github-repositories") {
          expect(saved).toMatchObject({
            setup: { binding: { mcpPermissionProfile: "github-repositories-read-write" } },
          });
          expect(
            screen.getByText(/allows read and write access to public and private repositories/i),
          ).toBeInTheDocument();
        }
        expect(setup.requests.some((request) => request.kind === "begin")).toBe(false);
        await user.click(screen.getByRole("button", { name: "Sign in" }));
        await screen.findByRole("link", { name: "Open the sign-in page" });
        expect(setup.requests.filter((request) => request.kind === "begin")).toHaveLength(1);
      },
    );

    it("does not repeat setup discovery when filtering the legacy connector list after cancelling setup", async () => {
      const user = userEvent.setup();
      const setup = fixture();
      render(
        <SecretStoresClientContext.Provider value={setup.secrets}>
          {surface("connectors", setup)}
        </SecretStoresClientContext.Provider>,
      );
      await connect("connectors", user);
      const dialog = await screen.findByRole("dialog", { name: "Client setup" });
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await user.type(
        screen.getByRole("textbox", { name: "Search connectors" }),
        "nothing-matches-fixture",
      );
      await user.clear(screen.getByRole("textbox", { name: "Search connectors" }));
      await screen.findByRole("button", { name: "Client setup" });
      await waitFor(() =>
        expect(setup.requests.filter((request) => request.kind === "status")).toHaveLength(2),
      );
      expect(setup.requests.filter((request) => request.kind === "prepare-client")).toHaveLength(1);
      expect(setup.requests.some((request) => request.kind === "begin")).toBe(false);
    });

    it.each([
      undefined,
      {
        ...(connectorId === "slack" ? { workspaceId: "TTEST001" } : {}),
        userId: connectorId === "slack" ? "UTEST001" : "12345",
        grantedScopes: requestedScopes.filter((scope) => scope !== "offline_access"),
      },
    ])(
      "shows only reported account facts and task readiness remains unchecked (%j)",
      async (account) => {
        const mcpServerSignIn = vi.fn(
          async () =>
            ({
              kind: "signed-in",
              issuer,
              ...(account === undefined ? {} : { account }),
            }) as const,
        );
        render(
          <McpServerSignInControl
            client={{ mcpServerSignIn }}
            extensionId={extensionId}
            componentId={componentId}
            registration={registration}
            disabled={false}
          />,
        );
        await screen.findByText(`Reported workspace ID: ${account?.workspaceId ?? "Not reported"}`);
        expect(
          screen.getByText(`Reported user ID: ${account?.userId ?? "Not reported"}`),
        ).toBeInTheDocument();
        expect(
          screen.getByText(
            `Last reported permissions: ${account?.grantedScopes.join(", ") ?? "Not reported"}`,
          ),
        ).toBeInTheDocument();
        expect(
          screen.getByText("Tools are checked when selected for an authorized task."),
        ).toBeInTheDocument();
        expect(mcpServerSignIn).toHaveBeenCalledTimes(1);
      },
    );
  },
);
