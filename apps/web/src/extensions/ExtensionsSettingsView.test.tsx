import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import type { ExtensionActivationScope } from "@octant/contracts/extensions";
import { ExtensionsSettingsView } from "./ExtensionsSettingsView";

const extensionId = "15000000-0000-4000-8000-000000000001";
const packageId = "15000000-0000-4000-8000-000000000002";
const digest = `sha256:${"a".repeat(64)}`;
const catalogEpoch = `sha256:${"b".repeat(64)}`;
const scope: ExtensionActivationScope = {
  hostId: "local" as never,
  mode: "code",
  projectId: null,
  threadId: null,
  providerFamily: "openai-compatible" as never,
};

type Activation = ExtensionSnapshot["packages"][number]["activation"];
type EffectiveState = ExtensionSnapshot["packages"][number]["components"][number]["effectiveState"];
type Preview = Extract<ExtensionCommandResult, { readonly kind: "package-inspected" }>["preview"];

function previewReview(overrides: Partial<Preview["review"]> = {}): Preview["review"] {
  return {
    description: "Build and refine projects with the Build Helper workflows.",
    provenance: {
      canonicalUrl: "https://example.com/build-helper",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: {
      platforms: ["macos"],
      modes: ["code"],
      providerFamilies: [],
    },
    declaredCapabilities: ["mcp"],
    components: [
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Server",
        declaredCapabilities: ["mcp"],
      },
    ],
    ...overrides,
  } as never;
}

function baseActivation(overrides: Partial<Activation> = {}): Activation {
  return {
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
    ...overrides,
  } as never;
}

interface InstalledSnapshotOptions {
  readonly activation?: Activation;
  readonly componentActivation?: Activation;
  readonly componentEffectiveState?: EffectiveState;
}

function installedSnapshot(options: InstalledSnapshotOptions = {}): ExtensionSnapshot {
  const activation = options.activation ?? baseActivation();
  const componentActivation = options.componentActivation ?? activation;
  const effectiveState: EffectiveState =
    options.componentEffectiveState ??
    (activation.trusted && activation.pluginDesired && activation.componentDesired
      ? ({ kind: "effective" } as never)
      : ({ kind: "blocked", reason: "untrusted" } as never));
  return {
    sequence: 7 as never,
    snapshotAt: "2026-07-29T12:00:00.000Z" as never,
    packages: [
      {
        extensionId: extensionId as never,
        packageId: packageId as never,
        slug: "build-helper" as never,
        displayName: "Build Helper",
        stateVersion: 3 as never,
        version: "1.2.0" as never,
        digest: digest as never,
        source: {
          kind: "catalog",
          catalogId: "octant" as never,
          entryId: "build-helper" as never,
        },
        compatibility: {
          platforms: ["macos"],
          modes: ["code"],
          providerFamilies: [],
        },
        activation,
        components: [
          {
            component: {
              id: "server" as never,
              kind: "mcp-server",
              displayName: "Server",
              declaredCapabilities: ["mcp"],
              entryPoint: "runtime/main.mjs",
            },
            activation: componentActivation,
            effectiveState,
          },
        ],
        diagnostics: [],
      },
    ],
    collisions: [],
  } as never;
}

function effectiveSnapshot(
  snapshot: ExtensionSnapshot,
  overrides: Partial<ExtensionEffectiveSnapshot> = {},
): ExtensionEffectiveSnapshot {
  return {
    sequence: snapshot.sequence,
    snapshotAt: snapshot.snapshotAt,
    scope,
    catalogEpoch: catalogEpoch as never,
    catalogStatus: "available",
    stale: false,
    packages: snapshot.packages.map((pkg) => ({
      ...pkg,
      components: pkg.components.map((componentState) => ({
        component: componentState.component,
        activation: componentState.activation,
        policy: {
          revision: 0,
          projectRevision: 0,
          threadRevision: 0,
          hostAllowed: true,
          modeAllowed: true,
          projectAllowed: true,
          threadAllowed: true,
          policyAllowed: true,
        },
        effectiveState: componentState.effectiveState,
        contextContribution: {
          kind: "zero" as const,
          reason:
            componentState.effectiveState.kind === "effective"
              ? ("not-selected" as const)
              : componentState.effectiveState.reason,
        },
      })),
    })),
    collisions: [],
    ...overrides,
  } as never;
}

function client(
  snapshots: {
    readonly snapshot?: ExtensionSnapshot;
    readonly effective?: ExtensionEffectiveSnapshot;
  } = {},
): ExtensionClient & {
  readonly calls: Array<ExtensionCommand>;
  readonly results: Array<ExtensionCommandResult>;
} {
  const calls: Array<ExtensionCommand> = [];
  const results: Array<ExtensionCommandResult> = [];
  const snapshot = snapshots.snapshot ?? installedSnapshot();
  const effective = snapshots.effective ?? effectiveSnapshot(snapshot);
  return {
    calls,
    results,
    snapshot: vi.fn(async () => snapshot),
    effectiveState: vi.fn(async () => effective),
    importLocalPluginReceipt: vi.fn(async () => {
      const result: ExtensionCommandResult = {
        kind: "extension-command-failed",
        failure: {
          category: "unavailable",
          message: "Local plugin import is not configured in this test.",
        },
      };
      results.push(result);
      return result;
    }),
    execute: vi.fn(async (command: ExtensionCommand) => {
      calls.push(command);
      if (command.kind === "search-catalog") {
        const result: ExtensionCommandResult = {
          kind: "catalog-search-results",
          entries: [
            {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: "1.2.0" as never,
              digest: digest as never,
              source: {
                kind: "catalog",
                catalogId: "octant" as never,
                entryId: "build-helper" as never,
              },
            },
          ],
        };
        results.push(result);
        return result;
      }
      if (command.kind === "inspect-package") {
        const result: ExtensionCommandResult = {
          kind: "package-inspected",
          preview: {
            entry: {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: "1.2.0" as never,
              digest: digest as never,
              source: {
                kind: "plugin-package",
                sourceRef: "catalog:octant:build-helper" as never,
              },
            },
            review: previewReview(),
            diagnostics: [],
          },
        };
        results.push(result);
        return result;
      }
      if (command.kind === "uninstall-package") {
        const result: ExtensionCommandResult = {
          kind: "extension-state-updated",
          snapshot: { ...snapshot, packages: [] },
        };
        results.push(result);
        return result;
      }
      const result: ExtensionCommandResult = {
        kind: "extension-state-updated",
        snapshot,
      };
      results.push(result);
      return result;
    }),
  } as never;
}

