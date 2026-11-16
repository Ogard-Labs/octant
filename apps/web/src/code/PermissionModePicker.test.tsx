import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PickerGroup } from "@octant/domain";
import type { ProviderInstanceId } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_SANDBOX_MISSING_REASON } from "@octant/domain/guardrail-policy";
import { HostPlatformContext } from "../platform";
import { PermissionModePicker, threadKeepsFullAccessSandbox } from "./PermissionModePicker";

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
        strict
        onChange={() => undefined}
        onStrictChange={() => undefined}
        value="full-access"
      />,
    );
    expect(screen.getByRole("button", { name: "Mode: Full access · Strict" })).toHaveTextContent(
      "Full access · Strict",
    );
    rerender(<PermissionModePicker autoSupported onChange={() => undefined} value="plan" />);
    expect(screen.getByRole("button", { name: "Mode: Plan" })).toHaveTextContent("");
  });
});

describe("the sandbox at Full access in the mode picker", () => {
  it("offers Strict under Full access and saves the choice", async () => {
    const onStrictChange = vi.fn();
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onStrictChange={onStrictChange}
        strict={false}
        fullAccessSandboxSupported
        value="full-access"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Strict/ }));
    expect(onStrictChange).toHaveBeenCalledWith(true);
  });

  it("names a sandboxed Full access thread on the trigger", () => {
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onStrictChange={() => undefined}
        strict
        value="full-access"
      />,
    );
    expect(screen.getByRole("button", { name: /^Mode:/ })).toHaveAccessibleName(
      "Mode: Full access · Strict",
    );
  });

  it("keeps the choice listed but disabled, with the reason, on a provider that cannot keep it", async () => {
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onStrictChange={() => undefined}
        fullAccessSandboxSupported={false}
        value="full-access"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: /Strict/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("can't keep the sandbox");
  });

  it("lets an inherited sandbox be turned off on a provider that cannot keep it", async () => {
    const onStrictChange = vi.fn();
    render(
      <PermissionModePicker
        autoSupported
        onChange={() => undefined}
        onStrictChange={onStrictChange}
        strict
        fullAccessSandboxSupported={false}
        value="full-access"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: /Strict/ });
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    expect(onStrictChange).toHaveBeenCalledWith(false);
  });

  it("names retained legacy protection and offers explicit migration to Strict", async () => {
    const onStrictChange = vi.fn();
    render(
      <PermissionModePicker
        autoSupported
        strict
        legacyStrict
        value="full-access"
        onChange={() => undefined}
        onStrictChange={onStrictChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Mode: Full access · Legacy sandbox" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", {
        name: "Use Strict protections instead of the legacy sandbox",
      }),
    );
    expect(onStrictChange).toHaveBeenCalledWith(true);
  });

  it("changes Strict below Full access without changing the access level", async () => {
    const onStrictChange = vi.fn();
    const onChange = vi.fn();
    render(
      <PermissionModePicker
        autoSupported
        onChange={onChange}
        onStrictChange={onStrictChange}
        value="ask-first"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    await screen.findByRole("menuitemradio", { name: /Full access/ });
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /Strict/ }));
    expect(onStrictChange).toHaveBeenCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
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

describe("the mode picker on a Windows host", () => {
  it("offers native Windows levels with Strict off and warns once before the first Full access pick", async () => {
    const onChange = vi.fn();
    render(
      <HostPlatformContext.Provider value="win32">
        <PermissionModePicker
          autoSupported
          onChange={onChange}
          value="ask-first"
          warningScope={{ projectId: `windows-${Math.random()}` }}
        />
      </HostPlatformContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    for (const name of [/^Auto/, /^Ask first/, /^Accept edits/, /^Plan/]) {
      const item = await screen.findByRole("menuitemradio", { name });
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
    const full = screen.getByRole("menuitemradio", { name: /^Full access/ });
    expect(full).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(full);
    expect(await screen.findByRole("dialog", { name: "Use Full access?" })).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use Full access" }));
    expect(onChange).toHaveBeenCalledWith("full-access");
  });

  it("refuses only enabling Strict on Windows and explains the unavailable confinement", async () => {
    render(
      <HostPlatformContext.Provider value="win32">
        <PermissionModePicker
          autoSupported
          strict={false}
          value="ask-first"
          onChange={() => undefined}
          onStrictChange={() => undefined}
        />
      </HostPlatformContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Mode:/ }));
    const strict = await screen.findByRole("menuitemcheckbox", { name: /^Strict/ });
    expect(strict).toHaveAttribute("aria-disabled", "true");
    expect(strict).toHaveAccessibleDescription(WINDOWS_SANDBOX_MISSING_REASON);
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
