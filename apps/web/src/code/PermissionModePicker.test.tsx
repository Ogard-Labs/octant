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
    const trigger = screen.getByRole("button", { name: "Approvals: Ask first" });
    expect(trigger).toHaveTextContent("");
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(trigger.getAttribute("title")).toMatch(/^Approvals: Ask first\./);
    expect(trigger).toHaveAccessibleDescription("Asks before commands and file changes.");
    await userEvent.click(trigger);
    expect(await screen.findAllByRole("menuitemradio")).toHaveLength(5);
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
    await userEvent.click(screen.getByRole("button", { name: /^Approvals:/ }));
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
    expect(screen.getByRole("button", { name: /^Approvals:/ })).toHaveAccessibleName(
      "Approvals: Full access · Sandboxed",
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
    await userEvent.click(screen.getByRole("button", { name: /^Approvals:/ }));
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
    await userEvent.click(screen.getByRole("button", { name: /^Approvals:/ }));
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
    await userEvent.click(screen.getByRole("button", { name: /^Approvals:/ }));
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
