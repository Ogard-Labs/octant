import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ProviderToolingApplyResult,
  ProviderToolingListResult,
  ProviderToolingPlanResult,
  ProviderToolingRequest,
  ProviderToolingSection,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProviderToolingPanel, type ProviderToolingAccount } from "./ProviderToolingPanel";

const CLAUDE: ProviderToolingAccount = {
  id: "80000000-0000-4000-8000-0000000000a1",
  displayName: "Claude work",
  driverKind: "claude",
};
const CODEX: ProviderToolingAccount = {
  id: "80000000-0000-4000-8000-0000000000a2",
  displayName: "Codex home",
  driverKind: "codex",
};
const SECRET = "plain-secret-value-123";

function section(
  kind: ProviderToolingSection["kind"],
  patch: Partial<ProviderToolingSection> = {},
): ProviderToolingSection {
  return { kind, status: "listed", entries: [], lines: [], ...patch };
}

function listing(
  sections: ReadonlyArray<ProviderToolingSection>,
  runsAsItself = false,
  provider: "claude" | "codex" = "claude",
): ProviderToolingListResult {
  return {
    status: "listed",
    provider,
    accountDirectory: "/Users/me/.claude-work",
    runsAsItself,
    sections,
    notes: [],
  };
}

const EMPTY = [section("mcp-servers"), section("plugins"), section("marketplaces")];

function planFor(
  commandLine: string,
  patch: Partial<Extract<ProviderToolingPlanResult, { status: "planned" }>> = {},
) {
  return {
    status: "planned",
    planId: "11111111-1111-4111-8111-111111111111",
    digest: "a".repeat(64),
    expiresAt: "2026-11-01T10:00:00.000Z",
    provider: "claude",
    commandKind: "mcp-add-stdio",
    commandLine,
    summary: "Adds a local MCP server named files to this Claude Code account.",
    effects: ["Claude Code runs it on this computer."],
    usesSecret: false,
    runsAsItself: false,
    ...patch,
  } satisfies ProviderToolingPlanResult;
}

function setup(
  options: {
    accounts?: ReadonlyArray<ProviderToolingAccount>;
    list?: ProviderToolingListResult | (() => ProviderToolingListResult);
    plan?: ProviderToolingPlanResult;
    apply?: ProviderToolingApplyResult;
    localHost?: boolean;
  } = {},
) {
  const list = vi.fn(async () => {
    const value = options.list ?? listing(EMPTY);
    return typeof value === "function" ? value() : value;
  });
  const plan = vi.fn(
    async (_id: unknown, _request: ProviderToolingRequest) =>
      options.plan ?? planFor("claude mcp add --scope user -- files node"),
  );
  const apply = vi.fn(
    async (_request: unknown) =>
      options.apply ?? ({ status: "applied", output: "Added files" } as const),
  );
  const onOpenRunAsItself = vi.fn();
  render(
    <ProviderToolingPanel
      accounts={options.accounts ?? [CLAUDE]}
      client={{ list: list as never, plan: plan as never, apply: apply as never }}
      localHost={options.localHost ?? true}
      onOpenRunAsItself={onOpenRunAsItself}
    />,
  );
  return { list, plan, apply, onOpenRunAsItself, user: userEvent.setup() };
}

