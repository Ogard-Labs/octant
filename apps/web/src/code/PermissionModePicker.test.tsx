import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PickerGroup } from "@octant/domain";
import type { ProviderInstanceId } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_STRICT_REFUSAL } from "@octant/domain/guardrail-policy";
import { HostPlatformContext } from "../platform";
import {
  PermissionModePicker,
  runningTurnKeepsNarrowerMode,
  threadKeepsFullAccessSandbox,
  WINDOWS_PROVIDER_APPROVALS_DETAIL,
} from "./PermissionModePicker";

afterEach(cleanup);

const group = (id: string, driverKind: string) =>
  ({ instance: { id, driverKind } }) as unknown as PickerGroup;

describe("the approval control", () => {
  it("is one icon whose name and tooltip state the current mode, with no label or chevron", async () => {
    render(
      <PermissionModePicker autoSupported={false} onChange={() => undefined} value="ask-first" />,
    );
    const trigger = screen.getByRole("button", { name: "Mode: Ask first" });
    expect(trigger).toHaveTextContent("");
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(trigger.getAttribute("title")).toMatch(/^Mode: Ask first\./);
    expect(trigger).toHaveAccessibleDescription("Asks before commands and file changes.");
    await userEvent.click(trigger);
    expect(await screen.findAllByRole("menuitemradio")).toHaveLength(5);
  });

  it("opens in Octant's own menu in the desktop app, not the system's, so each mode keeps its line of detail", async () => {
    const popup = vi.fn(async () => ({ kind: "dismissed" }));
    Object.defineProperty(window, "octantHost", {
      configurable: true,
      value: { popupNativeMenu: popup },
    });
    try {
      render(<PermissionModePicker autoSupported onChange={() => undefined} value="ask-first" />);
      await userEvent.click(screen.getByRole("button", { name: "Mode: Ask first" }));
      expect(await screen.findAllByRole("menuitemradio")).toHaveLength(5);
      expect(screen.getByRole("menuitemradio", { name: "Plan" })).toHaveAccessibleDescription(
        "Read-only. No commands or file changes.",
      );
      expect(popup).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, "octantHost");
    }
  });
});

describe("the mode control's state at a glance", () => {
  it("shows Full access in words and every other mode as an icon alone, and renames itself with the mode", () => {
    const { rerender } = render(
      <PermissionModePicker autoSupported onChange={() => undefined} value="ask-first" />,
    );
    const icons = new Set<string>();
    for (const mode of ["ask-first", "accept-edits", "plan", "auto"] as const) {
      rerender(<PermissionModePicker autoSupported onChange={() => undefined} value={mode} />);
      const trigger = screen.getByRole("button", { name: /^Mode:/ });
      expect(trigger).toHaveTextContent("");
      icons.add(trigger.querySelector("svg")?.getAttribute("class") ?? "");
    }
    expect(icons.size).toBe(4);
    rerender(<PermissionModePicker autoSupported onChange={() => undefined} value="full-access" />);
    const full = screen.getByRole("button", { name: "Mode: Full access" });
    expect(full).toHaveTextContent("Full access");
    expect(full).toBeVisible();
    rerender(
      <PermissionModePicker
        autoSupported
        fullAccessSandbox
        onChange={() => undefined}
        onFullAccessSandboxChange={() => undefined}
        value="full-access"
      />,
    );
    expect(screen.getByRole("button", { name: "Mode: Full access · Sandboxed" })).toHaveTextContent(
      "Full access · Sandboxed",
    );
    rerender(<PermissionModePicker autoSupported onChange={() => undefined} value="plan" />);
    expect(screen.getByRole("button", { name: "Mode: Plan" })).toHaveTextContent("");
  });
});

describe("the sandbox at Full access in the mode picker", () => {
  it("offers Keep the sandbox under Full access and saves the choice", async () => {
    const onFullAccessSandboxChange = vi.fn();
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onFullAccessSandboxChange={onFullAccessSandboxChange}
        fullAccessSandbox={false}
        fullAccessSandboxSupported
        value="full-access"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    await userEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: /Keep the sandbox/ }),
    );
    expect(onFullAccessSandboxChange).toHaveBeenCalledWith(true);
  });

  it("names a sandboxed Full access thread on the trigger", () => {
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onFullAccessSandboxChange={() => undefined}
        fullAccessSandbox
        value="full-access"
      />,
    );
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName(
      "Mode: Full access · Sandboxed",
    );
  });

  it("keeps the choice listed but disabled, with the reason, on a provider that cannot keep it", async () => {
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onFullAccessSandboxChange={() => undefined}
        fullAccessSandboxSupported={false}
        value="full-access"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: /Keep the sandbox/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("can't keep the sandbox");
  });

  it("lets an inherited sandbox be turned off on a provider that cannot keep it", async () => {
    const onFullAccessSandboxChange = vi.fn();
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onFullAccessSandboxChange={onFullAccessSandboxChange}
        fullAccessSandbox
        fullAccessSandboxSupported={false}
        value="full-access"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: /Keep the sandbox/ });
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    expect(onFullAccessSandboxChange).toHaveBeenCalledWith(false);
  });

  it("offers no sandbox choice below Full access", async () => {
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onFullAccessSandboxChange={() => undefined}
        value="ask-first"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    await screen.findByRole("menuitemradio", { name: /Full access/ });
    expect(screen.queryByRole("menuitemcheckbox", { name: /Keep the sandbox/ })).toBeNull();
  });

  it("reads Claude, Codex and Octant Harness models as able to keep the sandbox, and others or unknowns as not", () => {
    const groups = [group("codex", "codex"), group("claude", "claude"), group("local", "ollama")];
    const keeps = (id: string) => threadKeepsFullAccessSandbox(groups, id as ProviderInstanceId);
    expect(keeps("codex")).toBe(true);
    expect(keeps("local")).toBe(true);
    expect(keeps("claude")).toBe(true);
    expect(keeps("missing")).toBe(false);
  });
});

