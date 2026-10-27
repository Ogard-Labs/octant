import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddMcpServerDialog } from "./AddMcpServerDialog";

describe("Add MCP server", () => {
  it("sends a command server with its arguments and a secret variable, then reports it added", async () => {
    const user = userEvent.setup();
    const addUserMcpServer = vi.fn(async () => ({ kind: "extension-state-updated" }) as never);
    const onAdded = vi.fn();
    render(
      <AddMcpServerDialog
        client={{ addUserMcpServer }}
        onAdded={onAdded}
        onClose={vi.fn()}
        open
        secretsAvailable
      />,
    );
    const form = screen.getByRole("form", { name: "Add an MCP server" });
    await user.type(within(form).getByLabelText("Name"), "Docs search");
    await user.type(within(form).getByLabelText("Command"), "npx");
    await user.type(within(form).getByLabelText("Arguments"), "-y\ndocs-search-mcp");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await user.type(within(form).getByLabelText("Variable name"), "DOCS_TOKEN");
    await user.type(within(form).getByLabelText("Value"), "private-value");
    await user.click(within(form).getByRole("checkbox", { name: "Secret" }));
    await user.click(within(form).getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(addUserMcpServer).toHaveBeenCalledWith({
      name: "Docs search",
      server: {
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-search-mcp"],
        env: [{ name: "DOCS_TOKEN", value: "private-value", secret: true }],
      },
    });
  });

  it("names the credential store of the computer a secret is kept on", () => {
    // Only the window on the host can keep a secret, so the platform it
    // reports is the host's. A Linux host read "this Mac's".
    Object.defineProperty(window.navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    });
    try {
      render(
        <AddMcpServerDialog
          client={{ addUserMcpServer: vi.fn() as never }}
          onAdded={vi.fn()}
          onClose={vi.fn()}
          open
          secretsAvailable
        />,
      );
      expect(
        screen.getByText(/A secret value is kept in this computer's credential store/),
      ).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(window.navigator, "platform");
    }
  });

  it("sends an address server with a header and shows the host's refusal in its own words", async () => {
    const user = userEvent.setup();
    const addUserMcpServer = vi.fn(
      async () =>
        ({
          kind: "extension-command-failed",
          failure: { category: "conflict", message: "A server with this name is already added." },
        }) as never,
    );
    render(
      <AddMcpServerDialog
        client={{ addUserMcpServer }}
        onAdded={vi.fn()}
        onClose={vi.fn()}
        open
        secretsAvailable={false}
      />,
    );
    const form = screen.getByRole("form", { name: "Add an MCP server" });
    await user.type(within(form).getByLabelText("Name"), "Remote");
    await user.click(within(form).getByRole("button", { name: "Address" }));
    await user.type(within(form).getByLabelText("Address"), "https://mcp.example/mcp");
    await user.click(within(form).getByRole("button", { name: "Add header" }));
    await user.type(within(form).getByLabelText("Header name"), "X-Team");
    await user.type(within(form).getByLabelText("Value"), "docs");
    expect(within(form).getByRole("checkbox", { name: "Secret" })).toBeDisabled();
    await user.click(within(form).getByRole("button", { name: "Add server" }));

    expect(
      await screen.findByText("A server with this name is already added."),
    ).toBeInTheDocument();
    expect(addUserMcpServer).toHaveBeenCalledWith({
      name: "Remote",
      server: {
        type: "streamable-http",
        url: "https://mcp.example/mcp",
        headers: [{ name: "X-Team", value: "docs", secret: false }],
      },
    });
  });

  it("never sends a variable typed for a command as a header after switching to Address", async () => {
    const user = userEvent.setup();
    const addUserMcpServer = vi.fn(async () => ({ kind: "extension-state-updated" }) as never);
    render(
      <AddMcpServerDialog
        client={{ addUserMcpServer }}
        onAdded={vi.fn()}
        onClose={vi.fn()}
        open
        secretsAvailable
      />,
    );
    const form = screen.getByRole("form", { name: "Add an MCP server" });
    await user.type(within(form).getByLabelText("Name"), "Docs search");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await user.type(within(form).getByLabelText("Variable name"), "DOCS_TOKEN");
    await user.type(within(form).getByLabelText("Value"), "local-only-value");
    await user.click(within(form).getByRole("checkbox", { name: "Secret" }));

    await user.click(within(form).getByRole("button", { name: "Address" }));
    expect(within(form).queryByLabelText("Header name")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("Address"), "https://mcp.example/mcp");
    await user.click(within(form).getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(addUserMcpServer).toHaveBeenCalled());
    expect(addUserMcpServer).toHaveBeenCalledWith({
      name: "Docs search",
      server: { type: "streamable-http", url: "https://mcp.example/mcp", headers: [] },
    });
    expect(JSON.stringify(addUserMcpServer.mock.calls)).not.toContain("local-only-value");

    // The variable is still there for the command if the person switches back.
    await user.click(within(form).getByRole("button", { name: "Command" }));
    expect(within(form).getByLabelText("Variable name")).toHaveValue("DOCS_TOKEN");
  });

  it("keeps a variable's name and value side by side on a phone instead of overlapping", () => {
    // Observed at 390px: the value sat in an auto-sized column that began
    // inside the name field, so the two inputs overlapped by 46px.
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles/extensions-settings.css"),
      "utf8",
    ).replace(/\s+/g, " ");
    const narrow = /@media \(max-width: 640px\) \{(.*?)\} \}/.exec(
      styles.slice(styles.indexOf(".mcp-server-values__row")),
    )?.[1];
    expect(narrow).toMatch(
      /\.mcp-server-values__row \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/,
    );
    expect(narrow).toMatch(/\.mcp-server-values__row > input \{ min-width: 0; \}/);
  });
});
