import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddedAcpAgentsSection } from "./AddedAcpAgentsSection";

const now = "2026-11-18T10:00:00.000Z";

function cursor(configuration: Record<string, unknown>, enabled = false): ProviderInstance {
  return decodeProviderInstance({
    id: "80000000-0000-4000-8000-000000000970",
    displayName: "Cursor",
    driverKind: "acp-agent",
    configuration: {
      kind: "acp-agent",
      source: {
        kind: "registry",
        registryId: "cursor",
        version: "2026.11.13",
        distribution: "binary",
      },
      args: ["acp"],
      trusted: false,
      ...configuration,
    },
    enabled,
    environmentPolicy: "inherit-host",
    version: 2,
    createdAt: now,
    updatedAt: now,
  });
}

describe("Settings' flow for any ACP agent", () => {
  it("adds a registry agent by its registry id alone", async () => {
    const onStep = vi.fn(async () => true);
    render(<AddedAcpAgentsSection busy={false} instances={[]} onStep={onStep} />);
    await userEvent.click(screen.getByRole("button", { name: "Add ACP agent" }));
    const form = screen.getByRole("form", { name: "Add ACP agent" });
    expect(form).toHaveTextContent(/Octant has no reviewed profile for it/);
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(onStep).toHaveBeenCalledWith({
      kind: "add",
      source: { kind: "registry", registryId: "antigravity-acp" },
    });
  });

  it("offers Install, then Trust with what trusting grants and an unverified download said plainly, and Turn on only once trusted", async () => {
    const onStep = vi.fn(async () => true);
    const view = (instance: ProviderInstance) => (
      <AddedAcpAgentsSection busy={false} instances={[instance]} onStep={onStep} />
    );
    const { rerender } = render(view(cursor({})));
    const row = () => screen.getByRole("listitem", { name: "Cursor" });
    expect(within(row()).queryByRole("button", { name: "Trust" })).toBeNull();
    expect(within(row()).queryByRole("button", { name: "Turn on" })).toBeNull();
    await userEvent.click(within(row()).getByRole("button", { name: "Install" }));
    expect(onStep).toHaveBeenLastCalledWith({ kind: "install", instanceId: expect.any(String) });

    rerender(
      view(
        cursor({
          install: {
            executable: "/data/acp-agent-installs/cursor/dist-package/cursor-agent",
            integrity: "unverified-download",
          },
        }),
      ),
    );
    const trust = within(row()).getByRole("group", { name: "Trust step" });
    expect(trust).toHaveTextContent(/runs in Octant's sandbox at every level, even Full access/);
    expect(within(trust).getByRole("alert")).toHaveTextContent(/Unverified download/);
    expect(within(row()).queryByRole("button", { name: "Turn on" })).toBeNull();
    await userEvent.click(within(row()).getByRole("button", { name: "Trust" }));
    expect(onStep).toHaveBeenLastCalledWith({ kind: "trust", instanceId: expect.any(String) });

    rerender(
      view(
        cursor({
          install: {
            executable: "/data/acp-agent-installs/cursor/dist-package/cursor-agent",
            integrity: "unverified-download",
          },
          trusted: true,
        }),
      ),
    );
    await userEvent.click(within(row()).getByRole("button", { name: "Turn on" }));
    expect(onStep).toHaveBeenLastCalledWith({ kind: "enable", instanceId: expect.any(String) });
  });

  it("adds a local command with its arguments split as typed", async () => {
    const onStep = vi.fn(async () => true);
    render(<AddedAcpAgentsSection busy={false} instances={[]} onStep={onStep} />);
    await userEvent.click(screen.getByRole("button", { name: "Add ACP agent" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Source" }));
    await userEvent.click(await screen.findByRole("option", { name: "My own command" }));
    await userEvent.type(screen.getByLabelText("Name"), "Trae");
    await userEvent.type(screen.getByLabelText("Command"), "/opt/trae/bin/trae");
    await userEvent.type(screen.getByLabelText("Arguments"), "acp  --stdio");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onStep).toHaveBeenCalledWith({
      kind: "add",
      source: {
        kind: "local",
        displayName: "Trae",
        command: "/opt/trae/bin/trae",
        args: ["acp", "--stdio"],
      },
    });
  });
});
