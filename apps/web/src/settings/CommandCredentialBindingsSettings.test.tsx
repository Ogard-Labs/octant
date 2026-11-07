import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import {
  decodeCommandCredentialBinding,
  type CommandCredentialResult,
} from "@octant/contracts/command-credentials";
import { CommandCredentialBindingsSettings } from "./CommandCredentialBindingsSettings";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = decodeCommandCredentialBinding({
  kind: "command-credential-binding",
  bindingId: id(1),
  revision: 1,
  credentialExecutable: "/usr/local/bin/op",
  credentialExecutableDigest: "b".repeat(64),
  credentialVersion: "2.33.0",
  executableDigest: "a".repeat(64),
  definition: {
    label: "Old host command",
    projectId: id(2),
    executable: "/usr/bin/client",
    args: ["status"],
    directory: "",
    accountId: "a".repeat(26),
    environment: [
      { name: "API_TOKEN", vaultId: "v".repeat(26), itemId: "i".repeat(26), fieldId: "credential" },
    ],
    timeoutMs: 1000,
  },
});
const empty = {
  kind: "command-credential-view" as const,
  bindings: [],
  requests: [],
  receipts: [],
};
describe("reference binding Settings", () => {
  it("discards a delayed mutation from a previous host client", async () => {
    let finish: ((result: CommandCredentialResult) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<CommandCredentialResult>((resolve) => {
          finish = resolve;
        }),
    );
    const old = { read: vi.fn(async () => ({ ...empty, bindings: [binding] })), execute };
    const user = userEvent.setup();
    const projects = new Map([[id(2), "Fixture Project"]]);
    const rendered = render(
      <CommandCredentialBindingsSettings client={old} projectNames={projects} />,
    );
    await user.click(await screen.findByRole("button", { name: "Remove Old host command" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    rendered.rerender(
      <CommandCredentialBindingsSettings
        client={{ read: vi.fn(async () => empty), execute: vi.fn() }}
        projectNames={projects}
      />,
    );
    if (finish === undefined) throw Error("Expected deferred removal");
    finish({ ...empty, bindings: [binding] });
    await waitFor(() => expect(screen.queryByText("Old host command")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save command binding" })).toBeDisabled();
  });
  it("refuses values or name-based references before submitting a definition", async () => {
    const client = { read: vi.fn(async () => empty), execute: vi.fn() };
    const user = userEvent.setup();
    render(
      <CommandCredentialBindingsSettings
        client={client}
        projectNames={new Map([[id(2), "Fixture Project"]])}
      />,
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Fixture Project" }));
    await user.type(screen.getByLabelText("Command name"), "Fixture");
    await user.type(screen.getByLabelText("Recipient executable"), "/usr/bin/client");
    await user.type(screen.getByLabelText("1Password account ID"), "a".repeat(26));
    await user.type(screen.getByLabelText(/Credential references/), "API_TOKEN=raw-value");
    await user.click(screen.getByRole("button", { name: "Save command binding" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter references, never values.");
    expect(client.execute).not.toHaveBeenCalled();
  });
});
