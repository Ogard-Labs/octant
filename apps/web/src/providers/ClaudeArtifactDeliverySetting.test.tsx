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

const label = "Enable Claude artifacts for Claude personal";
const telemetry = /usage telemetry to Anthropic/;

describe("Enable Claude artifacts", () => {
  it("starts off and warns under the switch that it turns on Claude Code's usage telemetry", () => {
    render(
      <ClaudeArtifactDeliverySetting
        disabled={false}
        instance={claude()}
        onChange={vi.fn(async () => true)}
      />,
    );
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(telemetry)).toBeVisible();
    expect(screen.getByText(/Error reports and conversation uploads stay off/)).toBeVisible();
    expect(toggle).toHaveAccessibleDescription(telemetry);
  });

  it("asks before enabling, repeating the warning, and stays off when the person cancels", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ClaudeArtifactDeliverySetting disabled={false} instance={claude()} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("switch", { name: label }));
    const dialog = await screen.findByRole("dialog", { name: /Enable Claude artifacts/ });
    expect(dialog).toHaveTextContent(telemetry);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("switch", { name: label }));
    await userEvent.click(await screen.findByRole("button", { name: "Enable Claude artifacts" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("turns off at once, without a dialog", async () => {
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
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("cannot be enabled for an API-key account or where the host keeps the runtime's traffic off, and says why", async () => {
    const onChange = vi.fn(async () => true);
    const { unmount } = render(
      <ClaudeArtifactDeliverySetting
        disabled={false}
        instance={claude({ authentication: "api-key" })}
        onChange={onChange}
      />,
    );
    const keyed = screen.getByRole("switch", { name: label });
    expect(keyed).toHaveAccessibleDescription(/need a claude\.ai sign-in/);
    await userEvent.click(keyed);
    unmount();

    render(
      <ClaudeArtifactDeliverySetting
        disabled={false}
        instance={claude()}
        observed={{
          capabilities: {
            appManagedTools: "supported",
            approvals: "supported",
            streaming: "supported",
            reasoning: "supported",
            images: "supported",
            fileAttachments: "unsupported",
            webSearch: "unsupported",
            subagents: "unsupported",
            citations: "unsupported",
            harnessAutoReview: "unsupported",
            nativeArtifacts: {
              chat: "unsupported",
              work: "unsupported",
              code: "unsupported",
              unsupportedReason: "host-traffic-disabled",
            },
          } as never,
        }}
        onChange={onChange}
      />,
    );
    const umbrella = screen.getByRole("switch", { name: label });
    expect(umbrella).toHaveAccessibleDescription(/CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/);
    await userEvent.click(umbrella);
    expect(onChange).not.toHaveBeenCalled();
  });
});