describe("a wider mode picked while a turn runs", () => {
  it("says in the mode's tooltip that it applies from the next message, only while a narrower turn runs", () => {
    const keeps = (
      turnRunning: boolean,
      turnPolicy: "approval-gated" | "full-access" | undefined,
    ) => runningTurnKeepsNarrowerMode({ turnRunning, turnPolicy, threadPolicy: "full-access" });
    expect(keeps(true, "approval-gated")).toBe(true);
    expect(keeps(true, "full-access")).toBe(false);
    expect(keeps(false, "approval-gated")).toBe(false);
    expect(keeps(true, undefined)).toBe(false);
    expect(
      runningTurnKeepsNarrowerMode({
        turnRunning: true,
        turnPolicy: "full-access",
        threadPolicy: "plan",
      }),
    ).toBe(false);

    render(
      <PermissionModePicker
        appliesFromNextMessage
        autoSupported
        onChange={() => undefined}
        value="full-access"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Mode: Full access" });
    expect(trigger.getAttribute("title")).toMatch(/Full access applies from your next message\.$/);
    expect(trigger).toHaveAccessibleDescription(/Full access applies from your next message\.$/);
  });
});

describe("the mode picker on a Windows host", () => {
  it("offers every level outside Strict, says the provider's own approvals decide below Full access, and warns once before the first Full access pick", async () => {
    const onChange = vi.fn();
    render(
      <HostPlatformContext.Provider value="win32">
        <PermissionModePicker
          autoSupported
          onChange={onChange}
          strict={false}
          value="ask-first"
          warningScope={{ projectId: `windows-${Math.random()}` }}
        />
      </HostPlatformContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    for (const name of [/^Auto/, /^Ask first/, /^Accept edits/, /^Plan/]) {
      const item = await screen.findByRole("menuitemradio", { name });
      expect(item).not.toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAccessibleDescription(
        expect.stringContaining(WINDOWS_PROVIDER_APPROVALS_DETAIL),
      );
    }
    const full = screen.getByRole("menuitemradio", { name: /^Full access/ });
    expect(full).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(full);
    expect(await screen.findByRole("dialog", { name: "Use Full access?" })).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use Full access" }));
    expect(onChange).toHaveBeenCalledWith("full-access");
  });

  it("shows every guarded level unavailable on a Strict thread, naming Strict", async () => {
    render(
      <HostPlatformContext.Provider value="win32">
        <PermissionModePicker
          autoSupported
          onChange={() => undefined}
          strict
          value="full-access"
          warningScope={{ projectId: `windows-${Math.random()}` }}
        />
      </HostPlatformContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    for (const name of [/^Auto/, /^Ask first/, /^Accept edits/, /^Plan/]) {
      const item = await screen.findByRole("menuitemradio", { name });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAccessibleDescription(WINDOWS_STRICT_REFUSAL);
    }
  });

  it("keeps every level available on a Mac host", async () => {
    render(
      <HostPlatformContext.Provider value="darwin">
        <PermissionModePicker autoSupported onChange={() => undefined} value="ask-first" />
      </HostPlatformContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    expect(await screen.findByRole("menuitemradio", { name: /^Plan/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("Strict in the mode picker", () => {
  it("offers Strict at every mode, states its trade-off, and saves the choice", async () => {
    const onStrictChange = vi.fn();
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onStrictChange={onStrictChange}
        strict={false}
        value="ask-first"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    const strict = await screen.findByRole("menuitemcheckbox", { name: /^Strict/ });
    expect(strict).toHaveAccessibleDescription(
      /Some workflows that work in the provider's own app/,
    );
    await userEvent.click(strict);
    expect(onStrictChange).toHaveBeenCalledWith(true);
  });
});
