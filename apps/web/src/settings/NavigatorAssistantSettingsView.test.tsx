import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { ShellSettings } from "@octant/contracts/shell";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NavigatorAssistantSettingsView } from "./NavigatorAssistantSettingsView";

const now = "2026-08-15T08:00:00.000Z";
const providerA = "10000000-0000-4000-8000-000000000001";

describe("NavigatorAssistantSettingsView", () => {
  it("uses the same open preference-section grammar as Appearance", () => {
    render(<NavigatorAssistantSettingsView onSettingsChange={vi.fn()} settings={{}} />);

    expect(
      screen.getByRole("heading", { name: "Models" }).closest(".settings-card-section"),
    ).toHaveClass("settings-card-section--open");
  });

  it("persists the default model through one shell settings patch", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    render(
      <NavigatorAssistantSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={{}}
      />,
    );

    expect(
      screen.getByText("Navigator is unavailable until a default model is chosen."),
    ).toBeVisible();

    await user.click(screen.getAllByRole("option", { name: /Model A/ })[0]!);

    expect(onSettingsChange).toHaveBeenCalledWith({
      navigatorAssistant: {
        defaultProvider: { providerInstanceId: providerA as never, modelId: "model-a" as never },
      },
    });
  });

  it("configures and clears the vision reviewer without touching the default model", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn<(patch: Partial<ShellSettings>) => void>();
    const configured = {
      defaultProvider: { providerInstanceId: providerA as never, modelId: "model-a" as never },
      visionReviewer: { providerInstanceId: providerA as never, modelId: "model-a" as never },
    } as const;
    render(
      <NavigatorAssistantSettingsView
        onSettingsChange={onSettingsChange}
        providerSnapshot={providerSnapshot()}
        settings={configured}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Clear vision reviewer" }));

    expect(onSettingsChange).toHaveBeenCalledWith({
      navigatorAssistant: { defaultProvider: configured.defaultProvider },
    });
  });

  it("reports what the chosen pair actually does with an image", () => {
    const unverified = {
      defaultProvider: { providerInstanceId: providerA as never, modelId: "model-a" as never },
    } as const;
    const { rerender } = render(
      <NavigatorAssistantSettingsView
        onSettingsChange={vi.fn()}
        providerSnapshot={providerSnapshot()}
        settings={unverified}
      />,
    );

    // Model A reports text-only modalities and no explicit imageInput, so its
    // image support is unknown — which is not supported.
    expect(
      screen.getByText("Image support is unverified for the Navigator default model.", {
        exact: false,
      }),
    ).toBeVisible();

    rerender(
      <NavigatorAssistantSettingsView
        onSettingsChange={vi.fn()}
        providerSnapshot={providerSnapshot()}
        settings={{ ...unverified, visionReviewer: unverified.defaultProvider }}
      />,
    );
    expect(
      screen.getByText("Images are described by the vision reviewer", { exact: false }),
    ).toBeVisible();

    rerender(
      <NavigatorAssistantSettingsView
        onSettingsChange={vi.fn()}
        providerSnapshot={providerSnapshot({ imageInput: "supported" })}
        settings={unverified}
      />,
    );
    expect(
      screen.getByText("The default model reads images directly", { exact: false }),
    ).toBeVisible();
  });

  it("states honestly that no providers are available instead of rendering an empty picker", () => {
    render(<NavigatorAssistantSettingsView onSettingsChange={vi.fn()} settings={{}} />);

    expect(
      screen.getByText(
        "No ready providers are available. Connect one in Providers & Models to configure Navigator.",
      ),
    ).toBeVisible();
    expect(screen.getByText("No vision reviewer is configured.", { exact: false })).toBeVisible();
  });
});

function providerSnapshot(
  model: { readonly imageInput?: "supported" | "unsupported" } = {},
): ProviderRegistrySnapshot {
  const capability = "supported" as const;
  return {
    defaults: { permissionPersistence: "current-session", version: 1 as never },
    instances: [
      {
        id: providerA as never,
        displayName: "Provider A",
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1 as never,
        createdAt: now as never,
        updatedAt: now as never,
        driverKind: "opencode",
        configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" },
      },
    ],
    observedStates: [
      {
        instanceId: providerA as never,
        readiness: "ready" as const,
        processState: "running" as const,
        models: [
          {
            id: "model-a" as never,
            displayName: "Model A",
            reasoning: "supported" as const,
            inputModalities: ["text"] as const,
            ...(model.imageInput === undefined ? {} : { imageInput: model.imageInput }),
            options: [],
            source: "discovered" as const,
            verification: "verified" as const,
          },
        ],
        capabilities: {
          streaming: capability,
          resume: capability,
          interruption: capability,
          approvals: capability,
          userQuestions: capability,
          reasoning: capability,
          usage: capability,
          toolActivity: capability,
          fileChanges: "unsupported" as const,
          diffs: "unsupported" as const,
          taskProgress: capability,
          nativeChildAgents: "unsupported" as const,
          nativeAttachments: capability,
          nativeWebResearch: capability,
          appManagedTools: capability,
          citations: capability,
        },
        observedAt: now as never,
      },
    ],
  };
}