describe("ExtensionsSettingsView", () => {
  it("loads installed packages and shows desired-vs-effective, provenance, and compatibility", async () => {
    const snapshot = installedSnapshot({
      activation: baseActivation({ trusted: true, pluginDesired: true, componentDesired: true }),
      componentEffectiveState: { kind: "effective" } as never,
    });
    const c = client({ snapshot });
    render(<ExtensionsSettingsView client={c} scope={scope} />);

    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
    expect(screen.getByText("macos")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /effective/i })).toBeInTheDocument();
  });

  it("hides uninstalled lifecycle tombstones from the Installed tab", async () => {
    const snapshot = installedSnapshot({ activation: baseActivation({ installed: false }) });
    const c = client({ snapshot });
    render(<ExtensionsSettingsView client={c} scope={scope} />);

    await waitFor(() =>
      expect(screen.getByText("No extension packages are installed.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Build Helper")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /uninstall/i })).not.toBeInTheDocument();
  });

  it("renders source-qualified Project and user-global standalone skills with collisions", async () => {
    const projectSkillId =
      "agents-skills-directory:project-skill:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never;
    const globalSkillId =
      "agents-skills-directory:global-skill:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as never;
    const snapshot = {
      ...installedSnapshot({ activation: baseActivation({ installed: false }) }),
      skills: [
        {
          skill: {
            qualifiedId: projectSkillId,
            name: "review",
            sourceKind: "agents-skills-directory",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            available: true,
          },
          source: {
            kind: "agents-skills-directory",
            sourceRef: "project:project-123:parent-1",
          },
          displayName: "Project review",
          provenance: { reviewed: false },
          contentBytes: 128,
          reviewed: false,
          desiredEnabled: false,
          effectiveState: { kind: "blocked", reason: "untrusted" },
        },
        {
          skill: {
            qualifiedId: globalSkillId,
            name: "review",
            sourceKind: "agents-skills-directory",
            digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            available: true,
          },
          source: {
            kind: "agents-skills-directory",
            sourceRef: "user-global",
          },
          displayName: "Global review",
          provenance: { reviewed: false },
          contentBytes: 256,
          reviewed: false,
          desiredEnabled: false,
          effectiveState: { kind: "blocked", reason: "untrusted" },
        },
      ],
      collisions: [
        {
          name: "review",
          candidates: [projectSkillId, globalSkillId],
        },
      ],
    } as unknown as ExtensionSnapshot;
    const c = client({ snapshot });

    render(<ExtensionsSettingsView client={c} scope={scope} />);

    await waitFor(() => expect(screen.getByText("Project review")).toBeInTheDocument());
    expect(screen.getByText("Global review")).toBeInTheDocument();
    expect(screen.getByText("Project skills · parent 1")).toBeInTheDocument();
    expect(screen.getByText("User-global · ~/.agents/skills")).toBeInTheDocument();
    expect(screen.getByText(String(projectSkillId))).toBeInTheDocument();
    expect(screen.getByText(String(globalSkillId))).toBeInTheDocument();
    expect(screen.getAllByText("Blocked — Untrusted")).toHaveLength(2);
    expect(screen.getByRole("status", { name: "Skill name collision: review" })).toHaveTextContent(
      "2 source-qualified candidates",
    );
    expect(c.calls).toContainEqual({ kind: "reconcile-skills" });
  });

  it("shows an honest blocked state and reason when a component is not effective", async () => {
    const snapshot = installedSnapshot();
    const c = client({ snapshot });
    render(<ExtensionsSettingsView client={c} scope={scope} />);

    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    expect(screen.getByRole("status", { name: /blocked/i })).toBeInTheDocument();
    expect(screen.getByText(/untrusted/i)).toBeInTheDocument();
  });

  it("surfaces quarantine, draining, broken, unavailable, interrupted, and waiting runtime states", async () => {
    const states = [
      "quarantined",
      "draining",
      "broken",
      "unavailable",
      "interrupted",
      "waiting",
    ] as const;
    for (const state of states) {
      const activation = baseActivation({
        trusted: true,
        pluginDesired: true,
        componentDesired: true,
        [state]: true,
      });
      const snapshot = installedSnapshot({
        activation,
        componentActivation: activation,
        componentEffectiveState: { kind: "blocked", reason: state } as never,
      });
      document.body.innerHTML = "";
      const c = client({ snapshot });
      render(<ExtensionsSettingsView client={c} scope={scope} />);
      await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
      expect(screen.getByText(new RegExp(state, "i"))).toBeInTheDocument();
    }
  });

  it("trusts, enables the plugin, enables the component, and uninstalls through the client", async () => {
    const c = client();
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());

    // Each lifecycle command reloads the snapshot: the card unmounts while
    // status is loading, then remounts disabled until busy clears. Waiting
    // only for the command to be recorded races the next click against that
    // reload. Uninstall is present and enabled only after the card has settled.
    const expectCommandThenSettled = async (match: (command: ExtensionCommand) => boolean) => {
      await waitFor(() => {
        expect(c.calls.some(match)).toBe(true);
        expect(screen.getByRole("button", { name: /uninstall/i })).toBeEnabled();
      });
    };

    fireEvent.click(screen.getByRole("button", { name: /trust source/i }));
    await expectCommandThenSettled(
      (command) => command.kind === "set-source-trust" && command.trusted,
    );

    fireEvent.click(screen.getByRole("button", { name: /enable plugin/i }));
    await expectCommandThenSettled(
      (command) => command.kind === "set-plugin-desired" && command.desired,
    );

    fireEvent.click(screen.getByRole("button", { name: /enable component/i }));
    await expectCommandThenSettled(
      (command) => command.kind === "set-component-desired" && command.desired,
    );

    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    await waitFor(() =>
      expect(c.calls.some((command) => command.kind === "uninstall-package")).toBe(true),
    );
  });

  it("disables enabling the plugin/component while quarantine or drain is pending and desired is off", async () => {
    const activation = baseActivation({ trusted: true, quarantined: true });
    const snapshot = installedSnapshot({
      activation,
      componentActivation: activation,
      componentEffectiveState: { kind: "blocked", reason: "quarantined" } as never,
    });
    const c = client({ snapshot });
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /enable plugin/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /enable component/i })).toBeDisabled();
  });

  it("allows disabling the plugin when it is desired-on but runtime-blocked (quarantined)", async () => {
    const activation = baseActivation({
      trusted: true,
      pluginDesired: true,
      quarantined: true,
    });
    const snapshot = installedSnapshot({
      activation,
      componentActivation: baseActivation({
        trusted: true,
        pluginDesired: true,
        componentDesired: true,
        quarantined: true,
      }),
      componentEffectiveState: { kind: "blocked", reason: "quarantined" } as never,
    });
    const c = client({ snapshot });
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    const disablePluginButton = screen.getByRole("button", { name: /disable plugin/i });
    expect(disablePluginButton).not.toBeDisabled();
    fireEvent.click(disablePluginButton);
    await waitFor(() =>
      expect(
        c.calls.some(
          (command) => command.kind === "set-plugin-desired" && command.desired === false,
        ),
      ).toBe(true),
    );
  });

  it("allows disabling a component when it is desired-on but runtime-blocked (draining)", async () => {
    const activation = baseActivation({
      trusted: true,
      pluginDesired: true,
      draining: true,
    });
    const snapshot = installedSnapshot({
      activation,
      componentActivation: baseActivation({
        trusted: true,
        pluginDesired: true,
        componentDesired: true,
        draining: true,
      }),
      componentEffectiveState: { kind: "blocked", reason: "draining" } as never,
    });
    const c = client({ snapshot });
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    const disableComponentButton = screen.getByRole("button", { name: /disable component/i });
    expect(disableComponentButton).not.toBeDisabled();
    fireEvent.click(disableComponentButton);
    await waitFor(() =>
      expect(
        c.calls.some(
          (command) =>
            command.kind === "set-component-desired" &&
            command.desired === false &&
            command.componentId === "server",
        ),
      ).toBe(true),
    );
  });

  it("allows revoking trust when the plugin is desired-on but runtime-blocked (broken)", async () => {
    const activation = baseActivation({
      trusted: true,
      pluginDesired: true,
      broken: true,
    });
    const snapshot = installedSnapshot({
      activation,
      componentActivation: baseActivation({
        trusted: true,
        pluginDesired: true,
        componentDesired: true,
        broken: true,
      }),
      componentEffectiveState: { kind: "blocked", reason: "broken" } as never,
    });
    const c = client({ snapshot });
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    const revokeButton = screen.getByRole("button", { name: /revoke trust/i });
    expect(revokeButton).not.toBeDisabled();
    fireEvent.click(revokeButton);
    await waitFor(() =>
      expect(
        c.calls.some((command) => command.kind === "set-source-trust" && command.trusted === false),
      ).toBe(true),
    );
  });

  it("searches the marketplace, inspects a package, then requires explicit confirmation before install", async () => {
    const c = client();
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));

    const search = await screen.findByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());

    // Step 1: inspect — no install yet.
    fireEvent.click(screen.getByRole("button", { name: /inspect build helper/i }));
    await waitFor(() =>
      expect(c.calls.some((command) => command.kind === "inspect-package")).toBe(true),
    );
    // Install must NOT fire automatically after inspection.
    expect(c.calls.some((command) => command.kind === "install-package")).toBe(false);

    // Step 2: user reviews the preview, then confirms install.
    const confirmButton = await screen.findByRole("button", { name: /confirm install/i });
    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(
        c.calls.some(
          (command) => command.kind === "install-package" && command.version === "1.2.0",
        ),
      ).toBe(true),
    );
  });

  it("clears stale catalog cards before a later marketplace search fails", async () => {
    let searches = 0;
    const c = client();
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-catalog") {
        searches += 1;
        if (searches === 1) {
          return {
            kind: "catalog-search-results",
            entries: [
              {
                extensionId: extensionId as never,
                packageId: packageId as never,
                slug: "build-helper" as never,
                displayName: "Build Helper",
                version: "1.2.0" as never,
                digest: digest as never,
                source: {
                  kind: "catalog",
                  catalogId: "octant" as never,
                  entryId: "build-helper" as never,
                },
              },
            ],
          } as ExtensionCommandResult;
        }
        return {
          kind: "extension-command-failed",
          failure: { category: "unavailable", message: "Catalog search unavailable." },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot: installedSnapshot() } as never;
    }) as never;

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    const search = screen.getByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    expect(
      await screen.findByRole("button", { name: /inspect build helper/i }),
    ).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    expect(await screen.findByText("Catalog search unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /inspect build helper/i })).toBeNull();
  });

  it("clears catalog cards when a refreshed effective snapshot becomes offline", async () => {
    const available = client();
    const view = render(<ExtensionsSettingsView client={available} scope={scope} />);
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    const search = screen.getByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    expect(
      await screen.findByRole("button", { name: /inspect build helper/i }),
    ).toBeInTheDocument();

    const snapshot = installedSnapshot();
    const offline = client({
      snapshot,
      effective: effectiveSnapshot(snapshot, { catalogStatus: "offline" }),
    });
    view.rerender(<ExtensionsSettingsView client={offline} scope={scope} />);

    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    expect(await screen.findByRole("status", { name: /catalog unavailable/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /inspect build helper/i })).toBeNull();
  });

  it("does not issue install-package when inspection fails and surfaces honest diagnostics", async () => {
    const c = client();
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-catalog") {
        return {
          kind: "catalog-search-results",
          entries: [
            {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: "1.2.0" as never,
              digest: digest as never,
              source: {
                kind: "catalog",
                catalogId: "octant" as never,
                entryId: "build-helper" as never,
              },
            },
          ],
        } as ExtensionCommandResult;
      }
      if (command.kind === "inspect-package") {
        return {
          kind: "extension-command-failed",
          failure: {
            category: "incompatible" as never,
            message: "Package manifest declares unsupported platform.",
          },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot: installedSnapshot() } as never;
    }) as never;
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));

    const search = await screen.findByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /inspect build helper/i }));
    await waitFor(() =>
      expect(c.calls.some((command) => command.kind === "inspect-package")).toBe(true),
    );
    // No install should be issued when inspection fails.
    expect(c.calls.some((command) => command.kind === "install-package")).toBe(false);
    // The failure category and message must be surfaced honestly.
    await waitFor(() => expect(screen.getByText(/^incompatible$/i)).toBeInTheDocument());
    expect(screen.getByText(/package manifest declares unsupported platform/i)).toBeInTheDocument();
    // No confirm-install button should appear after a failed inspection.
    expect(screen.queryByRole("button", { name: /confirm install/i })).toBeNull();
  });

  it("shows preview capabilities, provenance, and diagnostics after inspection before confirming install", async () => {
    const c = client();
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-catalog") {
        return {
          kind: "catalog-search-results",
          entries: [
            {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: "1.2.0" as never,
              digest: digest as never,
              source: {
                kind: "catalog",
                catalogId: "octant" as never,
                entryId: "build-helper" as never,
              },
            },
          ],
        } as ExtensionCommandResult;
      }
      if (command.kind === "inspect-package") {
        return {
          kind: "package-inspected",
          preview: {
            entry: {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: "1.2.0" as never,
              digest: digest as never,
              source: {
                kind: "plugin-package",
                sourceRef: "catalog:octant:build-helper" as never,
              },
            },
            review: previewReview(),
            diagnostics: [
              { code: "capability-notice" as never, message: "Requests MCP server access." },
            ],
          },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot: installedSnapshot() } as never;
    }) as never;
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));

    const search = await screen.findByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /inspect build helper/i }));
    // Preview diagnostics must be visible before the confirm button.
    await waitFor(() =>
      expect(screen.getByText(/requests mcp server access/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /confirm install/i })).toBeInTheDocument();
  });

  it("shows the curated Build iOS Apps source, license, compatibility, and capabilities before install", async () => {
    const c = client();
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-catalog") {
        return {
          kind: "catalog-search-results",
          entries: [
            {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-ios-apps" as never,
              displayName: "Build iOS Apps",
              version: "0.1.2" as never,
              digest: digest as never,
              source: {
                kind: "catalog",
                catalogId: "octant-curated" as never,
                entryId: "build-ios-apps" as never,
              },
            },
          ],
        } as ExtensionCommandResult;
      }
      if (command.kind === "inspect-package") {
        return {
          kind: "package-inspected",
          preview: {
            entry: {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-ios-apps" as never,
              displayName: "Build iOS Apps",
              version: "0.1.2" as never,
              digest: digest as never,
              source: {
                kind: "plugin-package",
                sourceRef: "catalog:octant-curated:build-ios-apps" as never,
              },
            },
            review: previewReview({
              description:
                "Build, refine, and debug iOS apps with App Intents, SwiftUI, and Xcode workflows.",
              provenance: {
                canonicalUrl: "https://github.com/openai/plugins",
                publisher: "OpenAI",
                sourceCommit: "cd0fccd4ed62dded584c16246685b232d7bfe7f6",
                reviewed: true,
                reviewedAt: "2026-07-30T00:00:00.000Z",
              },
              compatibility: {
                platforms: ["macos"],
                modes: ["chat", "work", "code"],
                providerFamilies: [],
              },
              declaredCapabilities: ["instructions"],
              components: [
                {
                  id: "skill-swiftui-ui-patterns",
                  kind: "skill-instructions",
                  displayName: "swiftui-ui-patterns",
                  declaredCapabilities: ["instructions"],
                },
              ],
            } as never),
            diagnostics: [],
          },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot: installedSnapshot() } as never;
    }) as never;
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));

    const search = await screen.findByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "ios" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    await waitFor(() => expect(screen.getByText("Build iOS Apps")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /inspect build ios apps/i }));
    await waitFor(() =>
      expect(screen.getByText(/app intents, swiftui, and xcode workflows/i)).toBeInTheDocument(),
    );
    // Reviewable upstream source and provenance before installation.
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("https://github.com/openai/plugins")).toBeInTheDocument();
    expect(screen.getByText(/cd0fccd4/)).toBeInTheDocument();
    expect(screen.getByText(/reviewed/i)).toBeInTheDocument();
    // License, version, digest, and compatibility before installation.
    expect(screen.getByText("MIT")).toBeInTheDocument();
    expect(screen.getByText("0.1.2")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(digest.slice(0, 20)))).toBeInTheDocument();
    expect(screen.getByText("macos")).toBeInTheDocument();
    expect(screen.getByText(/all providers/i)).toBeInTheDocument();
    // Declared capabilities and every contributed component before installation.
    // The MCP component with a floating @latest executable is permanently
    // unavailable; only skill-instructions contribute.
    expect(screen.getByText("instructions")).toBeInTheDocument();
    expect(screen.getByText("swiftui-ui-patterns")).toBeInTheDocument();
    expect(screen.queryByText("xcodebuildmcp")).not.toBeInTheDocument();
    expect(screen.queryByText(/mcp-server/)).not.toBeInTheDocument();
    // Installation still requires explicit confirmation; it is never implicit.
    expect(c.calls.some((command) => command.kind === "install-package")).toBe(false);
    expect(screen.getByRole("button", { name: /confirm install/i })).toBeInTheDocument();
  });

  it("reports an offline catalog and disables marketplace search", async () => {
    const snapshot = installedSnapshot();
    const c = client({
      snapshot,
      effective: effectiveSnapshot(snapshot, { catalogStatus: "offline" }),
    });
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));
    expect(await screen.findByRole("status", { name: /catalog unavailable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run search/i })).toBeDisabled();
  });

  it("shows an actionable failure category when a lifecycle command fails", async () => {
    const snapshot = installedSnapshot();
    const c = client({ snapshot });
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      if (command.kind === "uninstall-package") {
        return {
          kind: "extension-command-failed",
          failure: { category: "waiting", message: "Cleanup is waiting." },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot } as ExtensionCommandResult;
    }) as never;
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    await waitFor(() => expect(screen.getByText(/^waiting$/i)).toBeInTheDocument());
    expect(screen.getByText(/cleanup is waiting/i)).toBeInTheDocument();
  });

  it("reports an unavailable transport without leaking error detail", async () => {
    const c = client();
    c.snapshot = vi.fn(async () => {
      throw new (class extends Error {
        readonly category = "unavailable";
        constructor() {
          super("private transport detail");
          this.name = "ExtensionClientFailure";
        }
      })();
    }) as never;
    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() =>
      expect(screen.getByRole("status", { name: /extensions unavailable/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/private transport detail/i)).toBeNull();
  });

  it("clears the preview and blocks stale confirm when a new search returns a different version/digest for the same extension/package IDs", async () => {
    const digestA = `sha256:${"a".repeat(64)}`;
    const digestB = `sha256:${"b".repeat(64)}`;
    const versionA = "1.2.0";
    const versionB = "2.0.0";
    let searchCallCount = 0;
    const c = client();
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-catalog") {
        searchCallCount++;
        const isSecondSearch = searchCallCount === 2;
        const result: ExtensionCommandResult = {
          kind: "catalog-search-results",
          entries: [
            {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: (isSecondSearch ? versionB : versionA) as never,
              digest: (isSecondSearch ? digestB : digestA) as never,
              source: {
                kind: "catalog",
                catalogId: "octant" as never,
                entryId: "build-helper" as never,
              },
            },
          ],
        };
        c.results.push(result);
        return result;
      }
      if (command.kind === "inspect-package") {
        // Return the preview matching the source/digest that was inspected.
        const inspectedDigest = command.expectedDigest;
        const inspectedVersion = inspectedDigest === digestA ? versionA : versionB;
        const result: ExtensionCommandResult = {
          kind: "package-inspected",
          preview: {
            entry: {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: inspectedVersion as never,
              digest: inspectedDigest as never,
              source: {
                kind: "plugin-package",
                sourceRef: "catalog:octant:build-helper" as never,
              },
            },
            review: previewReview(),
            diagnostics: [],
          },
        };
        c.results.push(result);
        return result;
      }
      return { kind: "extension-state-updated", snapshot: installedSnapshot() } as never;
    }) as never;

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));

    // First search: returns version A / digest A.
    const search = await screen.findByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    await waitFor(() => expect(screen.getByText(versionA)).toBeInTheDocument());

    // Inspect version A.
    fireEvent.click(screen.getByRole("button", { name: /inspect build helper/i }));
    await waitFor(() => expect(c.calls.some((cmd) => cmd.kind === "inspect-package")).toBe(true));
    // Preview with "Confirm install" should be visible.
    expect(screen.getByRole("button", { name: /confirm install/i })).toBeInTheDocument();

    // Second search: returns version B / digest B for the SAME extension/package IDs.
    fireEvent.change(search, { target: { value: "build helper" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    await waitFor(() => expect(screen.getByText(versionB)).toBeInTheDocument());

    // The old preview (for version A) must be gone — no "Confirm install" button.
    expect(screen.queryByRole("button", { name: /confirm install/i })).toBeNull();

    // No install-package should have been issued with the stale version A.
    expect(c.calls.some((cmd) => cmd.kind === "install-package" && cmd.version === versionA)).toBe(
      false,
    );
    // No install-package should have been issued at all (no auto-install).
    expect(c.calls.some((cmd) => cmd.kind === "install-package")).toBe(false);

    // User must re-inspect version B before confirming.
    fireEvent.click(screen.getByRole("button", { name: /inspect build helper/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /confirm install/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /confirm install/i }));
    await waitFor(() =>
      expect(
        c.calls.some((cmd) => cmd.kind === "install-package" && cmd.version === versionB),
      ).toBe(true),
    );
  });

  it("prevents double-submit of the confirm install button", async () => {
    const c = client();
    let installCallCount = 0;
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-catalog") {
        return {
          kind: "catalog-search-results",
          entries: [
            {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: "1.2.0" as never,
              digest: digest as never,
              source: {
                kind: "catalog",
                catalogId: "octant" as never,
                entryId: "build-helper" as never,
              },
            },
          ],
        } as ExtensionCommandResult;
      }
      if (command.kind === "inspect-package") {
        return {
          kind: "package-inspected",
          preview: {
            entry: {
              extensionId: extensionId as never,
              packageId: packageId as never,
              slug: "build-helper" as never,
              displayName: "Build Helper",
              version: "1.2.0" as never,
              digest: digest as never,
              source: {
                kind: "plugin-package",
                sourceRef: "catalog:octant:build-helper" as never,
              },
            },
            review: previewReview(),
            diagnostics: [],
          },
        } as ExtensionCommandResult;
      }
      if (command.kind === "install-package") {
        installCallCount++;
        // Simulate a slow install that hasn't resolved yet.
        return new Promise<ExtensionCommandResult>(() => undefined);
      }
      return { kind: "extension-state-updated", snapshot: installedSnapshot() } as never;
    }) as never;

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));

    const search = await screen.findByRole("searchbox", { name: /search marketplace/i });
    fireEvent.change(search, { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: /run search/i }));
    await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /inspect build helper/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /confirm install/i })).toBeInTheDocument(),
    );

    const confirmButton = screen.getByRole("button", { name: /confirm install/i });
    // Click confirm once — this starts the install.
    fireEvent.click(confirmButton);
    // The button should now be disabled to prevent double-submit.
    await waitFor(() => expect(confirmButton).toBeDisabled());
    // Click again — this must not produce a second install-package call.
    fireEvent.click(confirmButton);

    // Wait a tick to let any potential second call propagate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(installCallCount).toBe(1);
  });

  it.each([
    [
      "allows the canonical catalog → plugin-package inspection",
      { kind: "plugin-package", sourceRef: "catalog:octant:build-helper" },
      true,
    ],
    [
      "rejects a local-folder that spoofs the canonical catalog reference",
      { kind: "local-folder", sourceRef: "catalog:octant:build-helper" },
      false,
    ],
    [
      "rejects a noncanonical plugin-package reference",
      { kind: "plugin-package", sourceRef: "octant:build-helper" },
      false,
    ],
  ] as const)(
    "enforces source-kind-safe catalog/search→inspection identity: %s",
    async (_label, previewSource, expectConfirm) => {
      const c = client();
      c.execute = vi.fn(async (command: ExtensionCommand) => {
        c.calls.push(command);
        if (command.kind === "search-catalog") {
          return {
            kind: "catalog-search-results",
            entries: [
              {
                extensionId: extensionId as never,
                packageId: packageId as never,
                slug: "build-helper" as never,
                displayName: "Build Helper",
                version: "1.2.0" as never,
                digest: digest as never,
                source: {
                  kind: "catalog",
                  catalogId: "octant" as never,
                  entryId: "build-helper" as never,
                },
              },
            ],
          } as ExtensionCommandResult;
        }
        if (command.kind === "inspect-package") {
          return {
            kind: "package-inspected",
            preview: {
              entry: {
                extensionId: extensionId as never,
                packageId: packageId as never,
                slug: "build-helper" as never,
                displayName: "Build Helper",
                version: "1.2.0" as never,
                digest: digest as never,
                source: previewSource as never,
              },
              review: previewReview(),
              diagnostics: [],
            },
          } as ExtensionCommandResult;
        }
        return { kind: "extension-state-updated", snapshot: installedSnapshot() } as never;
      }) as never;

      render(<ExtensionsSettingsView client={c} scope={scope} />);
      await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));

      const search = await screen.findByRole("searchbox", { name: /search marketplace/i });
      fireEvent.change(search, { target: { value: "build" } });
      fireEvent.click(screen.getByRole("button", { name: /run search/i }));
      await waitFor(() => expect(screen.getByText("Build Helper")).toBeInTheDocument());

      const inspectButton = screen.getByRole("button", { name: /inspect build helper/i });
      fireEvent.click(inspectButton);
      await waitFor(() => expect(inspectButton).not.toBeDisabled());
      if (expectConfirm) {
        expect(screen.getByRole("button", { name: /confirm install/i })).toBeInTheDocument();
      } else {
        expect(screen.queryByRole("button", { name: /confirm install/i })).toBeNull();
      }
      // No automatic install should be issued in any case.
      expect(c.calls.some((cmd) => cmd.kind === "install-package")).toBe(false);
    },
  );

  it("searches, previews, and installs a standalone skill without trusting or enabling it", async () => {
    const qualifiedId = `catalog:frontend-design:${digest}` as NonNullable<
      ExtensionSnapshot["skills"]
    >[number]["skill"]["qualifiedId"];
    const source = {
      kind: "catalog" as const,
      catalogId: "skills-sh" as never,
      entryId: "frontend-design" as never,
    };
    const entry = {
      skill: {
        qualifiedId,
        name: "frontend-design",
        sourceKind: "catalog" as const,
        digest: digest as never,
        available: true,
      },
      source,
      version: "1.0.0" as never,
      displayName: "Frontend Design",
      description: "Design distinctive production interfaces.",
      provenance: {
        canonicalUrl: "https://skills.sh/example/frontend-design",
        publisher: "Example Publisher",
        reviewed: false,
      },
    };
    let installed = false;
    const emptySnapshot = {
      ...installedSnapshot({ activation: baseActivation({ installed: false }) }),
      packages: [],
      skills: [],
    } as unknown as ExtensionSnapshot;
    const installedSkillSnapshot = {
      ...emptySnapshot,
      skills: [
        {
          ...entry,
          contentBytes: 256,
          reviewed: false,
          desiredEnabled: false,
          effectiveState: { kind: "blocked", reason: "untrusted" },
        },
      ],
    } as unknown as ExtensionSnapshot;
    const c = client({ snapshot: emptySnapshot });
    c.snapshot = vi.fn(async () => (installed ? installedSkillSnapshot : emptySnapshot)) as never;
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-skills") {
        return { kind: "skill-search-results", entries: [entry] } as ExtensionCommandResult;
      }
      if (command.kind === "preview-skill") {
        return {
          kind: "skill-package-preview",
          preview: {
            entry,
            extensionId: extensionId as never,
            packageId: packageId as never,
            license: { kind: "spdx", identifier: "MIT" },
            instructions: "Follow the full frontend review checklist before changing code.",
            diagnostics: [],
          },
        } as ExtensionCommandResult;
      }
      if (command.kind === "install-skill") {
        installed = true;
        return {
          kind: "extension-state-updated",
          snapshot: installedSkillSnapshot,
        } as ExtensionCommandResult;
      }
      if (command.kind === "reconcile-skills") {
        return {
          kind: "extension-state-updated",
          snapshot: installed ? installedSkillSnapshot : emptySnapshot,
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot: emptySnapshot } as ExtensionCommandResult;
    }) as never;

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    fireEvent.change(screen.getByRole("searchbox", { name: /search skills\.sh and npm/i }), {
      target: { value: "frontend" },
    });
    fireEvent.click(screen.getByRole("button", { name: /search skills/i }));

    expect(await screen.findByText("Frontend Design")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /preview frontend design/i }));
    expect(
      await screen.findByRole("button", { name: /confirm skill install/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Skill package preview")).toHaveTextContent("LicenseMIT");
    expect(screen.getByLabelText("Skill package preview")).toHaveTextContent(
      "Follow the full frontend review checklist before changing code.",
    );
    expect(
      screen.getByText(/Installs start disabled — trust and enable them from Installed\./),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /confirm skill install/i }));

    await waitFor(() =>
      expect(c.calls).toContainEqual({
        kind: "install-skill",
        extensionId,
        packageId,
        version: "1.0.0",
        digest,
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: /installed/i }));
    expect(await screen.findByText("Blocked — Untrusted")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("updates a standalone skill when the preview matches an installed package identity", async () => {
    const snapshot = installedSnapshot();
    const entry = {
      skill: {
        qualifiedId: `catalog:frontend-design:${digest}` as never,
        name: "frontend-design",
        sourceKind: "catalog" as const,
        digest: digest as never,
        available: true,
      },
      source: {
        kind: "catalog" as const,
        catalogId: "npm-skills" as never,
        entryId: "frontend-design-v2" as never,
      },
      version: "2.0.0" as never,
      displayName: "Frontend Design",
      provenance: { reviewed: false },
    };
    const c = client({ snapshot });
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-skills") {
        return { kind: "skill-search-results", entries: [entry] } as ExtensionCommandResult;
      }
      if (command.kind === "preview-skill") {
        return {
          kind: "skill-package-preview",
          preview: {
            entry,
            extensionId: extensionId as never,
            packageId: packageId as never,
            license: { kind: "spdx", identifier: "MIT" },
            diagnostics: [],
          },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot } as ExtensionCommandResult;
    }) as never;

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    fireEvent.change(screen.getByRole("searchbox", { name: /search skills\.sh and npm/i }), {
      target: { value: "frontend" },
    });
    fireEvent.click(screen.getByRole("button", { name: /search skills/i }));
    fireEvent.click(await screen.findByRole("button", { name: /preview frontend design/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm skill update/i }));

    await waitFor(() =>
      expect(c.calls).toContainEqual({
        kind: "update-skill",
        extensionId,
        packageId,
        version: "2.0.0",
        digest,
      }),
    );
    expect(c.calls.some((command) => command.kind === "install-skill")).toBe(false);
  });

  it("does not offer an update for the exact installed skill version and digest", async () => {
    const snapshot = installedSnapshot();
    const entry = {
      skill: {
        qualifiedId: `catalog:frontend-design:${digest}` as never,
        name: "frontend-design",
        sourceKind: "catalog" as const,
        digest: digest as never,
        available: true,
      },
      source: {
        kind: "catalog" as const,
        catalogId: "npm-skills" as never,
        entryId: "frontend-design-current" as never,
      },
      version: "1.2.0" as never,
      displayName: "Frontend Design",
      provenance: { reviewed: false },
    };
    const c = client({ snapshot });
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-skills") {
        return { kind: "skill-search-results", entries: [entry] } as ExtensionCommandResult;
      }
      if (command.kind === "preview-skill") {
        return {
          kind: "skill-package-preview",
          preview: {
            entry,
            extensionId: extensionId as never,
            packageId: packageId as never,
            license: { kind: "spdx", identifier: "MIT" },
            diagnostics: [],
          },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot } as ExtensionCommandResult;
    }) as never;

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    fireEvent.change(screen.getByRole("searchbox", { name: /search skills\.sh and npm/i }), {
      target: { value: "frontend" },
    });
    fireEvent.click(screen.getByRole("button", { name: /search skills/i }));
    fireEvent.click(await screen.findByRole("button", { name: /preview frontend design/i }));

    expect(await screen.findByRole("button", { name: /skill already installed/i })).toBeDisabled();
    expect(
      c.calls.some(
        (command) => command.kind === "install-skill" || command.kind === "update-skill",
      ),
    ).toBe(false);
  });

  it("clears stale skill results before a later search fails", async () => {
    const emptySnapshot = {
      ...installedSnapshot({ activation: baseActivation({ installed: false }) }),
      packages: [],
      skills: [],
    } as unknown as ExtensionSnapshot;
    let searches = 0;
    const c = client({ snapshot: emptySnapshot });
    c.execute = vi.fn(async (command: ExtensionCommand) => {
      c.calls.push(command);
      if (command.kind === "search-skills") {
        searches += 1;
        if (searches === 1) {
          return {
            kind: "skill-search-results",
            entries: [
              {
                skill: {
                  qualifiedId: `catalog:react:${digest}` as never,
                  name: "react",
                  sourceKind: "catalog",
                  digest: digest as never,
                  available: true,
                },
                source: {
                  kind: "catalog",
                  catalogId: "skills-sh" as never,
                  entryId: "react" as never,
                },
                version: "1.0.0" as never,
                displayName: "React Skill",
                provenance: { reviewed: false },
              },
            ],
          } as ExtensionCommandResult;
        }
        return {
          kind: "extension-command-failed",
          failure: { category: "unavailable", message: "Search unavailable." },
        } as ExtensionCommandResult;
      }
      return { kind: "extension-state-updated", snapshot: emptySnapshot } as ExtensionCommandResult;
    }) as never;

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    const search = screen.getByRole("searchbox", { name: /search skills\.sh and npm/i });
    fireEvent.change(search, { target: { value: "react" } });
    fireEvent.click(screen.getByRole("button", { name: /search skills/i }));
    expect(await screen.findByText("React Skill")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: /search skills/i }));
    expect(await screen.findByText("Search unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("React Skill")).toBeNull();
  });

  it("does not contact skill registries when marketplace fetches are off", async () => {
    const snapshot = installedSnapshot({ activation: baseActivation({ installed: false }) });
    const c = client({ snapshot });

    render(<ExtensionsSettingsView client={c} marketplaceFetchesEnabled={false} scope={scope} />);
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    expect(
      screen.getByText(/Marketplace fetches are off in Settings → General → Marketplace/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search skills/i })).toBeDisabled();
    expect(c.calls.map((command) => command.kind)).not.toContain("search-skills");
    expect(c.calls.map((command) => command.kind)).not.toContain("inspect-package");
    expect(c.calls.map((command) => command.kind)).not.toContain("preview-skill");
  });
});

