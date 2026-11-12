import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PickerGroup } from "@octant/domain";
import type { ProviderInstanceId } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
