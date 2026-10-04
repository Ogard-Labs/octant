import { decodeManagedToolsStatus } from "@octant/contracts/managed-tooling";
import { decodeProviderInstanceId } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeManagedUpdate } from "./OpenCodeManagedUpdate";

const id = decodeProviderInstanceId("80000000-0000-4000-8000-000000000371");
const managedDirectory = "/tmp/octant-managed/opencode";
const executablePath = `${managedDirectory}/current/bin/opencode`;

function status(overrides: Record<string, unknown> = {}) {
  const tool = {
    tool: "opencode",
    packageName: "@opencode/cli",
    channel: "npm",
    available: true,
    installed: true,
    version: "2.0.21",
    update: "failed",
    availableVersion: "2.0.22",
    message: "Tool archive hash does not match.",
    managedDirectory,
    executablePath,
    ...overrides,
  };
  const defined = Object.fromEntries(
    Object.entries(tool).filter(([, value]) => value !== undefined),
  );
  return decodeManagedToolsStatus({
    supported: true,
    automaticUpdates: false,
    tools: [defined],
  });
}

describe("OpenCode managed update", () => {
  it("shows the installed and available versions and why an update failed", async () => {
    const user = userEvent.setup();
    const checkManagedToolUpdates = vi.fn(async () =>
      status({ update: "current", message: undefined }),
    );
    render(
      <OpenCodeManagedUpdate
        bridge={{
          getManagedToolsStatus: async () => status(),
          checkManagedToolUpdates,
        }}
        instances={[]}
        onChangeBinary={vi.fn(async () => true)}
      />,
    );
    expect(await screen.findByText("2.0.21")).toBeInTheDocument();
    expect(screen.getByText("2.0.22")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Tool archive hash does not match.");
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(checkManagedToolUpdates).toHaveBeenCalledWith("opencode");
  });

  it("does not replace an outside binary unless the provider is switched to Octant's copy", async () => {
    const user = userEvent.setup();
    const onChangeBinary = vi.fn(async () => true);
    const outside = "/opt/homebrew/bin/opencode";
    render(
      <OpenCodeManagedUpdate
        bridge={{
          getManagedToolsStatus: async () => status({ update: "current", message: undefined }),
          checkManagedToolUpdates: vi.fn(),
        }}
        instances={[{ id, displayName: "OpenCode local", binaryPath: outside }]}
        onChangeBinary={onChangeBinary}
      />,
    );
    const adopt = await screen.findByRole("button", { name: "Use Octant's copy" });
    expect(adopt).toBeDisabled();
    expect(
      screen.getByText(/never replaces an OpenCode you installed somewhere else/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Consent to use Octant's OpenCode for OpenCode local" }),
    );
    expect(adopt).toBeEnabled();
    await user.click(adopt);
    expect(onChangeBinary).toHaveBeenCalledWith(id, executablePath);
    expect(onChangeBinary).not.toHaveBeenCalledWith(id, outside);
  });
});