describe("local Agent Plugin import", () => {
  it("does not expose a renderer-entered local filesystem path", async () => {
    const snapshot = installedSnapshot({ activation: baseActivation({ installed: false }) });
    const c = client({ snapshot });

    render(<ExtensionsSettingsView client={c} scope={scope} />);
    await waitFor(() =>
      expect(screen.getByText("No extension packages are installed.")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("tab", { name: /marketplace/i }));
    expect(
      screen.queryByRole("textbox", { name: /local agent plugin folder path/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /import local agent plugin/i }),
    ).not.toBeInTheDocument();
  });

  it("consumes the native folder picker's opaque receipt", async () => {
    const snapshot = installedSnapshot({ activation: baseActivation({ installed: false }) });
    const c = client({ snapshot });
    c.importLocalPluginReceipt = vi.fn(async () => ({
      kind: "package-inspected",
      preview: {
        entry: {
          extensionId: extensionId as never,
          packageId: packageId as never,
          slug: "hello-plugin" as never,
          displayName: "hello-plugin",
          version: "1.0.0" as never,
          digest: digest as never,
          source: {
            kind: "local-folder",
            sourceRef: "local-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as never,
          },
        },
        review: previewReview({
          description: "Browsed Agent Plugin",
          declaredCapabilities: ["instructions"],
          components: [
            {
              id: "review",
              kind: "skill-instructions",
              displayName: "Review",
              declaredCapabilities: ["instructions"],
              instructions: "Inspect the complete diff before making changes.",
            },
          ],
        } as never),
        diagnostics: [
          {
            code: "skill-invalid" as never,
            message: "Skipped an invalid sibling skill before installation.",
          },
        ],
      },
    })) as never;
    const receiptId = "R".repeat(43);
    const pickLocalPluginFolder = vi.fn(async () => ({
      receiptId,
      displayName: "browsed-plugin",
    }));

    render(
      <ExtensionsSettingsView
        client={c}
        pickLocalPluginFolder={pickLocalPluginFolder}
        scope={scope}
      />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: /marketplace/i }));
    fireEvent.click(await screen.findByRole("button", { name: /import local agent plugin/i }));
    await waitFor(() => expect(pickLocalPluginFolder).toHaveBeenCalled());
    await waitFor(() => expect(c.importLocalPluginReceipt).toHaveBeenCalledWith(receiptId));
    expect(
      await screen.findByText(/skipped an invalid sibling skill before installation/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Inspect the complete diff before making changes.")).toBeVisible();
    expect(screen.getByText(/bundled skill instructions/i)).toBeVisible();
  });
});