describe("ProviderToolingPanel", () => {
  it("only explains itself away from the host window, and asks the host for nothing", () => {
    const { list } = setup({ localHost: false });
    expect(screen.getByText(/Open Octant on this computer/)).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it("says plainly when there is no Claude Code or Codex account", () => {
    const { list } = setup({ accounts: [] });
    expect(screen.getByText(/No Claude Code or Codex account is set up yet/)).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it("tells the person a tool reaches Octant threads only when the account runs as itself, and links to that switch", async () => {
    const { user, onOpenRunAsItself } = setup();
    await screen.findByText("None added yet.", {}, { timeout: 3000 }).catch(() => undefined);
    expect(
      await screen.findByText(/reaches Octant threads only when Claude work runs as itself/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Run Claude Code as itself" }));
    expect(onOpenRunAsItself).toHaveBeenCalledWith(CLAUDE.id);
  });

  it("lists what the provider reports, and says when it cannot be read or the tool has no such command", async () => {
    setup({
      list: listing(
        [
          section("mcp-servers", { entries: [{ name: "files", detail: "node a - Connected" }] }),
          section("plugins", { status: "no-command" }),
          section("marketplaces", { status: "unreadable", lines: ["odd answer"] }),
        ],
        true,
      ),
    });
    expect(await screen.findByText("files")).toBeTruthy();
    expect(screen.getByText("node a - Connected")).toBeTruthy();
    expect(screen.getByText(/has no command for plugins/)).toBeTruthy();
    expect(screen.getByText("odd answer")).toBeTruthy();
    expect(screen.getByText(/Run Claude Code as itself is on for Claude work/)).toBeTruthy();
  });

  it("offers nothing for plugins when the installed tool has no command for them", async () => {
    const { user } = setup({
      list: listing([
        section("mcp-servers"),
        section("plugins", { status: "no-command" }),
        section("marketplaces"),
      ]),
    });
    await screen.findAllByText(/None added yet/);
    await user.click(screen.getByRole("button", { name: "Plugin" }));
    expect(screen.getAllByText(/has no command for plugins/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("form", { name: "Install a plugin" })).toBeNull();
  });

  it("shows the exact command first and runs it only after Run this command, once", async () => {
    const { user, plan, apply, list } = setup();
    await screen.findAllByText(/None added yet/);
    await user.type(screen.getByLabelText("Name"), "files");
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.type(screen.getByLabelText("Arguments"), "-y{Enter}a;b{Enter}$(id)");
    await user.click(screen.getByRole("button", { name: "Review command" }));

    expect(plan).toHaveBeenCalledWith(CLAUDE.id, {
      kind: "mcp-add-stdio",
      name: "files",
      command: "npx",
      args: ["-y", "a;b", "$(id)"],
      env: [],
    });
    expect(apply).not.toHaveBeenCalled();
    const command = await screen.findByLabelText("The command");
    expect(command.textContent).toBe("claude mcp add --scope user -- files node");

    await user.click(screen.getByRole("button", { name: "Run this command" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith({
      planId: "11111111-1111-4111-8111-111111111111",
      digest: "a".repeat(64),
    });
    expect(await screen.findByText(/Done\. The provider reported/)).toBeTruthy();
    expect(screen.getByText("Added files")).toBeTruthy();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
  });

  it("plans a removal and runs nothing when the person cancels", async () => {
    const { user, plan, apply } = setup({
      list: listing([
        section("mcp-servers", { entries: [{ name: "files" }] }),
        section("plugins"),
        section("marketplaces"),
      ]),
      plan: planFor("claude mcp remove --scope user files", { commandKind: "mcp-remove" }),
    });
    await user.click(await screen.findByRole("button", { name: "Remove files" }));
    expect(plan).toHaveBeenCalledWith(CLAUDE.id, { kind: "mcp-remove", name: "files" });
    expect((await screen.findByLabelText("The command")).textContent).toContain("mcp remove");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("The command")).toBeNull();
  });

  it("removes a plugin by its name and marketplace", async () => {
    const { user, plan } = setup({
      list: listing([
        section("mcp-servers"),
        section("plugins", { entries: [{ name: "hello", marketplace: "market", scope: "user" }] }),
        section("marketplaces"),
      ]),
    });
    await user.click(await screen.findByRole("button", { name: "Remove hello" }));
    expect(plan).toHaveBeenCalledWith(CLAUDE.id, {
      kind: "plugin-uninstall",
      plugin: "hello",
      marketplace: "market",
    });
  });

  it("sends a client secret once, clears it from the page, and shows only a placeholder", async () => {
    const { user, plan } = setup({
      plan: planFor(
        "MCP_CLIENT_SECRET=<secret> claude mcp add --client-secret -- hosted https://x.example/mcp",
        {
          usesSecret: true,
          commandKind: "mcp-add-url",
        },
      ),
    });
    await screen.findAllByText(/None added yet/);
    await user.type(screen.getByLabelText("Name"), "hosted");
    await user.click(screen.getByRole("button", { name: "Address" }));
    await user.type(screen.getByLabelText("Address"), "https://x.example/mcp");
    await user.type(screen.getByLabelText("OAuth client ID (optional)"), "client-1");
    await user.type(screen.getByLabelText("OAuth client secret (optional)"), SECRET);
    await user.click(screen.getByRole("button", { name: "Review command" }));

    expect(plan).toHaveBeenCalledWith(
      CLAUDE.id,
      expect.objectContaining({ oauthClientSecret: SECRET, oauthClientId: "client-1" }),
    );
    const command = await screen.findByLabelText("The command");
    expect(command.textContent).toContain("MCP_CLIENT_SECRET=<secret>");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByText(/The secret is held by Octant/)).toBeTruthy();
  });

  it("offers a bearer-token variable name for Codex and no secret field", async () => {
    const { user, plan } = setup({ accounts: [CODEX], list: listing(EMPTY, false, "codex") });
    await screen.findAllByText(/None added yet/);
    await user.type(screen.getByLabelText("Name"), "hosted");
    await user.click(screen.getByRole("button", { name: "Address" }));
    expect(screen.queryByLabelText("OAuth client secret (optional)")).toBeNull();
    await user.type(screen.getByLabelText("Address"), "https://x.example/mcp");
    await user.type(screen.getByLabelText("Bearer token variable (optional)"), "HOSTED_TOKEN");
    await user.click(screen.getByRole("button", { name: "Review command" }));
    expect(plan).toHaveBeenCalledWith(CODEX.id, {
      kind: "mcp-add-url",
      name: "hosted",
      url: "https://x.example/mcp",
      bearerTokenEnvVar: "HOSTED_TOKEN",
    });
  });

  it("shows the host's refusal in words and keeps the form", async () => {
    const { user, apply } = setup({
      plan: {
        status: "refused",
        reason: "invalid-value",
        message: "The server name may use letters, digits, dot, underscore and dash.",
        field: "name",
      },
    });
    await screen.findAllByText(/None added yet/);
    await user.type(screen.getByLabelText("Name"), "bad name");
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.click(screen.getByRole("button", { name: "Review command" }));
    expect(await screen.findByText(/The server name may use letters/)).toBeTruthy();
    expect(screen.getByRole("form", { name: "Add an MCP server" })).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports a command that failed with the provider's output", async () => {
    const { user } = setup({
      apply: {
        status: "failed",
        exitCode: 1,
        timedOut: false,
        output: "error: already exists",
        message: "The provider's command did not succeed.",
      },
    });
    await screen.findAllByText(/None added yet/);
    await user.type(screen.getByLabelText("Name"), "files");
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.click(screen.getByRole("button", { name: "Review command" }));
    await user.click(await screen.findByRole("button", { name: "Run this command" }));
    const alert = await screen.findByText(/The provider's command did not succeed/);
    expect(
      within(alert.closest("[role]") as HTMLElement).getByText("error: already exists"),
    ).toBeTruthy();
  });

  it("says so when the host cannot be reached", async () => {
    setup({ list: (() => Promise.reject(new Error("down"))) as never });
    expect(await screen.findByText(/could not reach the host/)).toBeTruthy();
  });
});
