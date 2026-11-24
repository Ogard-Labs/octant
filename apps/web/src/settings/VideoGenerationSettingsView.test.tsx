import type { VideoGenerationSettings } from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProviderController } from "../providers/useProviderController";
import { VideoGenerationSettingsView } from "./VideoGenerationSettingsView";

const now = "2026-11-22T10:00:00.000Z";
const videoId = "00000000-0000-4000-8000-00000000c010";

function providerController(snapshot?: ProviderRegistrySnapshot): ProviderController {
  return {
    status: "ready",
    snapshot,
    instances: snapshot?.instances ?? [],
    observedByInstance: new Map(
      (snapshot?.observedStates ?? []).map((state) => [state.instanceId, state]),
    ),
    defaults: { permissionPersistence: "current-session", version: 0 as never },
    busy: false,
    probingIds: new Set(),
    updatingIds: new Set(),
    credentialManagementAvailable: false,
    retry: vi.fn(async () => true),
  } as unknown as ProviderController;
}

function providerSnapshot(): ProviderRegistrySnapshot {
  return {
    defaults: { permissionPersistence: "current-session", version: 1 as never },
    instances: [
      {
        id: videoId as never,
        displayName: "Gemini Video",
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1 as never,
        createdAt: now as never,
        updatedAt: now as never,
        driverKind: "gemini-video",
        configuration: {
          kind: "gemini-video-http",
          modelAllowlist: ["gemini-omni-1.2-flash" as never],
          defaultModel: "gemini-omni-1.2-flash" as never,
        },
      },
    ],
    observedStates: [],
  };
}

describe("VideoGenerationSettingsView", () => {
  it("lists the Gemini video profile and offers it when adding a video provider", async () => {
    const user = userEvent.setup();
    const snapshot = providerSnapshot();
    render(
      <VideoGenerationSettingsView
        onSettingsChange={vi.fn()}
        providerController={providerController(snapshot)}
        providerSnapshot={snapshot}
        settings={{} as VideoGenerationSettings}
      />,
    );

    expect(screen.getByRole("article", { name: "Gemini Video" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add video provider" }));
    expect(screen.getByRole("form", { name: "Add Gemini video profile" })).toBeVisible();
  });
});
