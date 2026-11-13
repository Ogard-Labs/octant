import type { ProviderCapabilities } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderNativeSetupSetting, ProviderOwnMemorySetting } from "./ProviderNativeSetupSetting";

const codex = {
  id: "80000000-0000-4000-8000-000000000911",
  displayName: "Codex work",
  driverKind: "codex",
} as const;

function capabilities(nativeSetup?: ProviderCapabilities["nativeSetup"]) {
  return { capabilities: nativeSetup === undefined ? {} : { nativeSetup } } as {
    readonly capabilities: ProviderCapabilities;
  };
}

describe("A provider's own memory", () => {
  it("starts off, says where it stays off and what stays off with it, and turns on with one switch", async () => {
    const onChange = vi.fn(async () => true);
    const view = (instance: React.ComponentProps<typeof ProviderOwnMemorySetting>["instance"]) => (
      <ProviderOwnMemorySetting disabled={false} instance={instance} onChange={onChange} />
    );
    const { rerender } = render(view(codex));
    const toggle = screen.getByRole("switch", { name: "Use Codex work’s own memory" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/stays off in Plan and in Chat/);
    expect(toggle).toHaveAccessibleDescription(/telemetry and self-update stay off either way/);
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(view({ ...codex, ownMemory: true }));
    expect(screen.getByRole("switch", { name: "Use Codex work’s own memory" })).toBeChecked();
  });
});

describe("Run a key provider as itself", () => {
  it("starts off, says what it loads, and turns on with one switch", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProviderNativeSetupSetting disabled={false} instance={codex} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Run Codex work as itself" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/its own\s+subagents, web search and fetch, skills/);
    expect(toggle).toHaveAccessibleDescription(/Plan stays read-only/);
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("names the features this provider's driver reports it cannot load", () => {
    render(
      <ProviderNativeSetupSetting
        disabled={false}
        instance={{ ...codex, nativeSetup: true }}
        observed={capabilities({
          subagents: "supported",
          webTools: "supported",
          skills: "supported",
          toolServers: "supported",
          hooks: "unsupported",
          projectCode: "unsupported",
        })}
        onChange={vi.fn(async () => true)}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Run Codex work as itself" });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      /Not available for Codex yet: settings and hooks, a trusted Project’s own code\./,
    );
  });

  it("says Mistral Vibe's own subagents wait for Full access, and says it only for Vibe", () => {
    const vibe = { ...codex, displayName: "Vibe", driverKind: "mistral-vibe" } as const;
    const { unmount } = render(
      <ProviderNativeSetupSetting
        disabled={false}
        instance={vibe}
        onChange={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByRole("switch", { name: "Run Vibe as itself" })).toHaveAccessibleDescription(
      /Mistral Vibe’s own subagents run only at Full access\./,
    );
    unmount();
    render(
      <ProviderNativeSetupSetting
        disabled={false}
        instance={codex}
        onChange={vi.fn(async () => true)}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "Run Codex work as itself" }),
    ).not.toHaveAccessibleDescription(/only at Full access/);
  });

  it("claims nothing for a checked driver that reports no native setup at all", () => {
    render(
      <ProviderNativeSetupSetting
        disabled={false}
        instance={codex}
        observed={capabilities()}
        onChange={vi.fn(async () => true)}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "Run Codex work as itself" }),
    ).toHaveAccessibleDescription(
      /Not available for Codex yet: its own subagents, web search and fetch, skills/,
    );
  });
});
