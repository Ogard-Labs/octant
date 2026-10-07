import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClaudeHelperSignIn, type ClaudeHelperView } from "./ClaudeHelperSignIn";

const instanceId = "80000000-0000-4000-8000-000000000901";

function host(initial: ClaudeHelperView) {
  let current = initial;
  const run = vi.fn(async (command: { readonly kind: string }) => {
    if (command.kind === "connect") current = { kind: "connected" };
    if (command.kind === "disconnect") current = { kind: "not-connected" };
    return current;
  });
  return run;
}

describe("Connect Claude for helpers", () => {
  it("connects from Settings and then offers Disconnect", async () => {
    const user = userEvent.setup();
    const run = host({ kind: "not-connected" });
    render(
      <ClaudeHelperSignIn
        disabled={false}
        displayName="Claude Code"
        instanceId={instanceId}
        run={run}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Connect Claude for helpers on Claude Code" }),
    );

    expect(run).toHaveBeenCalledWith({ kind: "connect", instanceId });
    expect(await screen.findByText(/Connected for helpers/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Disconnect Claude for helpers on Claude Code" }),
    );
    expect(run).toHaveBeenCalledWith({ kind: "disconnect", instanceId });
    expect(
      await screen.findByRole("button", { name: "Connect Claude for helpers on Claude Code" }),
    ).toBeEnabled();
  });

  it("asks to reconnect an expired helper sign-in", async () => {
    render(
      <ClaudeHelperSignIn
        disabled={false}
        displayName="Claude Code"
        instanceId={instanceId}
        run={host({ kind: "expired" })}
      />,
    );

    expect(await screen.findByText(/helper sign-in expired/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Claude for helpers on Claude Code" }),
    ).toBeEnabled();
  });
});
