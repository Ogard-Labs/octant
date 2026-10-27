import { decodeProviderInstance, type ClaudeProviderInstance } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClaudeArtifactDeliverySetting } from "./ClaudeArtifactDeliverySetting";

function claude(configuration: Record<string, unknown> = {}): ClaudeProviderInstance {
  const instance = decodeProviderInstance({
    id: "80000000-0000-4000-8000-000000000901",
    displayName: "Claude personal",
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "subscription",
      ...configuration,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 3,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
  });
  if (instance.driverKind !== "claude") throw new Error("expected a Claude account");
  return instance;
}

const label = "Deliver documents from Claude personal as Claude artifacts";

describe("Deliver documents as Claude artifacts", () => {
  it("starts off, says the page leaves this computer, and asks the host to turn it on", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ClaudeArtifactDeliverySetting disabled={false} instance={claude()} onChange={onChange} />,
    );
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/leaves this computer/);
    expect(screen.getByText(/claude\.ai account instead of making a Canvas/)).toBeVisible();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows the recorded switch and turns it off", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ClaudeArtifactDeliverySetting
        disabled={false}
        instance={claude({ artifactDelivery: true })}
        onChange={onChange}
      />,
    );
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("cannot be turned on for an API-key account, and says why", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ClaudeArtifactDeliverySetting
        disabled={false}
        instance={claude({ authentication: "api-key" })}
        onChange={onChange}
      />,
    );
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).toHaveAttribute("title", expect.stringContaining("claude.ai sign-in"));
    expect(toggle).toHaveAccessibleDescription(/need a claude\.ai sign-in/);
    await userEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
