import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import { ExtensionsSettingsView } from "./ExtensionsSettingsView";

const extensionId = "16000000-0000-4000-8000-000000000001";
const packageId = "16000000-0000-4000-8000-000000000002";
const digest = `sha256:${"c".repeat(64)}`;
const integrity = `sha512-${"B".repeat(86)}==`;
const registry = "https://registry.example.test";

function npmSource(version: string) {
  return { packageName: "@example/demo", version, registry, integrity };
}

function preview(version: string): Extract<ExtensionCommandResult, { kind: "package-inspected" }> {
  return {
    kind: "package-inspected",
    preview: {
      entry: {
        extensionId,
        packageId,
        slug: "demo",
        displayName: "Demo",
        version,
        digest,
        source: { kind: "plugin-package", sourceRef: "npm:abc" },
      },
      review: {
        description: "A demo plugin.",
        provenance: { publisher: "Example", reviewed: false, npm: npmSource(version) },
        license: { kind: "spdx", identifier: "MIT" },
        compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
        declaredCapabilities: ["instructions"],
        components: [
          {
            id: "skill-demo",
            kind: "skill-instructions",
            displayName: "demo",
            declaredCapabilities: ["instructions"],
          },
        ],
      },
      diagnostics: [],
    },
  } as never;
}

function snapshot(installed: boolean): ExtensionSnapshot {
  const activation = {
    installed: true,
    trusted: false,
    pluginDesired: false,
    componentDesired: false,
    compatible: true,
    policyAllowed: true,
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  };
  return {
    sequence: 1,
    snapshotAt: "2026-10-31T12:00:00.000Z",
    packages: installed
      ? [
          {
            extensionId,
            packageId,
            slug: "demo",
            displayName: "Demo",
            stateVersion: 1,
            version: "1.0.0",
            digest,
            source: { kind: "plugin-package", sourceRef: "npm:abc" },
            npm: npmSource("1.0.0"),
            compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
            activation,
            components: [],
            diagnostics: [],
          },
        ]
      : [],
    collisions: [],
  } as never;
}

function client(
  installed: boolean,
  answer: (command: ExtensionCommand) => ExtensionCommandResult | undefined,
) {
  const calls: Array<ExtensionCommand> = [];
  const state = snapshot(installed);
  const fake = {
    calls,
    toolGrantsAvailable: false,
    snapshot: vi.fn(async () => state),
    effectiveState: vi.fn(async () => ({
      sequence: 1,
      snapshotAt: state.snapshotAt,
      scope: {},
      catalogEpoch: `sha256:${"d".repeat(64)}`,
      catalogStatus: "available",
      stale: false,
      packages: [],
      collisions: [],
    })),
    execute: vi.fn(async (command: ExtensionCommand) => {
      calls.push(command);
      return (
        answer(command) ??
        ({
          kind: "extension-state-updated",
          snapshot: state,
        } as ExtensionCommandResult)
      );
    }),
  };
  return fake as unknown as ExtensionClient & { readonly calls: Array<ExtensionCommand> };
}

async function openMarketplace() {
  const user = userEvent.setup();
  const group = await screen.findByRole("group", { name: "View" });
  await user.click(within(group).getByRole("button", { name: /marketplace/i }));
  return user;
}

describe("installing a plugin from npm in Settings", () => {
  it("shows where the package came from and installs only after the person confirms", async () => {
    const fake = client(false, (command) =>
      command.kind === "resolve-npm-package" ? preview("1.0.0") : undefined,
    );
    render(<ExtensionsSettingsView client={fake} />);
    const user = await openMarketplace();

    await user.type(screen.getByLabelText("npm package name"), "@example/demo");
    await user.type(screen.getByLabelText("Version or range"), "^1.0.0");
    await user.click(screen.getByRole("button", { name: "Look up" }));

    expect(await screen.findByText("@example/demo@1.0.0")).toBeTruthy();
    expect(screen.getByText(integrity)).toBeTruthy();
    expect(screen.getByText(registry)).toBeTruthy();
    expect(fake.calls.map((call) => call.kind)).toEqual(
      expect.arrayContaining(["resolve-npm-package"]),
    );
    expect(fake.calls).toContainEqual({
      kind: "resolve-npm-package",
      packageName: "@example/demo",
      range: "^1.0.0",
    });
    // A lookup installs nothing.
    expect(fake.calls.some((call) => call.kind === "install-package")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm install" }));

    await waitFor(() =>
      expect(fake.calls).toContainEqual({
        kind: "install-package",
        extensionId,
        packageId,
        version: "1.0.0",
        digest,
      }),
    );
  });

  it("says plainly why a lookup failed", async () => {
    const fake = client(false, (command) =>
      command.kind === "resolve-npm-package"
        ? {
            kind: "extension-command-failed",
            failure: {
              category: "invalid",
              message:
                "The download does not match the integrity the registry published. Octant discarded it and installed nothing.",
            },
          }
        : undefined,
    );
    render(<ExtensionsSettingsView client={fake} />);
    const user = await openMarketplace();

    await user.type(screen.getByLabelText("npm package name"), "@example/demo");
    await user.click(screen.getByRole("button", { name: "Look up" }));

    expect(
      await screen.findByText(/does not match the integrity the registry published/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm install" })).toBeNull();
  });

  it("does not look anything up while marketplace fetches are off", async () => {
    const fake = client(false, () => undefined);
    render(<ExtensionsSettingsView client={fake} marketplaceFetchesEnabled={false} />);
    await openMarketplace();

    expect((screen.getByLabelText("npm package name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Look up" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows an installed npm package's source and offers a newer version without installing it", async () => {
    const fake = client(true, (command) => {
      if (command.kind === "check-npm-update") {
        return {
          kind: "npm-update-checked",
          extensionId,
          installedVersion: "1.0.0",
          available: "1.1.0",
        } as never;
      }
      if (command.kind === "resolve-npm-package") return preview("1.1.0");
      return undefined;
    });
    render(<ExtensionsSettingsView client={fake} />);
    const user = userEvent.setup();

    expect(await screen.findByText("@example/demo@1.0.0")).toBeTruthy();
    expect(screen.getByText(integrity)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Check for update" }));

    expect(
      await screen.findByText("Version 1.1.0 is available. Nothing was installed."),
    ).toBeTruthy();
    expect(fake.calls.map((call) => call.kind)).not.toContain("update-package");
    expect(fake.calls.map((call) => call.kind)).not.toContain("install-package");

    await user.click(screen.getByRole("button", { name: "Review version 1.1.0" }));
    expect(await screen.findByText("Review before updating")).toBeTruthy();
    // The review names the installed package, so the host asks the registry it came
    // from and not whichever one the npm settings name now.
    expect(fake.calls).toContainEqual({
      kind: "resolve-npm-package",
      packageName: "@example/demo",
      range: "1.1.0",
      updateOf: extensionId,
    });

    await user.click(screen.getByRole("button", { name: "Confirm update" }));
    await waitFor(() =>
      expect(fake.calls).toContainEqual({
        kind: "update-package",
        extensionId,
        packageId,
        version: "1.1.0",
        digest,
      }),
    );
  });

  it("reports that an installed npm package is current", async () => {
    const fake = client(true, (command) =>
      command.kind === "check-npm-update"
        ? ({
            kind: "npm-update-checked",
            extensionId,
            installedVersion: "1.0.0",
          } as never)
        : undefined,
    );
    render(<ExtensionsSettingsView client={fake} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Check for update" }));

    expect(await screen.findByText("This is the newest version the registry offers.")).toBeTruthy();
  });
});
