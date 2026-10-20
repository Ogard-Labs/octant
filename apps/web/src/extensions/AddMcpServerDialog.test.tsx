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
});
