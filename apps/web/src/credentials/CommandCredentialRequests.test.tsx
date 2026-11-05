import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import {
  decodeCommandCredentialBinding,
  decodeCommandCredentialResult,
  decodeCommandCredentialReceipt,
  type CommandCredentialResult,
} from "@octant/contracts/command-credentials";
import { CommandCredentialRequests } from "./CommandCredentialRequests";
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
    label: "Account status",
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
const pending = {
  requestId: id(3),
  binding,
  threadId: id(4),
  expiresAt: new Date(Date.now() + 180000).toISOString(),
  state: "pending" as const,
};
const view = decodeCommandCredentialResult({
  kind: "command-credential-view" as const,
  bindings: [binding],
  requests: [pending],
  receipts: [],
});
describe("named command review", () => {
  it("shows the fixed recipient and account, and discards an old execution response after switching task", async () => {
    let finish: ((value: CommandCredentialResult) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<CommandCredentialResult>((resolve) => {
          finish = resolve;
        }),
    );
    const client = { read: vi.fn(async () => view), execute };
    const user = userEvent.setup();
    const rendered = render(
      <CommandCredentialRequests threadId={id(4)} projectId={id(2)} client={client} />,
    );
    await user.click(screen.getByText(/Credential commands/));
    expect(await screen.findByRole("button", { name: "Approve one run" })).toBeInTheDocument();
    expect(screen.getByText(/\/usr\/bin\/client/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve one run" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    rendered.rerender(
      <CommandCredentialRequests
        threadId={id(5)}
        projectId={id(6)}
        client={{
          read: vi.fn(async () => ({
            kind: "command-credential-view" as const,
            bindings: [],
            requests: [],
            receipts: [],
          })),
          execute,
        }}
      />,
    );
    if (finish === undefined) throw Error("Expected deferred command");
    finish(
      decodeCommandCredentialReceipt({
        kind: "command-credential-receipt",
        requestId: id(3),
        status: "exited",
        effect: "completed",
        exitCode: 0,
        output: "old-task-output",
        truncated: false,
      }),
    );
    await screen.findByText("Save a fixed binding in Settings → Secret stores.");
    expect(screen.queryByText("old-task-output")).not.toBeInTheDocument();
  });
  it("recovers a completed run's outcome from the status read after the approval reply was lost", async () => {
    const user = userEvent.setup();
    const completed = decodeCommandCredentialResult({
      kind: "command-credential-view",
      bindings: [binding],
      requests: [],
      receipts: [
        {
          kind: "command-credential-receipt",
          requestId: id(3),
          status: "exited",
          effect: "completed",
          exitCode: 0,
          output: "recovered-output",
          truncated: false,
        },
      ],
    });
    const read = vi.fn(async () => view);
    const execute = vi.fn(async (): Promise<CommandCredentialResult> => {
      read.mockImplementation(async () => completed);
      throw new Error("Synthetic lost approval reply");
    });
    render(
      <CommandCredentialRequests threadId={id(4)} projectId={id(2)} client={{ read, execute }} />,
    );
    await user.click(screen.getByText(/Credential commands/));
    await user.click(await screen.findByRole("button", { name: "Approve one run" }));
    expect(await screen.findByText("recovered-output", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/exited · Exit 0/)).toBeInTheDocument();
  });
  it("keeps cancellation available while a command approval awaits completion", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async (command: { readonly kind: string }) =>
      command.kind === "approve"
        ? await new Promise<CommandCredentialResult>(() => {})
        : decodeCommandCredentialReceipt({
            kind: "command-credential-receipt",
            requestId: id(3),
            status: "cancelled",
            effect: "possible",
            output: "",
            truncated: false,
          }),
    );
    render(
      <CommandCredentialRequests
        threadId={id(4)}
        projectId={id(2)}
        client={{ read: vi.fn(async () => view), execute }}
      />,
    );
    await user.click(screen.getByText(/Credential commands/));
    await user.click(await screen.findByRole("button", { name: "Approve one run" }));
    await user.click(screen.getByRole("button", { name: "Cancel command" }));
    expect(await screen.findByText(/Effect: possible/)).toBeInTheDocument();
    expect(execute).toHaveBeenLastCalledWith({ kind: "cancel", requestId: id(3) });
  });
});
