import type { ChatSettings } from "@octant/contracts/chat";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { ChatSettingsView, type UpdateChatSettingsCommand } from "./ChatSettingsView";

const now = "2026-07-20T08:00:00.000Z";
const providerA = "10000000-0000-4000-8000-000000000001";
const providerB = "10000000-0000-4000-8000-000000000002";

describe("ChatSettingsView", () => {
  it("edits new-thread defaults through one authoritative settings command", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(command: UpdateChatSettingsCommand) => Promise<boolean>>(
      async () => true,
    );
    render(
      <ChatSettingsView
        onUpdate={onUpdate}
        providerSnapshot={providerSnapshot()}
        settings={settings()}
      />,
    );

    expect(screen.getByRole("form", { name: "Chat defaults" })).toHaveAttribute("novalidate");
    // Every default is a setting row in the open Settings grammar, with the
    // research default as a switch rather than a checkbox.
    expect(screen.getByRole("form", { name: "Chat defaults" })).toHaveClass("setgroup");
    expect(screen.getByRole("form", { name: "Chat defaults" }).closest("section")).toHaveClass(
      "settings-card-section--open",
    );
    expect(screen.getByRole("switch", { name: "Enable research by default" })).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // Settings keep what you change; nothing here waits behind a Save step.
    expect(screen.queryByRole("button", { name: /Save/i })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Default research backend" })).toHaveTextContent(
      "Automatic",
    );
    expect(
      screen.getByText(
        "These defaults apply only to new threads. Existing threads keep their explicit values.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("option", { name: /Model B Plus/ }));
    await user.click(screen.getByLabelText("Enable research by default"));
    await chooseSelectFieldOption(
      user,
      screen.getByRole("combobox", { name: "Default research backend" }),
      "SearXNG",
    );
    await user.type(screen.getByLabelText("SearXNG base URL"), "https://search.example/");
    await user.clear(screen.getByLabelText("Calm personality instructions"));
    await user.type(screen.getByLabelText("Calm personality instructions"), "Be calm and precise.");
    await user.tab();

    expect(onUpdate).toHaveBeenLastCalledWith({
      kind: "update-chat-settings",
      expectedVersion: 4 as never,
      defaultProviderInstanceId: providerB as never,
      defaultModelId: "model-b-plus" as never,
      defaultResearchEnabled: true,
      defaultResearchRouting: "searxng",
      searxngBaseUrl: "https://search.example/",
      defaultPersonalityInstructions: "Be calm and precise.",
      providerFallback: {
        providerInstanceId: providerA as never,
        modelId: "model-a" as never,
      },
    });
  }, 15_000);

  it("rejects non-HTTPS endpoints unless HTTP is loopback", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(command: UpdateChatSettingsCommand) => boolean>(() => true);
    render(
      <ChatSettingsView
        onUpdate={onUpdate}
        providerSnapshot={providerSnapshot()}
        settings={settings()}
      />,
    );

    await user.type(screen.getByLabelText("SearXNG base URL"), "http://search.example/");
    expect(await screen.findByText("Use HTTPS or a loopback HTTP address.")).toBeVisible();
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("SearXNG base URL"));
    await user.type(screen.getByLabelText("SearXNG base URL"), "http://127.0.0.1:8080/");
    expect(screen.queryByText("Use HTTPS or a loopback HTTP address.")).not.toBeInTheDocument();
    await user.tab();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("rejects endpoint query and fragment delimiters before saving", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(command: UpdateChatSettingsCommand) => boolean>(() => true);
    render(
      <ChatSettingsView
        onUpdate={onUpdate}
        providerSnapshot={providerSnapshot()}
        settings={settings()}
      />,
    );

    await user.type(screen.getByLabelText("SearXNG base URL"), "https://search.example/?q=unsafe");
    expect(
      await screen.findByText("Use a base URL without credentials, query, or fragment."),
    ).toBeVisible();
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

function settings(): ChatSettings {
  return {
    defaultProviderInstanceId: providerA as never,
    defaultModelId: "model-a" as never,
    defaultResearchEnabled: false,
    defaultResearchRouting: "automatic",
    defaultPersonalityInstructions: "Be calm, direct, and useful.",
    providerFallback: {
      providerInstanceId: providerA as never,
      modelId: "model-a" as never,
    },
    version: 4 as never,
    updatedAt: now as never,
  };
}

function providerSnapshot(): ProviderRegistrySnapshot {
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
      {
        id: providerB as never,
        displayName: "Provider B",
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
      observation(providerA, [model("model-a", "Model A")], capability),
      observation(
        providerB,
        [model("model-b", "Model B"), model("model-b-plus", "Model B Plus")],
        capability,
      ),
    ],
  };
}

function observation(
  instanceId: string,
  models: ReadonlyArray<ReturnType<typeof model>>,
  capability: "supported",
) {
  return {
    instanceId: instanceId as never,
    readiness: "ready" as const,
    processState: "running" as const,
    models,
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
  };
}

function model(id: string, displayName: string) {
  return {
    id: id as never,
    displayName,
    reasoning: "supported" as const,
    inputModalities: ["text"] as const,
    options: [],
    source: "discovered" as const,
    verification: "verified" as const,
  };
}
