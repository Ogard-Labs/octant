import type { ProviderCapabilities } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostPlatformContext } from "../platform";
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

/** The Settings row a control sits in: its sentence and what waits behind its More. */
function rowOf(control: HTMLElement): HTMLElement | null {
  return control.closest("[data-testid='setting-row']");
}

describe("A provider's own memory", () => {
  it("starts on, says where it stays off and what stays off with it, and turns off with one switch", async () => {
    const onChange = vi.fn(async () => true);
    const view = (instance: React.ComponentProps<typeof ProviderOwnMemorySetting>["instance"]) => (
      <ProviderOwnMemorySetting disabled={false} instance={instance} onChange={onChange} />
    );
    const { rerender } = render(view(codex));
    const toggle = screen.getByRole("switch", { name: "Use Codex work’s own memory" });
    expect(toggle).toBeChecked();
    expect(rowOf(toggle)).toHaveTextContent(/On by default/);
    expect(rowOf(toggle)).toHaveTextContent(
      /Under Strict it stays off in Plan and in Chat, because it writes its memory in the background/,
    );
    expect(rowOf(toggle)).toHaveTextContent(
      /does not change Codex’s telemetry or self-update; those follow Provider channels/,
    );
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);

    rerender(view({ ...codex, ownMemory: false }));
    expect(screen.getByRole("switch", { name: "Use Codex work’s own memory" })).not.toBeChecked();
  });

  it("says Claude Code reads its memory in Plan and Chat without changing it", () => {
    render(
      <ProviderOwnMemorySetting
        disabled={false}
        instance={{ ...codex, displayName: "Claude work", driverKind: "claude" }}
        onChange={vi.fn(async () => true)}
      />,
    );
    expect(
      rowOf(screen.getByRole("switch", { name: "Use Claude work’s own memory" })),
    ).toHaveTextContent(/In Plan and in Chat it reads its memory and cannot change it/);
  });
});

describe("Run a key provider as itself", () => {
  it("starts on, says what it loads, and turns off with one switch", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProviderNativeSetupSetting disabled={false} instance={codex} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Run Codex work as itself" });
    expect(toggle).toBeChecked();
    expect(rowOf(toggle)).toHaveTextContent(/its own\s+subagents, web search and fetch, skills/i);
    expect(rowOf(toggle)).toHaveTextContent(/On by default/);
    expect(rowOf(toggle)).toHaveTextContent(/Plan stays read-only/);
    expect(rowOf(toggle)).toHaveTextContent(
      /Turned off, web search and fetch stay\s+off in every mode/,
    );
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("stays off for an account the person turned off", () => {
    render(
      <ProviderNativeSetupSetting
        disabled={false}
        instance={{ ...codex, nativeSetup: false }}
        onChange={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByRole("switch", { name: "Run Codex work as itself" })).not.toBeChecked();
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
    expect(rowOf(toggle)).toHaveTextContent(
      /Not available for Codex yet: settings and hooks, a trusted Project’s own code\./,
    );
  });

  it("says where Mistral Vibe's subagents run and that their approvals name no tool, only for Vibe", () => {
    const vibe = { ...codex, displayName: "Vibe", driverKind: "mistral-vibe" } as const;
    const { unmount } = render(
      <ProviderNativeSetupSetting
        disabled={false}
        instance={vibe}
        onChange={vi.fn(async () => true)}
      />,
    );
    expect(rowOf(screen.getByRole("switch", { name: "Run Vibe as itself" }))).toHaveTextContent(
      /Vibe doesn’t say which tool its subagents ask to run/,
    );
    expect(rowOf(screen.getByRole("switch", { name: "Run Vibe as itself" }))).toHaveTextContent(
      /work in Work and Code outside Plan, at every level there/,
    );
    expect(rowOf(screen.getByRole("switch", { name: "Run Vibe as itself" }))).not.toHaveTextContent(
      /only at Full access/,
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
      rowOf(screen.getByRole("switch", { name: "Run Codex work as itself" })),
    ).not.toHaveTextContent(/its subagents ask/);
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
      rowOf(screen.getByRole("switch", { name: "Run Codex work as itself" })),
    ).toHaveTextContent(
      /Not available for Codex yet: its own subagents, web search and fetch, skills/,
    );
  });

  it("says honestly on Windows that OpenCode's and an ACP agent's own permission handling applies in Chat outside Strict", () => {
    const { unmount } = render(
      <HostPlatformContext.Provider value="win32">
        <ProviderNativeSetupSetting
          disabled={false}
          instance={{ ...codex, displayName: "OpenCode", driverKind: "opencode" }}
          onChange={vi.fn(async () => true)}
        />
      </HostPlatformContext.Provider>,
    );
    expect(rowOf(screen.getByRole("switch", { name: "Run OpenCode as itself" }))).toHaveTextContent(
      /OpenCode’s own permission rules—not Octant—keep its file and shell tools off, and its command templates and plugins run as they do in OpenCode itself/,
    );
    unmount();

    render(
      <HostPlatformContext.Provider value="win32">
        <ProviderNativeSetupSetting
          disabled={false}
          instance={{ ...codex, displayName: "Kilo", driverKind: "kilo" }}
          onChange={vi.fn(async () => true)}
        />
      </HostPlatformContext.Provider>,
    );
    expect(rowOf(screen.getByRole("switch", { name: "Run Kilo as itself" }))).toHaveTextContent(
      /Kilo’s own permission handling—not Octant confinement—applies/,
    );
  });
});
