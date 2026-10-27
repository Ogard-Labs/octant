import {
  decodeDiscoverySnapshot,
  decodeProviderInstance,
  decodeProviderInstanceId,
  type DiscoverySnapshot,
  type ProviderCredentialStatus,
  type ProviderInstance,
  type ProviderObservedState,
  type ProviderRegistrySnapshot,
} from "@octant/contracts";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import type { HostPlatform } from "@octant/contracts/host";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCreateForm } from "./ProviderSettingsConfiguration";
import { ProviderSettingsList } from "./ProviderSettingsList";
import { ProviderSettingsView, type ProviderSettingsViewProps } from "./ProviderSettingsView";
import { ModelEndpointSettingsView } from "../settings/ModelEndpointSettingsView";
import { useProviderController } from "./useProviderController";
import { HostPlatformContext } from "../platform";
import type { OctantHostBridge } from "../shell/hostBridge";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";

const id = decodeProviderInstanceId("80000000-0000-4000-8000-000000000092");

// Settings here run against a macOS host, which keeps keys in its Keychain,
// unless a test names another host platform.
function renderProviderSettings(ui: ReactElement, hostPlatform: HostPlatform = "darwin") {
  function OnHost(props: { readonly children: ReactNode }) {
    return (
      <HostPlatformContext.Provider value={hostPlatform}>
        {props.children}
      </HostPlatformContext.Provider>
    );
  }
  return render(ui, { wrapper: OnHost });
}

function renderExpanded(ui: ReactElement, hostPlatform: HostPlatform = "darwin") {
  const result = renderProviderSettings(ui, hostPlatform);
  // Octant Harness: a single endpoint opens on its detail page, where its
  // configuration is always shown; with none, Add endpoint opens the form.
  const endpointLinks = screen.queryAllByRole("link", { name: /Open details$/ });
  if (endpointLinks.length === 1) fireEvent.click(endpointLinks[0]!);
  else if (endpointLinks.length === 0) {
    const add = screen.queryByRole("button", { name: "Add endpoint" });
    if (add !== null) fireEvent.click(add);
  }
  const manual = screen.queryByRole("button", { name: "Add provider manually" });
  if (manual?.getAttribute("aria-expanded") === "false") fireEvent.click(manual);
  for (const details of screen.queryAllByRole("button", { name: /^Details for / })) {
    if (details.getAttribute("aria-expanded") === "false") fireEvent.click(details);
  }
  for (const configure of screen.queryAllByRole("button", { name: /^Configure / })) {
    if (configure.getAttribute("aria-expanded") === "false") fireEvent.click(configure);
  }
  return result;
}

/** Opens Add endpoint, whose dialog holds the endpoint-by-address form. */
function renderAdding(ui: ReactElement, hostPlatform: HostPlatform = "darwin") {
  const result = renderProviderSettings(ui, hostPlatform);
  fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
  return result;
}

function renderProviderListExpanded(
  props: ProviderSettingsViewProps,
  hostPlatform: HostPlatform = "darwin",
) {
  return renderExpanded(
    <ProviderSettingsList {...props} discoverySnapshot={props.discoverySnapshot} />,
    hostPlatform,
  );
}

function renderImageProviderCreation(
  props: ProviderSettingsViewProps,
  hostPlatform: HostPlatform = "darwin",
) {
  const result = renderProviderSettings(
    <ProviderCreateForm
      {...props}
      allowedProviderTypes={[
        "openai-image",
        "gemini-native-image",
        "bfl-image",
        "ideogram-image",
        "openai-compatible",
      ]}
      initialProviderType="openai-image"
      triggerLabel="Add image provider"
    />,
    hostPlatform,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add image provider" }));
  return result;
}

describe("ProviderSettingsView", () => {
  it("collapses the create form from its available settings width", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.provider-settings\s*\{[^}]*container:\s*provider-settings\s*\/\s*inline-size;/,
    );
    expect(styles).toMatch(
      /@container provider-settings \(max-width: 640px\)\s*\{[^}]*\.provider-settings__create\s*\{[^}]*grid-template-columns:\s*1fr;/,
    );
  });

  it("lays out image-provider create fields over two columns instead of squeezing them into the shared row", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

    for (const type of [
      "openai-image",
      "gemini-native-image",
      "bfl-image",
      "ideogram-image",
    ] as const) {
      expect(styles).toMatch(
        new RegExp(
          `\\.provider-settings__create--${type}[\\s,][^}]*grid-template-columns:\\s*repeat\\(2, minmax\\(180px, 1fr\\)\\);`,
        ),
      );
      expect(styles).toMatch(
        new RegExp(
          `\\.provider-settings__create--${type} \\.settings-view__action[\\s,][^}]*grid-column:\\s*1 / -1;`,
        ),
      );
    }
  });

  it("adds no pane heading of its own and opens on the providers and their defaults before discovery", () => {
    renderProviderSettings(
      <ProviderSettingsView {...fixture()} discovery={<section aria-label="Find providers" />} />,
    );

    // The settings shell owns the pane's single visible title; the pane body
    // must not repeat a "Providers" heading of its own.
    expect(screen.queryByRole("heading", { name: "Providers" })).not.toBeInTheDocument();

    const discovery = screen.getByRole("region", { name: "Find providers" });
    const providers = screen.getByRole("region", { name: "Providers" });
    const defaults = screen.getByRole("region", { name: "Defaults" });
    expect(within(defaults).getByLabelText("Permission persistence")).toBeVisible();
    expect(
      providers.compareDocumentPosition(defaults) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      defaults.compareDocumentPosition(discovery) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("summarizes ready, setup-needed, and off providers before the list", () => {
    const ready = provider();
    const needsSetup = {
      ...provider(),
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000093"),
      displayName: "Needs setup",
    };
    const off = {
      ...provider(),
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000094"),
      displayName: "Off provider",
      enabled: false,
    };
    const props = fixture();
    renderProviderSettings(
      <ProviderSettingsView
        {...props}
        instances={[ready, needsSetup, off]}
        observedByInstance={
          new Map([
            [ready.id, observation({ instanceId: ready.id, readiness: "ready" })],
            [needsSetup.id, observation({ instanceId: needsSetup.id, readiness: "unavailable" })],
          ])
        }
      />,
    );

    expect(screen.getByRole("status", { name: "Provider readiness summary" })).toHaveTextContent(
      "1 ready · 1 needs setup · 1 off",
    );
    expect(screen.getByRole("region", { name: "Providers" })).toHaveClass(
      "settings-card-section--open",
    );
  });

  it("keeps dedicated image providers out of the general provider page", () => {
    renderProviderSettings(
      <ProviderSettingsView {...fixture({ instance: openAiImageProvider() })} />,
    );

    expect(screen.queryByRole("article", { name: "GPT Image" })).not.toBeInTheDocument();
  });

  it("keeps manual provider setup behind an advanced disclosure", async () => {
    const user = userEvent.setup();
    renderProviderSettings(<ProviderSettingsView {...fixture()} />);
    const disclosure = screen.getByRole("button", { name: "Add provider manually" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Provider type")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Display name for Existing CLI")).not.toBeInTheDocument();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Agent runtime" })).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "Provider type" }));
    // The list opens on the next frame; asking at once failed about half the runs.
    expect(await screen.findByRole("option", { name: "Codex CLI" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Qwen Code ACP" })).toBeInTheDocument();
    for (const elsewhere of [
      "OpenAI-compatible HTTP",
      "Anthropic-compatible HTTP",
      "Azure AI Foundry",
      "Ollama native HTTP",
      "OpenAI Image",
      "Gemini Image",
    ]) {
      expect(screen.queryByRole("option", { name: elsewhere })).not.toBeInTheDocument();
    }
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Details for Existing CLI" }));
    const configure = screen.getByRole("button", { name: "Configure Existing CLI" });
    expect(configure).toHaveAttribute("aria-controls");
    await user.click(configure);
    expect(screen.getByLabelText("Display name for Existing CLI")).toBeVisible();
  });

  it("uses presentation-only probe facts for row geometry when authority is empty", () => {
    const props = fixture();
    renderProviderSettings(
      <ProviderSettingsView
        {...props}
        presentationObservedByInstance={new Map([[id, observation()]])}
      />,
    );

    expect(screen.getByText("1 model")).toBeVisible();
    expect(screen.getByRole("region", { name: "Providers" })).toBeVisible();
  });

  it("omits provider metadata when the driver label is already the display name", () => {
    renderProviderSettings(<ProviderSettingsView {...fixture({ instance: cliNamedProvider() })} />);

    const row = screen.getByRole("article", { name: "Codex CLI" });
    expect(row.querySelector(".prov-observation > .prov-meta")).toBeNull();
  });

  it("keeps a stable feedback slot while provider status changes", () => {
    const props = fixture();
    const view = renderProviderSettings(<ProviderSettingsView {...props} />);
    const slot = document.querySelector(".provider-settings__message-slot");
    if (!(slot instanceof HTMLElement)) throw new Error("Expected provider feedback slot");

    view.rerender(<ProviderSettingsView {...props} message="Provider operation failed." />);

    expect(document.querySelector(".provider-settings__message-slot")).toBe(slot);
    expect(within(slot).getByRole("alert")).toHaveTextContent("Provider operation failed.");
  });

  it("keeps configured provider controls behind a compact details disclosure", async () => {
    const user = userEvent.setup();
    renderProviderSettings(<ProviderSettingsView {...fixture()} />);

    const disclosure = screen.getByRole("button", { name: "Details for Existing CLI" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "Check connection for Existing CLI" }),
    ).not.toBeInTheDocument();

    await user.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Check connection for Existing CLI" })).toBeVisible();
  });

  it("preserves an expanded model filter while provider discovery refreshes the registry", async () => {
    const user = userEvent.setup();
    const props = fixture({ observed: observation() });
    const view = renderProviderSettings(<ProviderSettingsView {...props} />);
    await user.click(screen.getByRole("button", { name: "Details for Existing CLI" }));
    const filter = screen.getByRole("textbox", { name: "Search models for Existing CLI" });
    await user.type(filter, "Model");

    view.rerender(<ProviderSettingsView {...props} status="loading" />);
    expect(screen.getByRole("textbox", { name: "Search models for Existing CLI" })).toBe(filter);
    expect(filter).toHaveValue("Model");
    expect(filter).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Check connection for Existing CLI" }),
    ).toBeDisabled();

    view.rerender(<ProviderSettingsView {...props} />);
    expect(filter).toHaveValue("Model");
    expect(filter).toHaveFocus();
    expect(screen.getByRole("button", { name: "Details for Existing CLI" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("creates, edits, toggles, probes, and removes through accessible controls", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);
    expect(screen.getByLabelText("Provider type")).toHaveTextContent("OpenCode CLI");
    await user.type(screen.getByLabelText("Provider name"), "OpenCode local");
    await user.type(screen.getByLabelText("OpenCode binary"), "/opt/homebrew/bin/opencode");
    await user.click(screen.getByRole("button", { name: "Add OpenCode" }));
    expect(props.onCreate).toHaveBeenCalledWith(
      "opencode",
      "OpenCode local",
      "/opt/homebrew/bin/opencode",
    );

    await user.clear(screen.getByLabelText("Display name for Existing CLI"));
    await user.type(screen.getByLabelText("Display name for Existing CLI"), "Renamed CLI");
    await user.click(screen.getByRole("button", { name: "Save name for Existing CLI" }));
    await user.clear(screen.getByLabelText("Binary path for Existing CLI"));
    await user.type(
      screen.getByLabelText("Binary path for Existing CLI"),
      "/usr/local/bin/opencode",
    );
    await user.click(screen.getByRole("button", { name: "Save binary path for Existing CLI" }));
    await user.click(screen.getByRole("switch", { name: "Enable Existing CLI" }));
    await user.click(screen.getByRole("button", { name: "Check connection for Existing CLI" }));
    await user.click(screen.getByRole("button", { name: "Remove Existing CLI" }));
    expect(props.onRename).toHaveBeenCalledWith(id, "Renamed CLI");
    expect(props.onChangeBinary).toHaveBeenCalledWith(id, "/usr/local/bin/opencode");
    expect(props.onSetEnabled).toHaveBeenCalledWith(id, false);
    expect(props.onProbe).toHaveBeenCalledWith(id);
    expect(props.onRemove).toHaveBeenCalledWith(id);
  });

  it("shows rename feedback only after a successful save", async () => {
    const user = userEvent.setup();
    const props = fixture({ onRename: vi.fn(async () => true) });
    renderExpanded(<ProviderSettingsView {...props} />);

    expect(screen.getByLabelText("Display name")).toHaveAttribute("name", "displayName");
    const input = screen.getByLabelText("Display name for Existing CLI");
    await user.clear(input);
    await user.type(input, "Renamed CLI");
    await user.click(screen.getByRole("button", { name: "Save name for Existing CLI" }));

    expect(props.onRename).toHaveBeenCalledOnce();
    const status = await screen.findByRole("status", { name: /rename status/i });
    expect(status).toHaveTextContent("Saved");

    fireEvent.change(input, { target: { value: "Changed again" } });
    expect(status).toHaveTextContent("");
  });

  it("leaves rename feedback empty when saving fails", async () => {
    const user = userEvent.setup();
    const props = fixture({ onRename: vi.fn(async () => false) });
    renderExpanded(<ProviderSettingsView {...props} />);

    await user.click(screen.getByRole("button", { name: "Save name for Existing CLI" }));

    expect(screen.getByRole("status", { name: /rename status/i })).toHaveTextContent("");
  });

  it("clears Saved when retrying a rename fails", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const props = fixture({ onRename });
    renderExpanded(<ProviderSettingsView {...props} />);

    const save = screen.getByRole("button", { name: "Save name for Existing CLI" });
    await user.click(save);
    const status = await screen.findByRole("status", { name: /rename status/i });
    expect(status).toHaveTextContent("Saved");

    await user.click(save);
    await waitFor(() => expect(status).toHaveTextContent(""));
  });

  it("creates Codex from the shared accessible provider form", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Codex CLI");
    await user.type(screen.getByLabelText("Provider name"), "Codex local");
    await user.type(screen.getByLabelText("Codex binary"), "/opt/homebrew/bin/codex");
    await user.click(screen.getByRole("button", { name: "Add Codex" }));

    expect(props.onCreate).toHaveBeenCalledWith("codex", "Codex local", "/opt/homebrew/bin/codex");
  });

  it("creates Kimi Code from the shared form without credential controls", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Kimi Code ACP");
    const form = screen.getByRole("form", { name: "Add Kimi Code provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Kimi local");
    await user.type(within(form).getByLabelText("Kimi Code binary"), "/opt/homebrew/bin/kimi");
    expect(
      within(form).queryByLabelText(/api key|credential|authentication/i),
    ).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Kimi Code" }));

    expect(props.onCreateAcpAgent).toHaveBeenCalledWith(
      "Kimi local",
      { kind: "kimi-code-acp", binaryPath: "/opt/homebrew/bin/kimi" },
      expect.objectContaining({ value: "" }),
    );
  });

  it("creates Devin from the shared form with provider-owned subscription authentication", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Devin ACP");
    const form = screen.getByRole("form", { name: "Add Devin provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Devin local");
    await user.type(within(form).getByLabelText("Devin binary"), "/Users/example/.local/bin/devin");
    expect(within(form).getByText(/devin auth login/i)).toBeVisible();
    expect(within(form).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Devin" }));

    expect(props.onCreateAcpAgent).toHaveBeenCalledWith(
      "Devin local",
      {
        kind: "devin-acp",
        binaryPath: "/Users/example/.local/bin/devin",
        authentication: "subscription",
      },
      expect.objectContaining({ value: "" }),
    );
  });

  it("creates Pi from the shared form with provider-owned authentication and no secret controls", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Pi RPC");
    const form = screen.getByRole("form", { name: "Add provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Pi local");
    await user.type(within(form).getByLabelText("Pi binary"), "/opt/homebrew/bin/pi");
    expect(within(form).getByText(/provider-owned authentication/i)).toBeVisible();
    expect(within(form).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Pi" }));

    expect(props.onCreate).toHaveBeenCalledWith("pi", "Pi local", "/opt/homebrew/bin/pi");
  });

  it("creates Oh My Pi from the shared form as distinct from Pi with no secret controls", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Oh My Pi");
    const form = screen.getByRole("form", { name: "Add provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Oh My Pi local");
    await user.type(within(form).getByLabelText("Oh My Pi binary"), "/Users/example/.bun/bin/omp");
    expect(within(form).getByText(/distinct from Pi/i)).toBeVisible();
    expect(within(form).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Oh My Pi" }));

    expect(props.onCreate).toHaveBeenCalledWith(
      "oh-my-pi",
      "Oh My Pi local",
      "/Users/example/.bun/bin/omp",
    );
  });

  it("creates Kilo from the shared form with provider-owned authentication and no secret controls", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Kilo ACP");
    const form = screen.getByRole("form", { name: "Add Kilo provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Kilo local");
    await user.type(within(form).getByLabelText("Kilo binary"), "/opt/homebrew/bin/kilo");
    expect(within(form).getByText(/kilo auth login/i)).toBeVisible();
    expect(within(form).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Kilo" }));

    expect(props.onCreateAcpAgent).toHaveBeenCalledWith(
      "Kilo local",
      { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
      expect.objectContaining({ value: "" }),
    );
  });

  it("creates and edits Ollama as a loopback-only native API without credentials or binary controls", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: ollamaProvider() });
    renderAdding(<ModelEndpointSettingsView {...props} />);

    await user.click(screen.getByRole("button", { name: /^Local \(Ollama\)/ }));
    const create = screen.getByRole("form", { name: "Connect Local (Ollama)" });
    await user.clear(within(create).getByLabelText("Name"));
    await user.type(within(create).getByLabelText("Name"), "Ollama local");
    expect(within(create).queryByLabelText(/binary|api key|credential/i)).not.toBeInTheDocument();
    expect(within(create).getByText(/doesn't install or start it/i)).toBeVisible();
    expect(within(create).getByLabelText("Ollama address")).toHaveValue("http://127.0.0.1:11434");
    await user.click(within(create).getByRole("button", { name: "Check and add" }));
    expect(props.onCreateOllama).toHaveBeenCalledWith("Ollama local", {
      kind: "ollama-native-http",
      baseUrl: "http://127.0.0.1:11434",
    });

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("link", { name: /^Ollama local,/ }));
    const card = screen.getByRole("region", { name: "Ollama local" });
    const endpoint = within(card).getByLabelText("Ollama API base for Ollama local");
    await user.clear(endpoint);
    await user.type(endpoint, "http://localhost:11434");
    await user.click(
      within(card).getByRole("button", { name: "Save Ollama settings for Ollama local" }),
    );
    expect(props.onChangeOllamaConfiguration).toHaveBeenCalledWith(id, {
      kind: "ollama-native-http",
      baseUrl: "http://localhost:11434",
    });
  });

  it("asks whether Ollama is running when nothing answers at its address, not about a binary", () => {
    const props = fixture({ instance: ollamaProvider() });
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...props}
        probeFailures={
          new Map([
            [
              id,
              {
                category: "unavailable",
                message: "The provider endpoint could not be reached.",
                failedAt: "2026-07-14T10:00:00.000Z",
              },
            ],
          ])
        }
      />,
    );
    const fix = screen.getByRole("group", { name: "Fix Ollama local" });
    expect(
      within(fix).getByText("Nothing answered at 127.0.0.1:11434. Is Ollama running?"),
    ).toBeVisible();
    expect(within(fix).getByRole("button", { name: "Try again for Ollama local" })).toBeVisible();
    expect(screen.queryByText(/binary path/i)).not.toBeInTheDocument();
  });

  it("creates Claude with explicit subscription or write-only API-key authentication", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    const create = screen.getByRole("form", { name: "Add Claude provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Claude local");
    await user.type(within(create).getByLabelText("Claude binary"), "/opt/homebrew/bin/claude");
    expect(within(create).getByLabelText("Claude authentication")).toHaveTextContent(
      "Claude subscription",
    );
    expect(within(create).queryByLabelText("Anthropic API key")).not.toBeInTheDocument();
    await user.click(within(create).getByRole("button", { name: "Add Claude" }));
    expect(props.onCreateClaude).toHaveBeenLastCalledWith(
      "Claude local",
      {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
      },
      expect.objectContaining({ value: "" }),
    );

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    await user.type(within(create).getByLabelText("Provider name"), "Claude key");
    await user.type(within(create).getByLabelText("Claude binary"), "/usr/local/bin/claude");
    await chooseSelectFieldOption(
      user,
      within(create).getByLabelText("Claude authentication"),
      "Anthropic API key",
    );
    const apiKey = within(create).getByLabelText("Anthropic API key");
    expect(apiKey).toHaveValue("");
    await user.type(apiKey, "private-value");
    await user.click(within(create).getByRole("button", { name: "Add Claude" }));
    const [, configuration, credential] = vi.mocked(props.onCreateClaude).mock.calls.at(-1)!;
    expect(configuration.authentication).toBe("api-key");
    expect(credential.value).toBe("private-value");
    credential.clear();
    expect(apiKey).toHaveValue("");
    expect(document.body.textContent).not.toContain("private-value");
  });

  it("creates a Claude account with a name and accent and no free-text directory field", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    const create = screen.getByRole("form", { name: "Add Claude provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Work Claude");
    await user.type(within(create).getByLabelText("Claude binary"), "/opt/homebrew/bin/claude");
    const directory = within(create).getByLabelText("Account directory");
    expect(directory).toHaveAttribute("readonly");
    expect(directory).toHaveValue("~/.claude-accounts/<assigned on create>");
    expect(within(create).queryByLabelText("Claude config directory")).toBeNull();
    await user.click(within(create).getByRole("radio", { name: "Teal" }));
    expect(within(create).queryByLabelText("Account sign-in command")).toBeNull();
    await user.click(within(create).getByRole("button", { name: "Add Claude" }));
    expect(props.onCreateClaude).toHaveBeenLastCalledWith(
      "Work Claude",
      {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
        accent: "teal",
      },
      expect.objectContaining({ value: "" }),
    );
  });

  it("clears the Claude create fields after a successful add so the next account starts blank", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    const create = screen.getByRole("form", { name: "Add Claude provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Work Claude");
    await user.type(within(create).getByLabelText("Claude binary"), "/opt/homebrew/bin/claude");
    await user.click(within(create).getByRole("radio", { name: "Teal" }));
    await user.click(within(create).getByRole("button", { name: "Add Claude" }));
    await waitFor(() => {
      expect(within(create).getByLabelText("Claude binary")).toHaveValue("");
    });
    expect(within(create).getByLabelText("Account directory")).toHaveValue(
      "~/.claude-accounts/<assigned on create>",
    );
    expect(within(create).queryByLabelText("Account sign-in command")).toBeNull();
  });

  it("shows a read-only account directory and no free-text directory when adding another Claude account", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    const create = screen.getByRole("form", { name: "Add Claude provider" });
    const directory = within(create).getByLabelText("Account directory");
    expect(directory).toHaveAttribute("readonly");
    expect(directory).toHaveValue("~/.claude-accounts/<assigned on create>");
    expect(within(create).queryByLabelText("Claude config directory")).toBeNull();
    expect(within(create).queryByLabelText("Account sign-in command")).toBeNull();
    await user.type(within(create).getByLabelText("Claude binary"), "/usr/local/bin/claude");
    expect(within(create).queryByLabelText("Account sign-in command")).toBeNull();
  });

  it("adds another Claude account from the Claude card with the form ready to name it", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    renderProviderSettings(<ProviderSettingsView {...props} />);

    expect(screen.queryByLabelText("Provider type")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details for Claude local" }));
    await user.click(screen.getByRole("button", { name: "Add account for Claude local" }));

    const create = screen.getByRole("form", { name: "Add Claude provider" });
    expect(within(create).getByRole("combobox", { name: "Provider type" })).toHaveTextContent(
      "Claude Agent SDK",
    );
    const name = within(create).getByLabelText("Provider name");
    expect(name).toHaveValue("Claude local (2)");
    expect(name).toHaveFocus();
    expect(within(create).getByLabelText("Claude binary")).toHaveValue("/opt/homebrew/bin/claude");
    expect(within(create).getByLabelText("Account directory")).toHaveValue(
      "~/.claude-accounts/<assigned on create>",
    );

    await user.click(within(create).getByRole("button", { name: "Add Claude" }));
    expect(props.onCreateClaude).toHaveBeenLastCalledWith(
      "Claude local (2)",
      {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
      },
      expect.objectContaining({ value: "" }),
    );
    // The new account exists, so the suggested name is not offered a second time.
    await waitFor(() => {
      expect(screen.queryByRole("form", { name: "Add Claude provider" })).not.toBeInTheDocument();
    });
  });

  it("adds another Codex account from the Codex card through the same form", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: codexProvider() });
    renderProviderSettings(<ProviderSettingsView {...props} />);

    await user.click(screen.getByRole("button", { name: "Details for Codex local" }));
    await user.click(screen.getByRole("button", { name: "Add account for Codex local" }));

    const create = screen.getByRole("form", { name: "Add provider" });
    expect(within(create).getByRole("combobox", { name: "Provider type" })).toHaveTextContent(
      "Codex CLI",
    );
    expect(within(create).getByLabelText("Provider name")).toHaveValue("Codex local (2)");
    expect(within(create).getByLabelText("Codex binary")).toHaveValue("/opt/homebrew/bin/codex");

    await user.click(within(create).getByRole("button", { name: "Add Codex" }));
    expect(props.onCreate).toHaveBeenCalledWith(
      "codex",
      "Codex local (2)",
      "/opt/homebrew/bin/codex",
    );
  });

  it("suggests the next free number when a second account already exists", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    const second = decodeProviderInstance({
      ...claudeProvider(),
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000093"),
      displayName: "Claude local (2)",
    });
    renderProviderSettings(
      <ProviderSettingsView {...props} instances={[...props.instances, second]} />,
    );

    await user.click(screen.getByRole("button", { name: "Details for Claude local" }));
    await user.click(screen.getByRole("button", { name: "Add account for Claude local" }));

    expect(screen.getByLabelText("Provider name")).toHaveValue("Claude local (3)");
  });

  it("keeps a number the person put in a card's name instead of reading it as an account sequence", async () => {
    const user = userEvent.setup();
    const research = decodeProviderInstance({
      ...claudeProvider(),
      displayName: "Claude Research (2024)",
    });
    renderProviderSettings(<ProviderSettingsView {...fixture({ instance: research })} />);

    await user.click(screen.getByRole("button", { name: "Details for Claude Research (2024)" }));
    await user.click(
      screen.getByRole("button", { name: "Add account for Claude Research (2024)" }),
    );

    expect(screen.getByLabelText("Provider name")).toHaveValue("Claude Research (2024) (2)");
  });

  it("continues the sequence from a numbered account when its unnumbered sibling exists", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    const numbered = decodeProviderInstance({
      ...claudeProvider(),
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000093"),
      displayName: "Claude local (2)",
    });
    renderProviderSettings(
      <ProviderSettingsView {...props} instances={[...props.instances, numbered]} />,
    );

    await user.click(screen.getByRole("button", { name: "Details for Claude local (2)" }));
    await user.click(screen.getByRole("button", { name: "Add account for Claude local (2)" }));

    expect(screen.getByLabelText("Provider name")).toHaveValue("Claude local (3)");
  });

  it("offers Add account on Claude and Codex cards only", async () => {
    const user = userEvent.setup();
    renderProviderSettings(<ProviderSettingsView {...fixture()} />);

    await user.click(screen.getByRole("button", { name: "Details for Existing CLI" }));
    expect(screen.getByRole("button", { name: "Check connection for Existing CLI" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Add account/ })).not.toBeInTheDocument();
  });

  it("hides the Claude sign-in command until the binary path is absolute", async () => {
    const user = userEvent.setup();
    renderExpanded(<ProviderSettingsView {...fixture()} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    const create = screen.getByRole("form", { name: "Add Claude provider" });
    expect(within(create).queryByLabelText("Account sign-in command")).toBeNull();
    await user.type(within(create).getByLabelText("Claude binary"), "claude");
    expect(within(create).queryByLabelText("Account sign-in command")).toBeNull();
    await user.clear(within(create).getByLabelText("Claude binary"));
    await user.type(within(create).getByLabelText("Claude binary"), "/opt/homebrew/bin/claude");
    expect(within(create).getByLabelText("Account sign-in command")).toHaveValue(
      "'/opt/homebrew/bin/claude' auth login",
    );
  });

  it("creates Mistral Vibe with API-key authentication only", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: vibeProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Mistral Vibe ACP");
    const create = screen.getByRole("form", { name: "Add Mistral Vibe provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Mistral Vibe local");
    await user.type(
      within(create).getByLabelText("Mistral Vibe binary"),
      "/Users/example/.local/bin/vibe-acp",
    );
    expect(within(create).getByLabelText("Mistral Vibe binary")).toHaveAttribute(
      "placeholder",
      "/absolute/path/to/vibe-acp",
    );
    expect(within(create).queryByLabelText("Mistral Vibe authentication")).not.toBeInTheDocument();
    await user.type(within(create).getByLabelText("Mistral API key"), "mistral-key");
    await user.click(within(create).getByRole("button", { name: "Add Mistral Vibe" }));
    expect(props.onCreateAcpAgent).toHaveBeenCalledWith(
      "Mistral Vibe local",
      {
        kind: "mistral-vibe-acp",
        binaryPath: "/Users/example/.local/bin/vibe-acp",
        authentication: "api-key",
      },
      expect.objectContaining({ value: "mistral-key" }),
    );
    expect(screen.getAllByText(/uses a Mistral API key/i)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /browser sign-in/i })).not.toBeInTheDocument();
  });

  it("associates Mistral Vibe SettingRow labels with their controls", () => {
    renderExpanded(<ProviderSettingsView {...fixture({ instance: vibeProvider() })} />);

    const card = screen.getByRole("article", { name: "Mistral Vibe local" });
    expect(within(card).getByLabelText("vibe-acp binary path")).toBeInTheDocument();
    expect(
      within(card).getByLabelText("Mistral API key (leave blank to preserve)"),
    ).toBeInTheDocument();
  });

  it.each([
    {
      label: "GLM Agent",
      typeLabel: "GLM Agent ACP",
      formName: "Add GLM Agent provider",
      submitName: "Add GLM Agent",
      binaryLabel: "GLM Agent binary",
      binaryPath: "/Users/example/.local/bin/glm-acp-agent",
      displayName: "GLM local",
      kind: "glm-acp",
    },
    {
      label: "Gemini CLI",
      typeLabel: "Gemini CLI ACP",
      formName: "Add Gemini CLI provider",
      submitName: "Add Gemini CLI",
      binaryLabel: "Gemini CLI binary",
      binaryPath: "/Users/example/.local/bin/gemini",
      displayName: "Gemini local",
      kind: "gemini-acp",
    },
    {
      label: "Cline",
      typeLabel: "Cline ACP",
      formName: "Add Cline provider",
      submitName: "Add Cline",
      binaryLabel: "Cline binary",
      binaryPath: "/Users/example/.local/bin/cline",
      displayName: "Cline local",
      kind: "cline-acp",
    },
    {
      label: "Qwen Code",
      typeLabel: "Qwen Code ACP",
      formName: "Add Qwen Code provider",
      submitName: "Add Qwen Code",
      binaryLabel: "Qwen Code binary",
      binaryPath: "/Users/example/.local/bin/qwen",
      displayName: "Qwen local",
      kind: "qwen-acp",
    },
  ] as const)(
    "creates $label with provider-owned authentication and no API key",
    async ({
      label,
      typeLabel,
      formName,
      submitName,
      binaryLabel,
      binaryPath,
      displayName,
      kind,
    }) => {
      const user = userEvent.setup();
      const props = fixture();
      renderExpanded(<ProviderSettingsView {...props} />);

      await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), typeLabel);
      const createForm = screen.getByRole("form", { name: formName });
      await user.type(within(createForm).getByLabelText("Provider name"), displayName);
      await user.type(within(createForm).getByLabelText(binaryLabel), binaryPath);
      expect(within(createForm).getByLabelText(`${label} authentication`)).toHaveTextContent(
        "Provider CLI login (recommended)",
      );
      expect(within(createForm).queryByLabelText(/API key/i)).not.toBeInTheDocument();
      await user.click(within(createForm).getByRole("button", { name: submitName }));

      expect(props.onCreateAcpAgent).toHaveBeenCalledWith(
        displayName,
        {
          kind,
          binaryPath,
          authentication: "provider-owned",
        },
        expect.objectContaining({ value: "" }),
      );
    },
  );

  it("creates a browser Claude API-key profile while keeping secret entry disabled", async () => {
    const user = userEvent.setup();
    const props = fixture({ credentialManagementAvailable: false });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    const create = screen.getByRole("form", { name: "Add Claude provider" });
    const submit = within(create).getByRole("button", { name: "Add Claude" });
    expect(submit).toBeEnabled();

    await chooseSelectFieldOption(
      user,
      within(create).getByLabelText("Claude authentication"),
      "Anthropic API key",
    );

    expect(within(create).getByLabelText("Anthropic API key")).toBeDisabled();
    expect(submit).toBeEnabled();
    expect(within(create).getByText(/On macOS, open this profile in Octant desktop/)).toBeVisible();
    await user.type(within(create).getByLabelText("Provider name"), "Claude API");
    await user.type(within(create).getByLabelText("Claude binary"), "/usr/local/bin/claude");
    await user.click(submit);
    expect(props.onCreateClaude).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ authentication: "api-key" }),
      expect.objectContaining({ value: "" }),
    );
  });

  it.each(["success", "failure"] as const)(
    "clears the real controller-backed Claude key input after host storage %s",
    async (outcome) => {
      const user = userEvent.setup();
      const addProviderApiKey = vi.fn(async () => {
        if (outcome === "failure") throw new Error("private-value raw Keychain diagnostic");
        return { id: "7d444840-9dc0-11d1-b245-5ffdce74fad2", label: "Key 1", active: true };
      });
      const host = controllerHost(addProviderApiKey);
      const client = controllerClient();
      render(<ControllerBackedProviderSettings client={client} host={host} />);
      await user.click(await screen.findByRole("button", { name: "Add provider manually" }));
      await screen.findByLabelText("Provider type");

      await chooseSelectFieldOption(
        user,
        screen.getByLabelText("Provider type"),
        "Claude Agent SDK",
      );
      const create = screen.getByRole("form", { name: "Add Claude provider" });
      await user.type(within(create).getByLabelText("Provider name"), "Claude key");
      await user.type(within(create).getByLabelText("Claude binary"), "/usr/local/bin/claude");
      await chooseSelectFieldOption(
        user,
        within(create).getByLabelText("Claude authentication"),
        "Anthropic API key",
      );
      const apiKey = within(create).getByLabelText("Anthropic API key");
      await user.type(apiKey, "private-value");
      await user.click(within(create).getByRole("button", { name: "Add Claude" }));

      await waitFor(() => expect(apiKey).toHaveValue(""));
      expect(addProviderApiKey).toHaveBeenCalledWith(expect.any(String), "private-value");
      expect(document.body.textContent).not.toContain("private-value");
      if (outcome === "failure") {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "The provider was created, but its credential could not be stored.",
        );
      }
    },
  );

  it("renders Codex identity, provider-native login guidance, and bounded authority copy", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: codexProvider(),
          observed: observation({ readiness: "unauthenticated" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Codex local" });
    expect(within(card).getByText("Codex CLI")).toBeVisible();
    expect(within(card).getByText(/codex login/i)).toBeVisible();
    expect(within(card).getByLabelText("Account directory")).toHaveValue("~/.codex");
    expect(within(card).getByText(/Remember for this Project/)).toHaveTextContent(/one-shot/i);
    expect(within(card).getByText(/Remember for this Project/)).toHaveTextContent(
      /Current session only/i,
    );
    expect(card.textContent).not.toMatch(/account identity|config\.toml|access token/i);
  });

  it("renders Kimi Code identity, provider-native login guidance, and no credential surface", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: kimiProvider(),
          observed: observation({ readiness: "unauthenticated" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Kimi local" });
    expect(within(card).getByText("Kimi Code ACP")).toBeVisible();
    expect(within(card).getByText(/kimi login/i)).toHaveTextContent(/in your terminal/i);
    expect(within(card).getByLabelText("kimi binary path for Kimi local")).toHaveValue(
      "/opt/homebrew/bin/kimi",
    );
    expect(
      within(card).queryByLabelText(/api key|credential|authentication/i),
    ).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /log in|oauth/i })).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/account identity|oauth token|KIMI_CODE_HOME|transcript/i);
  });

  it("offers Update CLI only for providers with a verified updater and shows a scoped Updating state", async () => {
    const user = userEvent.setup();
    const onUpdateProviderCli = vi.fn(async () => true);
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: kimiProvider(),
          observed: observation({ readiness: "ready", detectedVersion: "0.26.0" }),
        })}
        onUpdateProviderCli={onUpdateProviderCli}
      />,
    );

    const update = screen.getByRole("button", { name: "Update CLI for Kimi local" });
    expect(update).toHaveTextContent("Update CLI");
    await user.click(
      within(screen.getByRole("article", { name: "Kimi local" })).getByRole("button", {
        name: "Connection details",
      }),
    );
    expect(
      screen.getByText("CLI updates: Provider-owned update available on this host"),
    ).toBeVisible();
    await user.click(update);
    expect(onUpdateProviderCli).toHaveBeenCalledWith(id);
    expect(screen.queryByText(/login profile was preserved/i)).not.toBeInTheDocument();
  });

  it("replaces a ready badge with a scoped Updating state during a CLI update", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: kimiProvider(),
          observed: observation({ readiness: "ready" }),
        })}
        updatingIds={new Set([id])}
        onUpdateProviderCli={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText("Updating")).toBeVisible();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update CLI for Kimi local" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Provider readiness summary" })).toHaveTextContent(
      /0 ready/,
    );
  });

  it("names the CLI update once, for a provider whose own name already ends in CLI", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: cliNamedProvider() })}
        onUpdateProviderCli={vi.fn(async () => true)}
      />,
    );

    const update = screen.getByRole("button", { name: "Update CLI for Codex CLI" });
    expect(update).toHaveTextContent("Update CLI");
  });

  it("does not offer Update CLI for providers without a verified updater", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: piProvider() })}
        onUpdateProviderCli={vi.fn(async () => true)}
      />,
    );
    expect(screen.queryByRole("button", { name: /Update .* CLI/ })).not.toBeInTheDocument();
    expect(
      screen.getByText("CLI updates: Manual installation required on this host"),
    ).toBeVisible();
  });

  it("suggests Update CLI for an unavailable provider only when the action is offered", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: piProvider(),
          observed: observation({ readiness: "unavailable" }),
        })}
        onUpdateProviderCli={vi.fn(async () => true)}
      />,
    );
    expect(screen.queryByText(/Update CLI/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Verify the binary path and that .* can start, then check/),
    ).toBeVisible();
  });

  it("offers Check connection with failed-auth guidance without opening Details first", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: kimiProvider(),
          observed: observation({ readiness: "unauthenticated" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Kimi local" });
    expect(within(card).getByText(/kimi login/i)).toBeVisible();
    const check = within(card).getByRole("button", { name: "Check connection for Kimi local" });
    expect(check).toBeVisible();
    expect(check).toBeEnabled();
    expect(screen.getByRole("button", { name: "Details for Kimi local" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("renders Devin identity, provider-owned login guidance, and no secret surface", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: devinProvider(),
          observed: observation({ readiness: "unauthenticated" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Devin local" });
    expect(within(card).getByText("Devin ACP")).toBeVisible();
    expect(within(card).getByText(/devin auth login/i)).toBeVisible();
    expect(within(card).getByLabelText("devin binary path for Devin local")).toHaveValue(
      "/Users/example/.local/bin/devin",
    );
    expect(within(card).getByText(/Devin subscription/i)).toBeVisible();
    expect(within(card).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/account|team|oauth token|credentials\.toml|raw acp/i);
  });

  it("shows bounded process diagnostics for a failed Devin connection check", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: devinProvider(),
          observed: observation({
            readiness: "unavailable",
            detectedVersion: "3000.10.27",
            message: "Provider process rejected its configured arguments.",
            diagnostic: {
              stage: "initialization",
              kind: "exited",
              exitCode: 2,
              stderrContext: "Provider process rejected its configured arguments.",
            },
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Devin local" });
    expect(within(card).getByText("Failure stage: Initialization")).toBeVisible();
    expect(within(card).getByText("Process result: Exited with code 2")).toBeVisible();
    expect(
      within(card).getByText(
        "Safe stderr context: Provider process rejected its configured arguments.",
      ),
    ).toBeVisible();
  });

  it("renders Pi RPC identity, provider-owned authentication guidance, and strict configuration", async () => {
    const user = userEvent.setup();
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: piProvider(), observed: observation({ readiness: "ready" }) })}
      />,
    );

    const card = screen.getByRole("article", { name: "Pi local" });
    expect(within(card).getByText("Pi RPC")).toBeVisible();
    await user.click(within(card).getByRole("button", { name: "Connection details" }));
    expect(within(card).getByText(/provider-owned/i)).toBeVisible();
    expect(within(card).getByLabelText("Binary path for Pi local")).toHaveValue(
      "/opt/homebrew/bin/pi",
    );
    expect(within(card).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/auth\.json|oauth token|raw rpc/i);
  });

  it("renders Oh My Pi identity as distinct from Pi with pinned version and no secrets", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: ohMyPiProvider(),
          observed: observation({
            readiness: "unavailable",
            message: "Oh My Pi reported 1 model, but Octant cannot start turns on it yet.",
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Oh My Pi local" });
    expect(within(card).getByText("Oh My Pi RPC")).toBeVisible();
    expect(card.querySelector(".prov-state")).toHaveTextContent("Unavailable");
    expect(within(card).getByText(/cannot start turns on it yet/i)).toBeVisible();
    expect(card.textContent).not.toMatch(/verify the binary path/i);
    expect(within(card).getByRole("button", { name: "Connection details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(card).getByText(/provider-owned Oh My Pi credentials/i)).toBeVisible();
    expect(within(card).getByText(/Supported version: 17.2.1/)).toBeVisible();
    expect(within(card).getByLabelText("Binary path for Oh My Pi local")).toHaveValue(
      "/Users/example/.bun/bin/omp",
    );
    expect(within(card).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/auth\.json|oauth token|raw rpc/i);
  });

  it("renders Kilo ACP identity, provider-owned login guidance, and strict configuration", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: kiloProvider(),
          observed: observation({ readiness: "unauthenticated" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Kilo local" });
    expect(within(card).getByText("Kilo ACP")).toBeVisible();
    expect(within(card).getByText(/kilo auth login/i)).toBeVisible();
    expect(within(card).getByLabelText("kilo binary path for Kilo local")).toHaveValue(
      "/opt/homebrew/bin/kilo",
    );
    expect(within(card).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/auth\.json|oauth token|plugin|skill|raw acp/i);
  });

  it("explains the fail-closed Kimi runtime and provider-owned profile boundary", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: kimiProvider(),
          observed: observation({ readiness: "incompatible" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Kimi local" });
    expect(within(card).getByText(/provider-owned profile/i)).toHaveTextContent(/incompatible/i);
    expect(within(card).queryByText(/update your Kimi Code installation/i)).not.toBeInTheDocument();
  });

  it("surfaces Claude incompatibility facts from the host observation", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider(),
          observed: observation({
            readiness: "incompatible",
            processState: "stopped",
            detectedVersion: "2.1.211",
            models: [],
            message: "Claude initialization version did not match the configured binary.",
            capabilities: {
              streaming: "unavailable",
              resume: "unavailable",
              interruption: "unavailable",
              approvals: "unavailable",
              userQuestions: "unavailable",
              reasoning: "unavailable",
              usage: "unavailable",
              toolActivity: "unavailable",
              fileChanges: "unavailable",
              diffs: "unavailable",
              taskProgress: "unavailable",
              nativeChildAgents: "unavailable",
              harnessAutoReview: "unsupported",
              nativeAttachments: "unavailable",
              nativeWebResearch: "unavailable",
              appManagedTools: "unavailable",
              citations: "unavailable",
            },
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Claude local" });
    const details = within(card).getByLabelText("Incompatibility details");
    expect(within(card).getByText(/Claude runtime is incompatible/i)).toBeVisible();
    expect(
      within(details).getByText(
        "Host check: Claude initialization version did not match the configured binary.",
      ),
    ).toBeVisible();
    expect(within(details).getByText("Binary: /opt/homebrew/bin/claude")).toBeVisible();
    expect(within(details).getByText("Version: 2.1.211")).toBeVisible();
    expect(within(details).getByText("Authentication: Claude subscription")).toBeVisible();
    expect(within(details).getByText("Capabilities: Not confirmed")).toBeVisible();
  });

  it("renders Claude provider-native guidance, auth configuration, and one-shot authority copy", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider(),
          observed: observation({ readiness: "unauthenticated" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Claude local" });
    expect(within(card).getByText("Claude Agent SDK")).toBeVisible();
    expect(within(card).getAllByText(/official Claude Code/i)).toHaveLength(2);
    expect(within(card).getByText(/Remember for this Project/)).toHaveTextContent(/one-shot/i);
    expect(within(card).getByLabelText("Claude authentication for Claude local")).toHaveTextContent(
      "Claude subscription",
    );
    expect(within(card).getByLabelText("Account directory")).toHaveAttribute("readonly");
    expect(within(card).getByLabelText("Account directory")).toHaveValue("~/.claude");
    expect(within(card).getByLabelText("Account sign-in command")).toHaveValue(
      "'/opt/homebrew/bin/claude' auth login",
    );
    expect(
      within(card).queryByLabelText("Anthropic API key for Claude local"),
    ).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /log in|oauth/i })).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/account identity|oauth token|api key value|transcript/i);
  });

  it("shows write-only Keychain repair guidance for unauthenticated Claude API-key providers", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider("api-key"),
          observed: observation({ readiness: "unauthenticated", credentialStatus: "missing" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Claude local" });
    expect(within(card).getByText(/replace.*Anthropic API key/i)).toHaveTextContent(/write-only/i);
    expect(within(card).getByText(/replace.*Anthropic API key/i)).toHaveTextContent(/Keychain/i);
    expect(card.textContent).not.toMatch(/official Claude Code|Claude subscription login/i);
  });

  it("keeps host-local key setup available on an existing browser Claude profile", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider("api-key"),
          credentialManagementAvailable: false,
          observed: observation({ readiness: "unauthenticated", credentialStatus: "missing" }),
        })}
      />,
    );
    const card = screen.getByRole("article", { name: "Claude local" });
    expect(within(card).getByText(/On macOS, open this profile in Octant desktop/)).toBeVisible();
    expect(within(card).queryByText(/Manage API keys in the Octant host app/)).toBeNull();
    expect(within(card).getByLabelText("Anthropic API key for Claude local")).toBeDisabled();
  });

  it("keeps runtime incompatibility details beside browser Claude key setup", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider("api-key"),
          credentialManagementAvailable: false,
          observed: observation({ readiness: "incompatible", credentialStatus: "stored" }),
        })}
      />,
    );
    const card = screen.getByRole("article", { name: "Claude local" });
    expect(within(card).getByText(/On macOS, open this profile in Octant desktop/)).toBeVisible();
    expect(within(card).getByLabelText("Incompatibility details")).toBeVisible();
  });

  it("updates the Claude sign-in command while the binary path is being edited", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: decodeProviderInstance({
        ...claudeProvider(),
        displayName: "Claude work",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
          configDirectory: "/Users/example/.claude-accounts/work",
        },
      }),
    });
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Claude work" });
    const binary = within(card).getByLabelText("Claude binary for Claude work");
    await user.clear(binary);
    await user.type(binary, "/usr/local/bin/claude");
    expect(within(card).getByLabelText("Account sign-in command")).toHaveValue(
      "CLAUDE_CONFIG_DIR='/Users/example/.claude-accounts/work' CLAUDE_SECURESTORAGE_CONFIG_DIR='/Users/example/.claude-accounts/work' '/usr/local/bin/claude' auth login",
    );
  });

  it("shows a leftover custom directory as read-only and never offers a free-text directory field", async () => {
    const props = fixture({
      instance: decodeProviderInstance({
        ...claudeProvider(),
        displayName: "Claude work",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
          configDirectory: "/Users/example/.claude-accounts/work",
          accent: "teal",
        },
      }),
    });
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Claude work" });
    const directory = within(card).getByLabelText("Account directory");
    expect(directory).toHaveAttribute("readonly");
    expect(directory).toHaveValue("/Users/example/.claude-accounts/work");
    expect(within(card).queryByLabelText("Claude config directory")).toBeNull();
    expect(within(card).getByLabelText("Account sign-in command")).toHaveValue(
      "CLAUDE_CONFIG_DIR='/Users/example/.claude-accounts/work' CLAUDE_SECURESTORAGE_CONFIG_DIR='/Users/example/.claude-accounts/work' '/opt/homebrew/bin/claude' auth login",
    );
    expect(within(card).queryByRole("button", { name: /Connect Claude for helpers/ })).toBeNull();
    expect(
      within(card).getByRole("button", { name: "Use Octant's assigned directory" }),
    ).toBeVisible();
  });

  it("shows a read-only default account directory and the unmodified sign-in command", async () => {
    const props = fixture({ instance: claudeProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Claude local" });
    const directory = within(card).getByLabelText("Account directory");
    expect(directory).toHaveAttribute("readonly");
    expect(directory).toHaveValue("~/.claude");
    expect(within(card).queryByLabelText("Claude config directory")).toBeNull();
    expect(within(card).getByLabelText("Account sign-in command")).toHaveValue(
      "'/opt/homebrew/bin/claude' auth login",
    );
    expect(within(card).queryByRole("button", { name: /Connect Claude for helpers/ })).toBeNull();
  });

  it("offers no sign-in command for an extra account that has no stored directory", () => {
    const owner = claudeProvider();
    const extra = decodeProviderInstance({
      ...owner,
      id: "80000000-0000-4000-8000-0000000000aa",
      displayName: "Claude work",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    });
    renderExpanded(
      <ProviderSettingsView {...fixture({ instance: owner })} instances={[owner, extra]} />,
    );
    const card = screen.getByRole("article", { name: "Claude work" });
    // Claude keys a login on the exact directory string, so a path Octant only
    // displays must never be offered as a command to run.
    expect(within(card).getByLabelText("Account directory")).toHaveValue(
      `~/.claude-accounts/${extra.id}`,
    );
    expect(within(card).queryByLabelText("Account sign-in command")).toBeNull();
    expect(within(card).queryByLabelText("Account status command")).toBeNull();
  });

  it("edits Claude authentication with a write-only key and constrains remote key management", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: claudeProvider() });
    const { rerender } = renderExpanded(<ProviderSettingsView {...props} />);
    let card = screen.getByRole("article", { name: "Claude local" });

    await chooseSelectFieldOption(
      user,
      within(card).getByLabelText("Claude authentication for Claude local"),
      "Anthropic API key",
    );
    const apiKey = within(card).getByLabelText("Anthropic API key for Claude local");
    await user.type(apiKey, "private-value");
    await user.click(
      within(card).getByRole("button", { name: "Save Claude settings for Claude local" }),
    );

    const [, configuration, credential] = vi
      .mocked(props.onChangeClaudeConfiguration)
      .mock.calls.at(-1)!;
    expect(configuration).toMatchObject({
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "api-key",
    });
    expect(credential.value).toBe("private-value");
    credential.clear();
    expect(apiKey).toHaveValue("");
    expect(document.body.textContent).not.toContain("private-value");

    rerender(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider("api-key"),
          credentialManagementAvailable: false,
        })}
      />,
    );
    card = screen.getByRole("article", { name: "Claude local" });
    expect(within(card).getByLabelText("Anthropic API key for Claude local")).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Remove Claude local" })).toBeDisabled();
    expect(within(card).getByText(/On macOS, open this profile in Octant desktop/)).toBeVisible();
  });

  it("shows semantic provider state and never renders runtime secrets or addresses", async () => {
    const user = userEvent.setup();
    renderExpanded(<ProviderSettingsView {...fixture({ observed: observation() })} />);
    const card = screen.getByRole("article", { name: "Existing CLI" });
    expect(within(card).getByText("Ready")).toBeVisible();
    expect(within(card).queryByText(/Process: Running/)).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Connection details" }));
    expect(within(card).getByText(/Process: Running/)).toBeVisible();
    expect(within(card).getByText("Model One")).toBeVisible();
    expect(within(card).getAllByText("Supported").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("Unsupported").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/password|authorization|127\.0\.0\.1:\d+/i);
  });

  it("keeps routine diagnostics collapsed while model visibility stays one expansion away", async () => {
    const user = userEvent.setup();
    renderProviderSettings(<ProviderSettingsView {...fixture({ observed: observation() })} />);
    const card = screen.getByRole("article", { name: "Existing CLI" });

    expect(within(card).queryByText(/Process: Running/)).not.toBeInTheDocument();
    expect(
      within(card).queryByRole("textbox", { name: "Search models for Existing CLI" }),
    ).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Details for Existing CLI" }));
    expect(within(card).queryByText(/Process: Running/)).not.toBeInTheDocument();
    expect(
      within(card).getByRole("textbox", { name: "Search models for Existing CLI" }),
    ).toBeVisible();

    const search = within(card).getByRole("textbox", { name: "Search models for Existing CLI" });
    const details = within(card).getByRole("button", { name: "Connection details" });
    expect(search.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    await user.click(within(card).getByRole("button", { name: "Connection details" }));
    expect(within(card).getByText(/Process: Running/)).toBeVisible();
  });

  it("renders OpenAI-compatible providers as read-only HTTP summaries", async () => {
    renderExpanded(<ModelEndpointSettingsView {...fixture({ instance: httpProvider() })} />);
    const page = screen.getByRole("region", { name: "Private gateway" });
    const diagnostics = within(page).getByRole("region", { name: "Diagnostics" });

    // The precise terms live under Diagnostics, folded away while the endpoint works.
    expect(diagnostics.querySelector("details")).not.toHaveAttribute("open");
    expect(within(diagnostics).getByText("https://gateway.example/v1/")).toBeInTheDocument();
    expect(within(diagnostics).getByText("OpenAI-compatible")).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Set to Automatic · no turn has used it yet"),
    ).toBeInTheDocument();
    expect(within(diagnostics).getByText("API key (bearer)")).toBeInTheDocument();
    expect(within(page).queryByLabelText(/Binary path/)).not.toBeInTheDocument();
  });

  it.each([
    ["OpenAI-compatible", httpProvider(), /^API base URL for /],
    ["Anthropic-compatible", anthropicProvider(), /^API base URL for /],
    ["Azure AI Foundry", foundryProvider(), /^Foundry OpenAI v1 base URL for /],
  ] as const)(
    "says a new address removes the stored key of an %s endpoint, then shows it needs the key",
    async (_label, instance, addressName) => {
      const user = userEvent.setup();
      const props = fixture({ instance });
      const { rerender } = renderExpanded(<ModelEndpointSettingsView {...props} />);
      const page = screen.getByRole("region", { name: instance.displayName });
      const address = within(page).getByRole("textbox", { name: addressName });
      const note = /removes this endpoint's stored API key/;

      // Only a changed address says so; the saved one reads as before.
      expect(within(page).queryByText(note)).toBeNull();
      await user.type(address, "x");
      expect(within(page).getByText(note)).toBeVisible();
      expect(address).toHaveAccessibleDescription(note);
      await user.type(address, "{Backspace}");
      expect(within(page).queryByText(note)).toBeNull();

      // The trailing slash is spelling only: the host keeps the key for it.
      await user.type(address, "{Backspace}");
      expect(within(page).queryByText(note)).toBeNull();
      await user.type(address, "/");

      await user.clear(address);
      await user.type(address, "http://127.0.0.1:9/v1/");
      expect(within(page).getByText(note)).toBeVisible();
      const save = within(page).getAllByRole("button", { name: /^Save .* settings for / })[0]!;
      await user.click(save);
      const change = (
        instance.driverKind === "anthropic-compatible"
          ? props.onChangeAnthropicCompatibleConfiguration
          : instance.driverKind === "azure-foundry"
            ? props.onChangeAzureFoundryConfiguration
            : props.onChangeOpenAiCompatibleConfiguration
      ) as ReturnType<typeof vi.fn>;
      await waitFor(() => expect(change).toHaveBeenCalledOnce());

      // The host saved the address and deleted the key with it; nothing has
      // been checked since, so the row says what is needed rather than "Not checked yet".
      vi.mocked(props.onProviderCredentialStatus).mockResolvedValue("missing");
      const saved = [
        {
          ...instance,
          configuration: { ...instance.configuration, baseUrl: "http://127.0.0.1:9/v1/" },
          version: 2 as never,
        } as ProviderInstance,
      ];
      rerender(<ModelEndpointSettingsView {...props} busy instances={saved} />);
      rerender(<ModelEndpointSettingsView {...props} instances={saved} />);
      await user.click(screen.getByRole("button", { name: "Back to Octant Harness" }));
      expect(
        await screen.findByRole("link", {
          name: new RegExp(`^${instance.displayName}, needs key`),
        }),
      ).toBeVisible();
      expect(screen.getByText("No API key is saved for it.")).toBeVisible();
      expect(
        screen.getByRole("button", { name: `Add key for ${instance.displayName}` }),
      ).toBeVisible();
    },
  );

  it("offers an optional context window per model under Model endpoints that shows what Octant found", async () => {
    const user = userEvent.setup();
    const onModelContextWindowChange = vi.fn(async () => true);
    const deployment = {
      id: "deployment-a" as never,
      displayName: "deployment-a",
      source: "manual" as const,
      verification: "verified" as const,
      reasoning: "unsupported" as const,
      inputModalities: ["text" as const],
      options: [],
    };
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({
          instance: foundryProvider(),
          observed: observation({
            models: [
              { ...deployment, servedModelId: "DeepSeek-V4.1-Flash" },
              { ...deployment, id: "deployment-b" as never, displayName: "deployment-b" },
              {
                ...deployment,
                id: "deployment-c" as never,
                displayName: "deployment-c",
                contextWindowOverride: 64_000,
              },
            ],
          }),
        })}
        onModelContextWindowChange={onModelContextWindowChange}
      />,
    );

    // Empty by default: the placeholder names the window found and where from.
    const found = screen.getByLabelText("Context window for deployment-a");
    expect(found).toHaveValue("");
    expect(found).toHaveAttribute("placeholder", "1,000,000 · Profile");
    expect(screen.getByLabelText("Context window for deployment-b")).toHaveAttribute(
      "placeholder",
      "Automatic · Estimate",
    );
    expect(screen.getByLabelText("Context window for deployment-c")).toHaveValue("64000");

    await user.type(found, "131,072{Enter}");
    expect(onModelContextWindowChange).toHaveBeenCalledWith(id, "deployment-a", 131_072);
    await user.tab();
    expect(onModelContextWindowChange).toHaveBeenCalledTimes(1);

    const set = screen.getByLabelText("Context window for deployment-c");
    await user.clear(set);
    await user.tab();
    expect(onModelContextWindowChange).toHaveBeenLastCalledWith(id, "deployment-c", undefined);
  });

  it("shows the stored window again when saving an override is refused, so it can be retried", async () => {
    const user = userEvent.setup();
    const onModelContextWindowChange = vi.fn(async () => false);
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({
          instance: foundryProvider(),
          observed: observation({
            models: [
              {
                id: "deployment-a" as never,
                displayName: "deployment-a",
                source: "manual",
                verification: "unverified",
                reasoning: "unsupported",
                inputModalities: ["text"],
                options: [],
              },
            ],
          }),
        })}
        onModelContextWindowChange={onModelContextWindowChange}
      />,
    );
    const field = screen.getByLabelText("Context window for deployment-a");
    await user.type(field, "131072{Enter}");
    await waitFor(() => expect(field).toHaveValue(""));
    await user.type(field, "131072{Enter}");
    expect(onModelContextWindowChange).toHaveBeenCalledTimes(2);
  });

  it("lets an Ollama model take a larger context window, held to the window it was trained for", async () => {
    const user = userEvent.setup();
    const onModelContextWindowChange = vi.fn(async () => true);
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({
          instance: ollamaProvider(),
          observed: observation({
            models: [
              {
                id: "qwen3:latest" as never,
                displayName: "qwen3:latest",
                source: "discovered",
                verification: "verified",
                contextLimit: 32_768,
                trainedContextWindow: 131_072,
                reasoning: "unsupported",
                inputModalities: ["text"],
                options: [],
              },
            ],
          }),
        })}
        onModelContextWindowChange={onModelContextWindowChange}
      />,
    );

    const field = screen.getByLabelText("Context window for qwen3:latest");
    expect(field).toHaveAttribute("placeholder", "32,768 · Reported");
    await user.type(field, "262144{Enter}");
    // Ollama loads no more than the trained window, so that is what is saved and shown.
    expect(onModelContextWindowChange).toHaveBeenCalledWith(id, "qwen3:latest", 131_072);
    expect(field).toHaveValue("131072");
  });

  it("shows a stored Ollama window above the trained one as the window that takes effect", async () => {
    const user = userEvent.setup();
    const onModelContextWindowChange = vi.fn(async () => true);
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({
          instance: ollamaProvider(),
          observed: observation({
            models: [
              {
                id: "qwen3:latest" as never,
                displayName: "qwen3:latest",
                source: "discovered",
                verification: "verified",
                contextLimit: 32_768,
                // Saved before Ollama named the trained window, or by an
                // earlier pull of the same tag with a longer one.
                contextWindowOverride: 262_144,
                trainedContextWindow: 131_072,
                reasoning: "unsupported",
                inputModalities: ["text"],
                options: [],
              },
            ],
          }),
        })}
        onModelContextWindowChange={onModelContextWindowChange}
      />,
    );

    const field = screen.getByLabelText("Context window for qwen3:latest");
    expect(field).toHaveValue("131072");
    // Passing through the box is not an edit, so nothing is saved.
    await user.click(field);
    await user.tab();
    expect(onModelContextWindowChange).not.toHaveBeenCalled();
  });

  it("asks for no context window on a provider that runs its own model", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ observed: observation() })}
        onModelContextWindowChange={vi.fn(async () => true)}
      />,
    );
    expect(screen.queryByLabelText("Context window for Model One")).not.toBeInTheDocument();
  });

  it.each([
    ["OpenAI-compatible", httpProvider()],
    ["Anthropic-compatible", anthropicProvider()],
    ["Azure AI Foundry", foundryProvider()],
  ] as const)(
    "verifies tools for a Chat only model of an %s endpoint on request",
    async (_label, instance) => {
      const user = userEvent.setup();
      const props = fixture({ instance, observed: observation() });
      renderExpanded(<ModelEndpointSettingsView {...props} />);

      const models = screen.getByRole("list", { name: `${instance.displayName} models` });
      expect(within(models).getByText("Chat only")).toBeVisible();
      await user.click(within(models).getByRole("button", { name: "Verify tools for Model One" }));

      expect(props.onVerifyModelTools).toHaveBeenCalledWith(id, "model-1");
    },
  );

  it("drops the Chat only tag from a model verified for tools and keeps it on the others", () => {
    const props = fixture({
      instance: httpProvider(),
      observed: observation({
        models: [
          ...observation().models,
          { ...observation().models[0]!, id: "model-2" as never, displayName: "Model Two" },
        ],
        verifiedToolModelIds: ["model-1" as never],
      }),
    });
    renderExpanded(<ModelEndpointSettingsView {...props} />);

    const models = screen.getByRole("list", { name: "Private gateway models" });
    const [first, second] = within(models).getAllByRole("listitem");
    expect(within(first!).queryByText("Chat only")).toBeNull();
    expect(within(second!).getByText("Chat only")).toBeVisible();
    expect(
      within(second!).getByRole("button", { name: "Verify tools for Model Two" }),
    ).toBeVisible();
  });

  it("saves Azure AI Foundry configuration changes for an existing provider", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: foundryProvider() });
    renderExpanded(<ModelEndpointSettingsView {...props} />);

    const card = screen.getByLabelText("Foundry relay");
    await user.clear(within(card).getByLabelText("Foundry OpenAI v1 base URL for Foundry relay"));
    await user.type(
      within(card).getByLabelText("Foundry OpenAI v1 base URL for Foundry relay"),
      "https://foundry.updated.openai.azure.com/openai/v1/",
    );
    await chooseSelectFieldOption(
      user,
      within(card).getByLabelText("Protocol preference for Foundry relay"),
      "Responses",
    );
    await user.clear(within(card).getByLabelText("Deployment IDs for Foundry relay"));
    await user.type(
      within(card).getByLabelText("Deployment IDs for Foundry relay"),
      "deployment-b, deployment-c",
    );
    await user.type(within(card).getByLabelText("API key for Foundry relay"), "rotated-secret");
    await user.click(
      within(card).getByRole("button", {
        name: "Save Azure AI Foundry settings for Foundry relay",
      }),
    );

    expect(props.onChangeAzureFoundryConfiguration).toHaveBeenCalledOnce();
    const [instanceId, configuration, credential] = vi.mocked(
      props.onChangeAzureFoundryConfiguration,
    ).mock.calls[0]!;
    expect(instanceId).toBe(id);
    expect(configuration).toMatchObject({
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.updated.openai.azure.com/openai/v1/",
      authentication: "api-key",
      protocol: "responses",
      manualModelIds: ["deployment-b", "deployment-c"],
    });
    expect(credential.value).toBe("rotated-secret");
    expect(document.body.textContent).not.toContain("rotated-secret");
  });

  it("keeps a Foundry endpoint's organization sign-in when its settings are saved, lowercasing a pasted tenant, and shows who is signed in", async () => {
    const user = userEvent.setup();
    const onProviderOAuth = vi.fn(async () => ({
      kind: "signed-in" as const,
      accountLabel: "person@contoso.example",
    }));
    const props = {
      ...fixture({
        instance: directoryFoundryProvider(),
        observed: observation({ models: [], directoryBinding: foundryBinding }),
      }),
      onProviderOAuth,
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />);

    expect(await screen.findByText("person@contoso.example")).toBeVisible();
    expect(onProviderOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "status", descriptorId: "azure-foundry-directory" }),
    );
    const card = screen.getByLabelText("Foundry relay");
    expect(within(card).queryByLabelText("API key for Foundry relay")).not.toBeInTheDocument();
    expect(
      within(card).getByText(/Tenant 6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f · client/),
    ).toBeInTheDocument();
    const tenant = within(card).getByLabelText("Directory (tenant) ID for Foundry relay");
    expect(tenant).toHaveValue("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
    await user.clear(tenant);
    await user.type(tenant, "1E2D3C4B-5A69-4788-9A0B-C1D2E3F40516");
    await user.click(
      within(card).getByRole("button", {
        name: "Save Azure AI Foundry settings for Foundry relay",
      }),
    );

    const [, configuration, credential] = vi.mocked(props.onChangeAzureFoundryConfiguration).mock
      .calls[0]!;
    expect(configuration).toEqual({
      kind: "azure-foundry-openai-http",
      baseUrl: "https://contoso.openai.azure.com/openai/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: ["deployment-a"],
      directory: {
        tenantId: "1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516",
        clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
      },
    });
    expect(credential.value).toBe("");
  });

  it("lets a Foundry organization sign-in opt in to signing in with a code from the host's terminal, and keeps the choice on save", async () => {
    const user = userEvent.setup();
    const props = {
      ...fixture({
        instance: directoryFoundryProvider(),
        observed: observation({ models: [], directoryBinding: foundryBinding }),
      }),
      onProviderOAuth: vi.fn(async () => ({
        kind: "signed-in" as const,
        accountLabel: "person@contoso.example",
      })),
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />);
    const card = screen.getByLabelText("Foundry relay");
    const optIn = within(card).getByRole("checkbox", {
      name: "Allow sign-in with a code from this host's terminal for Foundry relay",
    });
    const save = within(card).getByRole("button", {
      name: "Save Azure AI Foundry settings for Foundry relay",
    });

    // Off unless the person turns it on, and it names the host-local command.
    expect(optIn).not.toBeChecked();
    expect(within(card).getByText('octant provider sign-in "Foundry relay"')).toBeVisible();
    await user.click(optIn);
    await user.click(save);

    const saves = vi.mocked(props.onChangeAzureFoundryConfiguration).mock.calls;
    expect(saves[0]?.[1]).toMatchObject({
      authentication: "directory-oauth",
      deviceCodeSignIn: true,
    });
    await user.click(optIn);
    await user.click(save);
    expect(saves[1]?.[1]).not.toHaveProperty("deviceCodeSignIn");
  });

  it("keeps a gateway's organization sign-in on save with its issuer fixed and no key, and shows who is signed in", async () => {
    const user = userEvent.setup();
    const onProviderOAuth = vi.fn(async () => ({
      kind: "signed-in" as const,
      accountLabel: "ada@example.test",
    }));
    const props = {
      ...fixture({
        instance: directoryGatewayProvider(),
        observed: observation({
          models: [],
          directoryBinding: {
            issuer: "https://login.example.test/oauth2/gateway" as never,
            clientId: "0oa1octantDesktop" as never,
            endpointOrigin: "https://llm.example.test",
          },
        }),
      }),
      onProviderOAuth,
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />);

    expect(await screen.findByText("ada@example.test")).toBeVisible();
    expect(onProviderOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "status", descriptorId: "gateway-directory" }),
    );
    const card = screen.getByLabelText("Company gateway");
    expect(within(card).queryByLabelText("API key for Company gateway")).not.toBeInTheDocument();
    expect(
      within(card).getByText(/Issuer https:\/\/login\.example\.test\/oauth2\/gateway · client/),
    ).toBeInTheDocument();
    // The issuer is shown, not offered for editing.
    expect(within(card).queryByRole("textbox", { name: /Issuer/ })).not.toBeInTheDocument();
    const scope = within(card).getByLabelText("Scope for Company gateway");
    await user.clear(scope);
    await user.type(scope, "gateway.chat");
    await user.click(
      within(card).getByRole("button", { name: "Save HTTP settings for Company gateway" }),
    );

    const [, configuration, credential] = vi.mocked(props.onChangeOpenAiCompatibleConfiguration)
      .mock.calls[0]!;
    expect(configuration).toEqual({
      kind: "openai-compatible-http",
      baseUrl: "https://llm.example.test/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: [],
      directory: {
        issuer: "https://login.example.test/oauth2/gateway",
        clientId: "0oa1octantDesktop",
        scope: "gateway.chat",
      },
    });
    expect(credential.value).toBe("");
  });

  it("says when the organization wants a Foundry sign-in repeated in person", async () => {
    const onProviderOAuth = vi.fn(async () => ({
      kind: "expired" as const,
      accountLabel: "person@contoso.example",
      reason: "interaction-required",
    }));
    const props = {
      ...fixture({
        instance: directoryFoundryProvider(),
        observed: observation({
          readiness: "unauthenticated",
          unauthenticatedReason: "interaction-required",
          credentialStatus: "stored",
          models: [],
          directoryBinding: foundryBinding,
        }),
      }),
      onProviderOAuth,
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />);

    const inPerson =
      "Your organization asks you to sign in again in person, for example to complete multi-factor authentication.";
    // The row's state and the sign-in panel both say it.
    await waitFor(() => expect(screen.getAllByText(inPerson)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeVisible();
  });

  it("creates an OpenAI image profile with a write-only key and no base URL", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: openAiImageProvider() });
    renderImageProviderCreation(props);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "OpenAI Image");
    const create = screen.getByRole("form", { name: "Add OpenAI image profile" });
    expect(within(create).queryByLabelText("API base URL")).not.toBeInTheDocument();
    expect(within(create).getByText(/Organization Verification/i)).toBeVisible();
    await user.type(within(create).getByLabelText("Provider name"), "Studio images");
    await user.clear(within(create).getByLabelText("Model allowlist"));
    await user.type(within(create).getByLabelText("Model allowlist"), "gpt-image-2, gpt-image-1");
    await user.clear(within(create).getByLabelText("Default model"));
    await user.type(within(create).getByLabelText("Default model"), "gpt-image-2");
    await chooseSelectFieldOption(user, within(create).getByLabelText("Quality"), "high");
    await user.type(within(create).getByLabelText("API key"), "image-secret");
    await user.click(screen.getByRole("button", { name: "Add OpenAI image profile" }));

    expect(props.onCreateOpenAiImage).toHaveBeenCalledOnce();
    const [name, configuration, credential] = vi.mocked(props.onCreateOpenAiImage).mock.calls[0]!;
    expect(name).toBe("Studio images");
    expect(configuration).toMatchObject({
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2", "gpt-image-1"],
      defaultModel: "gpt-image-2",
      quality: "high",
    });
    expect("baseUrl" in configuration).toBe(false);
    expect(credential.value).toBe("image-secret");
    credential.clear();
    expect(within(create).getByLabelText("API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("image-secret");
  });

  it("creates an OpenAI image profile from the suggested models when the fields are left untouched", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: openAiImageProvider() });
    renderImageProviderCreation(props);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "OpenAI Image");
    const create = screen.getByRole("form", { name: "Add OpenAI image profile" });
    expect(within(create).getByLabelText("Model allowlist")).toHaveValue(
      "gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini",
    );
    expect(within(create).getByLabelText("Default model")).toHaveValue("gpt-image-2");
    await user.type(within(create).getByLabelText("Provider name"), "Studio images");
    await user.type(within(create).getByLabelText("API key"), "image-secret");
    await user.click(screen.getByRole("button", { name: "Add OpenAI image profile" }));

    expect(props.onCreateOpenAiImage).toHaveBeenCalledOnce();
    const [, configuration] = vi.mocked(props.onCreateOpenAiImage).mock.calls[0]!;
    expect(configuration).toMatchObject({
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"],
      defaultModel: "gpt-image-2",
    });
  });

  it("refuses an image profile create whose required model fields were emptied", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: openAiImageProvider() });
    renderImageProviderCreation(props);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "OpenAI Image");
    const create = screen.getByRole("form", { name: "Add OpenAI image profile" });
    await user.type(within(create).getByLabelText("Provider name"), "Studio images");
    await user.clear(within(create).getByLabelText("Model allowlist"));
    await user.clear(within(create).getByLabelText("Default model"));
    await user.type(within(create).getByLabelText("API key"), "image-secret");
    await user.click(screen.getByRole("button", { name: "Add OpenAI image profile" }));

    expect(props.onCreateOpenAiImage).not.toHaveBeenCalled();
    expect(within(create).getByRole("alert")).toHaveTextContent("Model allowlist is required.");
    expect(within(create).getByLabelText("Model allowlist")).toHaveFocus();
  });

  it("shows stored Keychain status and omits a connection check for an OpenAI image profile", async () => {
    renderProviderListExpanded(fixture({ instance: openAiImageProvider() }));
    const stored = screen.getByRole("article", { name: "GPT Image" });
    expect(await within(stored).findByText("Stored in this Mac's Keychain")).toBeVisible();
    expect(
      within(stored).queryByRole("button", { name: /check connection/i }),
    ).not.toBeInTheDocument();
    expect(within(stored).queryByLabelText(/API base URL/i)).not.toBeInTheDocument();
  });

  it("shows a missing image-profile credential as not configured", async () => {
    const props = fixture({ instance: openAiImageProvider() });
    renderProviderListExpanded({
      ...props,
      onProviderCredentialStatus: vi.fn(async () => "missing" as const),
    });
    expect(
      await within(screen.getByRole("article", { name: "GPT Image" })).findByText("Not configured"),
    ).toBeVisible();
  });

  it("shows a BFL profile's key as no longer stored after its base URL moves without a new key", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: bflImageProvider() });
    renderProviderListExpanded(props);
    const card = screen.getByRole("article", { name: "FLUX" });
    expect(await within(card).findByText("Stored in this Mac's Keychain")).toBeVisible();
    await user.type(
      within(card).getByLabelText("Base URL for FLUX"),
      "https://proxy.example.test/bfl",
    );
    await user.click(
      within(card).getByRole("button", { name: "Save Black Forest Labs image settings for FLUX" }),
    );

    expect(await within(card).findByText("Not configured")).toBeVisible();
    expect(within(card).queryByText("Stored in this Mac's Keychain")).not.toBeInTheDocument();
  });

  it("shows unavailable credential status for an image profile on a remote client", () => {
    renderProviderListExpanded(
      fixture({ instance: openAiImageProvider(), credentialManagementAvailable: false }),
    );
    const card = screen.getByRole("article", { name: "GPT Image" });
    expect(within(card).getByText("Unavailable")).toBeVisible();
    expect(within(card).getByLabelText("API key for GPT Image")).toBeDisabled();
  });

  it("saves OpenAI image configuration and clears the stored key on remove", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: openAiImageProvider() });
    renderProviderListExpanded(props);
    const card = screen.getByRole("article", { name: "GPT Image" });
    await user.clear(within(card).getByLabelText("Model allowlist for GPT Image"));
    await user.type(within(card).getByLabelText("Model allowlist for GPT Image"), "gpt-image-1");
    await user.clear(within(card).getByLabelText("Default model for GPT Image"));
    await user.type(within(card).getByLabelText("Default model for GPT Image"), "gpt-image-1");
    await user.type(within(card).getByLabelText("API key for GPT Image"), "rotated-image");
    await user.click(
      within(card).getByRole("button", { name: "Save OpenAI image settings for GPT Image" }),
    );
    expect(props.onChangeOpenAiImageConfiguration).toHaveBeenCalledOnce();
    const [, configuration, credential] = vi.mocked(props.onChangeOpenAiImageConfiguration).mock
      .calls[0]!;
    expect(configuration).toMatchObject({
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-1"],
      defaultModel: "gpt-image-1",
    });
    expect(credential.value).toBe("rotated-image");
    expect(document.body.textContent).not.toContain("rotated-image");

    await user.click(within(card).getByRole("button", { name: "Remove GPT Image" }));
    expect(props.onRemove).toHaveBeenCalledWith(id);
  });

  it("creates a Gemini image profile with a write-only key and no base URL", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: geminiImageProvider() });
    renderImageProviderCreation(props);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Gemini Image");
    const create = screen.getByRole("form", { name: "Add Gemini image profile" });
    expect(within(create).queryByLabelText("API base URL")).not.toBeInTheDocument();
    await user.type(within(create).getByLabelText("Provider name"), "Nano Banana");
    await user.clear(within(create).getByLabelText("Model allowlist"));
    await user.type(
      within(create).getByLabelText("Model allowlist"),
      "gemini-3.1-flash-image, gemini-2.5-flash-image",
    );
    await user.clear(within(create).getByLabelText("Default model"));
    await user.type(within(create).getByLabelText("Default model"), "gemini-3.1-flash-image");
    await chooseSelectFieldOption(user, within(create).getByLabelText("Aspect ratio"), "16:9");
    await user.type(within(create).getByLabelText("API key"), "gemini-secret");
    await user.click(screen.getByRole("button", { name: "Add Gemini image profile" }));

    expect(props.onCreateGeminiImage).toHaveBeenCalledOnce();
    const [name, configuration, credential] = vi.mocked(props.onCreateGeminiImage).mock.calls[0]!;
    expect(name).toBe("Nano Banana");
    expect(configuration).toMatchObject({
      kind: "gemini-native-image-http",
      modelAllowlist: ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
      defaultModel: "gemini-3.1-flash-image",
      aspectRatio: "16:9",
    });
    expect("baseUrl" in configuration).toBe(false);
    expect(credential.value).toBe("gemini-secret");
    credential.clear();
    expect(within(create).getByLabelText("API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("gemini-secret");
  });

  it("creates a BFL image profile with a write-only key, its provider's own endpoint when the base URL is blank, and no quality or size fields", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: geminiImageProvider() });
    renderImageProviderCreation(props);

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "Black Forest Labs Image",
    );
    const create = screen.getByRole("form", { name: "Add Black Forest Labs image profile" });
    expect(within(create).queryByLabelText("API base URL")).not.toBeInTheDocument();
    expect(within(create).queryByLabelText("Quality")).not.toBeInTheDocument();
    expect(within(create).queryByLabelText("Size")).not.toBeInTheDocument();
    expect(within(create).queryByLabelText("Aspect ratio")).not.toBeInTheDocument();
    await user.type(within(create).getByLabelText("Provider name"), "FLUX");
    await user.clear(within(create).getByLabelText("Model allowlist"));
    await user.type(within(create).getByLabelText("Model allowlist"), "flux-pro-1.1, flux-dev");
    await user.clear(within(create).getByLabelText("Default model"));
    await user.type(within(create).getByLabelText("Default model"), "flux-pro-1.1");
    await user.type(within(create).getByLabelText("API key"), "bfl-secret");
    await user.click(screen.getByRole("button", { name: "Add Black Forest Labs image profile" }));

    expect(props.onCreateBflImage).toHaveBeenCalledOnce();
    const [name, configuration, credential] = vi.mocked(props.onCreateBflImage).mock.calls[0]!;
    expect(name).toBe("FLUX");
    expect(configuration).toMatchObject({
      kind: "bfl-image-http",
      modelAllowlist: ["flux-pro-1.1", "flux-dev"],
      defaultModel: "flux-pro-1.1",
    });
    expect("baseUrl" in configuration).toBe(false);
    expect("quality" in configuration).toBe(false);
    expect(credential.value).toBe("bfl-secret");
    credential.clear();
    expect(document.body.textContent).not.toContain("bfl-secret");
  });

  it("saves BFL image configuration with a proxy base URL and clears the stored key on remove", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: bflImageProvider() });
    renderProviderListExpanded(props);
    const card = screen.getByRole("article", { name: "FLUX" });
    await user.clear(within(card).getByLabelText("Model allowlist for FLUX"));
    await user.type(within(card).getByLabelText("Model allowlist for FLUX"), "flux-dev");
    await user.clear(within(card).getByLabelText("Default model for FLUX"));
    await user.type(within(card).getByLabelText("Default model for FLUX"), "flux-dev");
    const keyNote = /Saving a different address removes this profile's stored API key/;
    expect(within(card).queryByText(keyNote)).not.toBeInTheDocument();
    await user.type(
      within(card).getByLabelText("Base URL for FLUX"),
      "https://proxy.example.test/bfl",
    );
    expect(within(card).getByText(keyNote)).toHaveAttribute("role", "status");
    await user.type(within(card).getByLabelText("API key for FLUX"), "rotated-bfl");
    await user.click(
      within(card).getByRole("button", { name: "Save Black Forest Labs image settings for FLUX" }),
    );
    expect(props.onChangeBflImageConfiguration).toHaveBeenCalledOnce();
    const [, configuration, credential] = vi.mocked(props.onChangeBflImageConfiguration).mock
      .calls[0]!;
    expect(configuration).toMatchObject({
      kind: "bfl-image-http",
      modelAllowlist: ["flux-dev"],
      defaultModel: "flux-dev",
      baseUrl: "https://proxy.example.test/bfl",
    });
    expect(credential.value).toBe("rotated-bfl");
    expect(document.body.textContent).not.toContain("rotated-bfl");

    await user.click(within(card).getByRole("button", { name: "Remove FLUX" }));
    expect(props.onRemove).toHaveBeenCalledWith(id);
  });

  it("creates an Ideogram image profile with a write-only key and its provider's own endpoint when the base URL is blank", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: geminiImageProvider() });
    renderImageProviderCreation(props);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Ideogram Image");
    const create = screen.getByRole("form", { name: "Add Ideogram image profile" });
    expect(within(create).queryByLabelText("API base URL")).not.toBeInTheDocument();
    expect(within(create).queryByLabelText("Quality")).not.toBeInTheDocument();
    expect(within(create).queryByLabelText("Size")).not.toBeInTheDocument();
    expect(within(create).queryByLabelText("Aspect ratio")).not.toBeInTheDocument();
    await user.type(within(create).getByLabelText("Provider name"), "Ideogram");
    await user.clear(within(create).getByLabelText("Model allowlist"));
    await user.type(within(create).getByLabelText("Model allowlist"), "ideogram-v3, ideogram-v4");
    await user.clear(within(create).getByLabelText("Default model"));
    await user.type(within(create).getByLabelText("Default model"), "ideogram-v3");
    await user.type(within(create).getByLabelText("API key"), "ideogram-secret");
    await user.click(screen.getByRole("button", { name: "Add Ideogram image profile" }));

    expect(props.onCreateIdeogramImage).toHaveBeenCalledOnce();
    const [name, configuration, credential] = vi.mocked(props.onCreateIdeogramImage).mock.calls[0]!;
    expect(name).toBe("Ideogram");
    expect(configuration).toMatchObject({
      kind: "ideogram-image-http",
      modelAllowlist: ["ideogram-v3", "ideogram-v4"],
      defaultModel: "ideogram-v3",
    });
    expect("baseUrl" in configuration).toBe(false);
    expect("quality" in configuration).toBe(false);
    expect(credential.value).toBe("ideogram-secret");
    credential.clear();
    expect(document.body.textContent).not.toContain("ideogram-secret");
  });

  it("saves Ideogram image configuration and clears the stored key on remove", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: ideogramImageProvider() });
    renderProviderListExpanded(props);
    const card = screen.getByRole("article", { name: "Ideogram" });
    await user.clear(within(card).getByLabelText("Model allowlist for Ideogram"));
    await user.type(within(card).getByLabelText("Model allowlist for Ideogram"), "ideogram-v4");
    await user.clear(within(card).getByLabelText("Default model for Ideogram"));
    await user.type(within(card).getByLabelText("Default model for Ideogram"), "ideogram-v4");
    await user.type(within(card).getByLabelText("API key for Ideogram"), "rotated-ideogram");
    await user.click(
      within(card).getByRole("button", { name: "Save Ideogram image settings for Ideogram" }),
    );
    expect(props.onChangeIdeogramImageConfiguration).toHaveBeenCalledOnce();
    const [, configuration, credential] = vi.mocked(props.onChangeIdeogramImageConfiguration).mock
      .calls[0]!;
    expect(configuration).toMatchObject({
      kind: "ideogram-image-http",
      modelAllowlist: ["ideogram-v4"],
      defaultModel: "ideogram-v4",
    });
    expect(credential.value).toBe("rotated-ideogram");
    expect(document.body.textContent).not.toContain("rotated-ideogram");

    await user.click(within(card).getByRole("button", { name: "Remove Ideogram" }));
    expect(props.onRemove).toHaveBeenCalledWith(id);
  });

  it("keeps OpenCode creation behavior unchanged when switching provider types", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    expect(screen.getByLabelText("Provider type")).toHaveTextContent("OpenCode CLI");
    await user.type(screen.getByLabelText("Provider name"), "OpenCode local");
    await user.type(screen.getByLabelText("OpenCode binary"), "/opt/homebrew/bin/opencode");
    await user.click(screen.getByRole("button", { name: "Add OpenCode" }));

    expect(props.onCreate).toHaveBeenCalledWith(
      "opencode",
      "OpenCode local",
      "/opt/homebrew/bin/opencode",
    );
  });

  it("edits HTTP configuration, preserves a blank key, and supports explicit clearing", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: httpProvider() });
    renderExpanded(<ModelEndpointSettingsView {...props} />);
    const card = screen.getByRole("region", { name: "Private gateway" });

    expect(
      await within(card).findByText("Saved in this Mac's Keychain. Octant can't show it."),
    ).toBeVisible();
    expect(within(card).getByLabelText("API key for Private gateway")).toHaveValue("");
    await user.clear(within(card).getByLabelText("API base URL for Private gateway"));
    await user.type(
      within(card).getByLabelText("API base URL for Private gateway"),
      "http://localhost:11434/v1",
    );
    await user.click(
      within(card).getByRole("button", { name: "Save HTTP settings for Private gateway" }),
    );

    const [, configuration, credential] = vi.mocked(props.onChangeOpenAiCompatibleConfiguration)
      .mock.calls[0]!;
    expect(configuration.baseUrl).toBe("http://localhost:11434/v1");
    expect(credential.value).toBe("");
    await user.click(
      within(card).getByRole("button", { name: "Clear stored API key for Private gateway" }),
    );
    expect(props.onClearProviderCredential).toHaveBeenCalledWith(id);
    expect(await within(card).findByText("No key is saved for it yet.")).toBeVisible();
  });

  it("names a Linux host's credential store, not the Keychain, for a saved key", async () => {
    const pending = deferred<ProviderCredentialStatus>();
    const props = {
      ...fixture({ instance: httpProvider() }),
      onProviderCredentialStatus: vi.fn(() => pending.promise),
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />, "linux");
    const card = screen.getByRole("region", { name: "Private gateway" });
    expect(within(card).getByText("Checking the credential store…")).toBeVisible();
    await act(async () => pending.resolve("stored"));
    expect(
      await within(card).findByText(
        "Saved in this computer's credential store. Octant can't show it.",
      ),
    ).toBeVisible();
    expect(within(card).queryByText(/Keychain|this Mac/)).not.toBeInTheDocument();
  });

  it("sends a browser on a Linux host to the Octant app on this computer to remove a keyed endpoint", () => {
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({ instance: httpProvider(), credentialManagementAvailable: false })}
      />,
      "linux",
    );
    const card = screen.getByRole("region", { name: "Private gateway" });
    expect(within(card).getByText("Remove it from the Octant app on this computer.")).toBeVisible();
    expect(within(card).queryByText(/this Mac/)).not.toBeInTheDocument();
  });

  it("says a Linux host's Ollama needs no key because it answers only on this computer", () => {
    renderExpanded(
      <ModelEndpointSettingsView {...fixture({ instance: ollamaProvider() })} />,
      "linux",
    );
    const card = screen.getByRole("region", { name: "Ollama local" });
    expect(within(card).getByText(/None \(this computer only\)/)).toBeInTheDocument();
    expect(within(card).queryByText(/this Mac/)).not.toBeInTheDocument();
  });

  it("shows a pending credential check without claiming the key is missing", async () => {
    const pending = deferred<ProviderCredentialStatus>();
    const props = {
      ...fixture({ instance: httpProvider() }),
      onProviderCredentialStatus: vi.fn(() => pending.promise),
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />);
    const card = screen.getByRole("region", { name: "Private gateway" });

    expect(within(card).getByText("Checking the Keychain…")).toBeVisible();
    expect(within(card).queryByText("No key is saved for it yet.")).not.toBeInTheDocument();

    await act(async () => pending.resolve("missing"));
    expect(await within(card).findByText("No key is saved for it yet.")).toBeVisible();
  });

  it("synchronizes an authoritative observed credential status over a stale check", async () => {
    const first = deferred<ProviderCredentialStatus>();
    const onProviderCredentialStatus = vi.fn<() => Promise<ProviderCredentialStatus>>(
      () => first.promise,
    );
    const props = {
      ...fixture({ instance: httpProvider() }),
      onProviderCredentialStatus,
    };
    const { rerender } = renderExpanded(<ModelEndpointSettingsView {...props} />);
    const card = screen.getByRole("region", { name: "Private gateway" });
    expect(within(card).getByText("Checking the Keychain…")).toBeVisible();

    rerender(
      <ModelEndpointSettingsView
        {...props}
        observedByInstance={new Map([[id, observation({ credentialStatus: "stored" })]])}
      />,
    );
    expect(
      within(card).getByText("Saved in this Mac's Keychain. Octant can't show it."),
    ).toBeVisible();

    await act(async () => first.resolve("missing"));
    expect(
      within(card).getByText("Saved in this Mac's Keychain. Octant can't show it."),
    ).toBeVisible();
  });

  it("does not let a stale credential check overwrite a successful clear", async () => {
    const user = userEvent.setup();
    const pending = deferred<ProviderCredentialStatus>();
    const props = {
      ...fixture({
        instance: httpProvider(),
        observed: observation({ credentialStatus: "stored" }),
      }),
      onProviderCredentialStatus: vi.fn(() => pending.promise),
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />);
    const card = screen.getByRole("region", { name: "Private gateway" });

    await user.click(
      within(card).getByRole("button", { name: "Clear stored API key for Private gateway" }),
    );
    expect(await within(card).findByText("No key is saved for it yet.")).toBeVisible();

    await act(async () => pending.resolve("stored"));
    expect(within(card).getByText("No key is saved for it yet.")).toBeVisible();
  });

  it("does not let a stale credential check overwrite a successful replacement", async () => {
    const user = userEvent.setup();
    const pending = deferred<ProviderCredentialStatus>();
    const props = {
      ...fixture({
        instance: httpProvider(),
        observed: observation({ credentialStatus: "missing" }),
      }),
      onProviderCredentialStatus: vi.fn(() => pending.promise),
    };
    renderExpanded(<ModelEndpointSettingsView {...props} />);
    const card = screen.getByRole("region", { name: "Private gateway" });

    await user.type(within(card).getByLabelText("API key for Private gateway"), "replacement");
    await user.click(
      within(card).getByRole("button", { name: "Save HTTP settings for Private gateway" }),
    );
    expect(
      await within(card).findByText("Saved in this Mac's Keychain. Octant can't show it."),
    ).toBeVisible();

    await act(async () => pending.resolve("missing"));
    expect(
      within(card).getByText("Saved in this Mac's Keychain. Octant can't show it."),
    ).toBeVisible();
  });

  it("keeps the credential mutation authoritative across a configuration version update", async () => {
    const user = userEvent.setup();
    const update = deferred<boolean>();
    const props = {
      ...fixture({
        instance: httpProvider(),
        observed: observation({ credentialStatus: "missing" }),
      }),
      onChangeOpenAiCompatibleConfiguration: vi.fn((_id, _configuration, credential) => {
        credential.clear();
        return update.promise;
      }),
    };
    const { rerender } = renderExpanded(<ModelEndpointSettingsView {...props} />);
    let card = screen.getByRole("region", { name: "Private gateway" });

    await user.type(within(card).getByLabelText("API key for Private gateway"), "replacement");
    await user.click(
      within(card).getByRole("button", { name: "Save HTTP settings for Private gateway" }),
    );
    expect(within(card).getByText("Checking the Keychain…")).toBeVisible();

    rerender(
      <ModelEndpointSettingsView
        {...props}
        instances={[{ ...httpProvider(), version: 2 as never }]}
      />,
    );
    card = screen.getByRole("region", { name: "Private gateway" });
    expect(within(card).getByText("Checking the Keychain…")).toBeVisible();

    await act(async () => update.resolve(true));
    expect(
      await within(card).findByText("Saved in this Mac's Keychain. Octant can't show it."),
    ).toBeVisible();
  });

  it("discards API-key text for no-authentication saves without claiming storage", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: httpProvider(),
      observed: observation({ credentialStatus: "missing" }),
    });
    renderExpanded(<ModelEndpointSettingsView {...props} />);
    const card = screen.getByRole("region", { name: "Private gateway" });
    const authentication = within(card).getByLabelText("Authentication for Private gateway");
    const key = within(card).getByLabelText("API key for Private gateway");

    await user.type(key, "must-not-linger");
    await chooseSelectFieldOption(
      user,
      authentication,
      "No authentication (trusted loopback only)",
    );
    expect(key).toBeDisabled();
    expect(key).toHaveValue("");

    await chooseSelectFieldOption(user, authentication, "Bearer API key");
    expect(key).toBeEnabled();
    expect(key).toHaveValue("");
    await user.type(key, "stale-value");
    await chooseSelectFieldOption(
      user,
      authentication,
      "No authentication (trusted loopback only)",
    );
    key.setAttribute("value", "retained-value");
    (key as HTMLInputElement).value = "retained-value";
    await user.click(
      within(card).getByRole("button", { name: "Save HTTP settings for Private gateway" }),
    );

    const [, configuration, credential] = vi.mocked(props.onChangeOpenAiCompatibleConfiguration)
      .mock.calls[0]!;
    expect(configuration.authentication).toBe("none");
    expect(credential.value).toBe("");
    expect(key).toHaveValue("");
    expect(within(card).getByText("No key is saved for it yet.")).toBeVisible();
    expect(
      within(card).queryByText("Saved in this Mac's Keychain. Octant can't show it."),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("retained-value");
  });

  it("keeps configured and observed protocol under Diagnostics and lists models by name", () => {
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({
          instance: httpProvider(),
          observed: observation({
            readiness: "degraded",
            observedProtocol: "responses",
            credentialStatus: "stored",
            capabilities: {
              ...observation().capabilities,
              streaming: "unsupported",
            },
            models: [
              ...observation().models,
              {
                id: "manual-model" as never,
                displayName: "manual-model",
                source: "manual",
                verification: "unverified",
                reasoning: "unavailable",
                inputModalities: ["text"],
                options: [],
              },
            ],
          }),
        })}
      />,
    );
    const page = screen.getByRole("region", { name: "Private gateway" });
    const diagnostics = within(page).getByRole("region", { name: "Diagnostics" });

    expect(
      within(diagnostics).getByText("Set to Automatic · last turn used Responses"),
    ).toBeInTheDocument();
    expect(within(diagnostics).getByText(/Streaming/, { selector: "dd" })).toBeInTheDocument();
    const models = within(page).getByRole("list", { name: "Private gateway models" });
    expect(within(models).getByText("Model One")).toBeVisible();
    expect(within(models).getByText("manual-model")).toBeVisible();
    expect(within(page).queryByText(/remains usable with degraded discovery/i)).toBeNull();
  });

  it("says in words that the ChatGPT plan cannot list models instead of the generic degraded line", () => {
    const planMessage =
      "Models can't be listed on the ChatGPT plan. Add the model IDs your plan offers under Manual model IDs, then check the connection again.";
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({
          instance: {
            id,
            displayName: "ChatGPT plan",
            driverKind: "openai-compatible",
            enabled: true,
            environmentPolicy: "inherit-host",
            version: 1 as never,
            createdAt: "2026-10-08T18:36:14.976Z" as never,
            updatedAt: "2026-10-08T18:36:14.976Z" as never,
            configuration: {
              kind: "openai-compatible-http",
              baseUrl: "https://api.openai.com/v1/",
              authentication: "bearer",
              protocol: "responses",
              manualModelIds: [],
              oauthDescriptorId: "chatgpt-plan",
            },
          },
          observed: observation({
            readiness: "degraded",
            processState: "stopped",
            credentialStatus: "stored",
            models: [],
            message: planMessage,
            lastSuccessfulProbeAt: "2026-10-08T19:30:00.000Z" as never,
          }),
        })}
      />,
    );
    const card = screen.getByRole("region", { name: "ChatGPT plan" });

    expect(within(card).getByText(planMessage)).toBeVisible();
    expect(
      within(card).queryByText(/remains usable with degraded discovery or streaming/i),
    ).not.toBeInTheDocument();
  });

  it("does not infer an observed protocol from a successful connection check", () => {
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({ instance: httpProvider(), observed: observation() })}
      />,
    );
    const diagnostics = within(screen.getByRole("region", { name: "Private gateway" })).getByRole(
      "region",
      { name: "Diagnostics" },
    );
    expect(
      within(diagnostics).getByText("Set to Automatic · no turn has used it yet"),
    ).toBeInTheDocument();
  });

  it.each([
    ["unauthenticated", /authenticate with OpenCode/i],
    ["incompatible", /OpenCode runtime is incompatible/i],
    ["degraded", /review unavailable capabilities/i],
  ] as const)("provides actionable %s guidance", (readiness, guidance) => {
    renderExpanded(<ProviderSettingsView {...fixture({ observed: observation({ readiness }) })} />);
    expect(screen.getByText(guidance)).toBeVisible();
  });

  it("names a typed OpenCode probe refusal and the next supported runtime", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          observed: observation({
            readiness: "incompatible",
            processState: "stopped",
            detectedVersion: "v0.0.0-beta-18721",
            models: [],
            reason: "runtime-incompatible",
          }),
        })}
      />,
    );
    const card = screen.getByRole("article", { name: "Existing CLI" });
    const details = within(card).getByLabelText("Incompatibility details");
    expect(within(card).getByText(/Review the installed OpenCode version/i)).toBeVisible();
    expect(
      within(details).getByText("Host check: The installed OpenCode runtime is incompatible."),
    ).toBeVisible();
    expect(within(details).getByText("Version: v0.0.0-beta-18721")).toBeVisible();
  });

  it("surfaces active-session removal denial and the current-session permission default", () => {
    render(
      <ProviderSettingsView
        {...fixture({ error: "Stop active sessions before removing this provider." })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Stop active sessions");
    expect(screen.getByLabelText("Permission persistence")).toHaveTextContent(
      "Current session only",
    );
  });

  it("preserves draft edits within a version and resets them after authoritative recovery", async () => {
    const user = userEvent.setup();
    const { rerender } = renderExpanded(<ProviderSettingsView {...fixture()} />);
    const name = screen.getByLabelText("Display name for Existing CLI");
    await user.clear(name);
    await user.type(name, "Local draft");
    rerender(<ProviderSettingsView {...fixture()} />);
    expect(screen.getByLabelText("Display name for Existing CLI")).toHaveValue("Local draft");

    rerender(
      <ProviderSettingsView
        {...fixture({ instance: provider({ displayName: "Authoritative", version: 2 as never }) })}
      />,
    );
    expect(screen.getByLabelText("Display name for Authoritative")).toHaveValue("Authoritative");
  });

  it("shows the formatted last successful probe timestamp", () => {
    const timestamp = "2026-07-14T10:00:00.000Z" as never;
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ observed: observation({ lastSuccessfulProbeAt: timestamp }) })}
      />,
    );
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
    fireEvent.click(screen.getByText("Connection details"));
    const rendered = screen.getByText(expected, { selector: "time" });
    expect(rendered).toBeVisible();
    expect(rendered.closest("span")).toHaveTextContent(`Last check: ${expected}`);
  });

  it("reorders providers through up/down controls and persists the new order", async () => {
    const user = userEvent.setup();
    const firstId = decodeProviderInstanceId("70000000-0000-4000-8000-000000000091");
    const first = provider({ id: firstId, displayName: "First Provider" });
    const second = provider({ displayName: "Second Provider" });
    const props = fixture();
    render(
      <ProviderSettingsView
        {...props}
        instances={[first, second]}
        defaults={{
          permissionPersistence: "current-session",
          providerOrder: [firstId, second.id],
          version: 0 as never,
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Move Second Provider up" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reorder providers" }));
    expect(screen.getByRole("button", { name: "Move Second Provider up" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move Second Provider down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move First Provider up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move Second Provider up" }));
    expect(props.onProviderOrderChange).toHaveBeenCalledWith([second.id, firstId]);
  });

  it("keeps image-provider IDs when reordering the general list", async () => {
    const user = userEvent.setup();
    const firstId = decodeProviderInstanceId("70000000-0000-4000-8000-000000000091");
    const secondId = decodeProviderInstanceId("70000000-0000-4000-8000-000000000094");
    const imageId = decodeProviderInstanceId("70000000-0000-4000-8000-000000000095");
    const first = provider({ id: firstId, displayName: "First Provider" });
    const second = provider({ id: secondId, displayName: "Second Provider" });
    const image = { ...openAiImageProvider(), id: imageId };
    const props = fixture();
    render(
      <ProviderSettingsView
        {...props}
        instances={[first, second, image]}
        defaults={{
          permissionPersistence: "current-session",
          providerOrder: [firstId, imageId, secondId],
          version: 0 as never,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reorder providers" }));
    await user.click(screen.getByRole("button", { name: "Move Second Provider up" }));
    expect(props.onProviderOrderChange).toHaveBeenCalledWith([secondId, firstId, imageId]);
  });

  it("adds a ready model to the agent-eligible default pool without activating providers", async () => {
    const user = userEvent.setup();
    const props = fixture({ observed: observation() });
    render(<ProviderSettingsView {...props} />);

    const disclosure = screen.getByRole("button", { name: "Agent-eligible models" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("checkbox", { name: "Existing CLI — Model One" })).toBeNull();
    await user.click(disclosure);

    expect(
      screen.getByText(/never configures credentials, activates a provider, or widens authority/i),
    ).toBeVisible();
    const checkbox = screen.getByRole("checkbox", { name: "Existing CLI — Model One" });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);

    expect(props.onAgentEligibleModelsChange).toHaveBeenCalledWith([
      { providerInstanceId: id, modelId: "model-1" },
    ]);
    expect(props.onSetEnabled).not.toHaveBeenCalled();
    expect(props.onProbe).not.toHaveBeenCalled();
  });

  it("removes a stored agent-eligible model, keeping stale unavailable entries removable", async () => {
    const user = userEvent.setup();
    const props = fixture({ observed: observation() });
    render(
      <ProviderSettingsView
        {...props}
        defaults={{
          permissionPersistence: "current-session",
          agentEligibleModels: [
            { providerInstanceId: id, modelId: "model-1" as never },
            { providerInstanceId: id, modelId: "model-gone" as never },
          ],
          version: 0 as never,
        }}
      />,
    );

    const disclosure = screen.getByRole("button", { name: "Agent-eligible models" });
    expect(within(disclosure).getByText("2")).toBeVisible();
    await user.click(disclosure);

    const stale = screen.getByRole("checkbox", {
      name: "Existing CLI — model-gone (unavailable)",
    });
    expect(stale).toBeChecked();
    await user.click(stale);
    expect(props.onAgentEligibleModelsChange).toHaveBeenCalledWith([
      { providerInstanceId: id, modelId: "model-1" },
    ]);
  });

  it("offers no agent-eligible checkboxes for providers that are not ready", async () => {
    const user = userEvent.setup();
    const props = fixture({ observed: observation({ readiness: "unauthenticated" }) });
    render(<ProviderSettingsView {...props} />);

    await user.click(screen.getByRole("button", { name: "Agent-eligible models" }));

    expect(screen.queryByRole("checkbox", { name: /Model One/ })).toBeNull();
    expect(screen.getByText(/No configured, ready models are available/i)).toBeVisible();
  });

  it("offers a tool-verified endpoint model to the agent-eligible pool and withholds an unverified one", async () => {
    const user = userEvent.setup();
    const endpoint = provider({
      id: "80000000-0000-4000-8000-000000000012" as never,
      displayName: "Foundry",
      driverKind: "azure-foundry",
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://example.services.ai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "auto",
        manualModelIds: ["flash" as never, "plain" as never],
      },
    });
    const endpointId = endpoint.id;
    const [template] = observation().models;
    if (template === undefined) throw new Error("fixture has a model");
    const endpointObserved = observation({
      instanceId: endpointId,
      readiness: "degraded",
      models: [
        { ...template, id: "flash" as never, displayName: "Flash" },
        { ...template, id: "plain" as never, displayName: "Plain" },
      ],
      verifiedToolModelIds: ["flash" as never],
    });
    const props = fixture({ observed: observation() });
    render(
      <ProviderSettingsView
        {...props}
        instances={[provider(), endpoint]}
        observedByInstance={
          new Map([
            [id, observation()],
            [endpointId, endpointObserved],
          ])
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "Agent-eligible models" }));

    expect(screen.getByRole("checkbox", { name: "Foundry — Flash" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Foundry — Plain" })).toBeNull();
  });

  it("hides an observed model from new pickers while keeping its Settings toggle reversible", async () => {
    const user = userEvent.setup();
    const props = fixture({ observed: observation() });
    const rendered = renderProviderSettings(<ProviderSettingsView {...props} />);

    await user.click(screen.getByRole("button", { name: "Details for Existing CLI" }));
    expect(screen.getByRole("button", { name: "Configure Existing CLI" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    const filter = screen.getByRole("textbox", { name: /Search models for .*/ });
    expect(screen.getByText("1 model · 1 shown")).toBeVisible();
    await user.type(filter, "missing model");
    expect(screen.queryByRole("switch", { name: "Hide Model One in model pickers" })).toBeNull();
    expect(screen.getByText("No models match this filter.")).toBeVisible();
    expect(screen.getByText("0 matches · 1 shown")).toBeVisible();
    await user.clear(filter);
    const hide = screen.getByRole("switch", { name: "Hide Model One in model pickers" });
    expect(hide).toBeChecked();
    await user.click(hide);
    expect(props.onHiddenModelsChange).toHaveBeenCalledWith([
      { providerInstanceId: id, modelId: "model-1" },
    ]);

    const hiddenProps = fixture({ observed: observation() });
    rendered.rerender(
      <ProviderSettingsView
        {...hiddenProps}
        defaults={{
          ...hiddenProps.defaults,
          hiddenModels: [{ providerInstanceId: id, modelId: "model-1" as never }],
        }}
      />,
    );
    const show = screen.getByRole("switch", { name: "Show Model One in model pickers" });
    expect(screen.getByText("1 model · 0 shown")).toBeVisible();
    expect(show).not.toBeChecked();
    await user.click(show);
    expect(hiddenProps.onHiddenModelsChange).toHaveBeenCalledWith([]);
  });

  it("labels a detected but disabled provider with detected-host enable copy", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Detected Codex",
            driverKind: "codex",
            enabled: false,
            configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
          }),
          discoverySnapshot: discoverySnapshot({
            candidates: [codexCandidate()],
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Detected Codex" });
    expect(within(card).getByText("Detected on this host — enable to use")).toBeVisible();
    expect(within(card).getByLabelText("Detected locally")).toBeVisible();
  });

  it("marks and enables a disabled provider the current scan found", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Detected Codex",
            driverKind: "codex",
            enabled: false,
            configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
          }),
          discoverySnapshot: discoverySnapshot({
            candidates: [codexCandidate()],
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Detected Codex" });
    expect(within(card).getByLabelText("Detected locally")).toBeVisible();
    const control = within(card).getByRole("switch", { name: "Enable Detected Codex" });
    expect(control).toBeVisible();
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(
      within(card).getByRole("button", { name: "Details for Detected Codex" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("treats a previous auto-registration as history, not as proof the binary is still installed", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: provider({ enabled: false }),
          discoverySnapshot: discoverySnapshot({
            autoRegisteredInstanceIds: [id],
            candidates: [],
            searchedDirectories: searchedDirectoriesFor("opencode", "/opt/homebrew/bin"),
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Existing CLI" });
    expect(within(card).queryByLabelText("Detected locally")).toBeNull();
    const control = within(card).getByRole("switch", { name: "Enable Existing CLI" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAccessibleDescription(/did not find/i);
  });

  it("locates a binary from the native picker on detected and undetected runtime cards", async () => {
    const user = userEvent.setup();
    const detected = provider({
      displayName: "Detected Codex",
      driverKind: "codex",
      enabled: false,
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
    });
    const missingId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000093");
    const missing = provider({ id: missingId, displayName: "Missing OpenCode", enabled: false });
    const onLocateBinary = vi.fn(async (instanceId: ProviderInstance["id"]) =>
      String(instanceId) === String(id)
        ? ({ kind: "located", version: "codex-cli 0.48.0" } as const)
        : ({
            kind: "refused",
            message: "The chosen file did not answer OpenCode's version check.",
          } as const),
    );
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          discoverySnapshot: discoverySnapshot({
            candidates: [codexCandidate()],
            searchedDirectories: searchedDirectoriesFor("opencode", "/opt/homebrew/bin"),
          }),
        })}
        instances={[detected, missing]}
        onLocateBinary={onLocateBinary}
      />,
    );

    const detectedSection = screen.getByRole("region", { name: "Detected on this host" });
    const detectedCard = within(detectedSection).getByRole("article", { name: "Detected Codex" });
    await user.click(
      within(detectedCard).getByRole("button", { name: "Details for Detected Codex" }),
    );
    await user.click(
      within(detectedCard).getByRole("button", { name: "Locate binary for Detected Codex" }),
    );
    expect(onLocateBinary).toHaveBeenLastCalledWith(id);
    expect(await within(detectedCard).findByRole("status")).toHaveTextContent(
      "Octant checked the chosen binary and will use it (codex-cli 0.48.0).",
    );

    const missingSection = screen.getByRole("region", { name: "Supported, not detected" });
    const missingCard = within(missingSection).getByRole("article", { name: "Missing OpenCode" });
    await user.click(
      within(missingCard).getByRole("button", { name: "Details for Missing OpenCode" }),
    );
    await user.click(
      within(missingCard).getByRole("button", { name: "Locate binary for Missing OpenCode" }),
    );
    expect(onLocateBinary).toHaveBeenLastCalledWith(missingId);
    expect(
      await within(missingCard).findByText(
        "The chosen file did not answer OpenCode's version check.",
      ),
    ).toBeVisible();
  });

  it("offers Locate binary only with a native picker and only for runtimes it can check", () => {
    const glm = provider({
      displayName: "GLM",
      driverKind: "glm",
      configuration: {
        kind: "glm-acp",
        binaryPath: "/opt/homebrew/bin/glm-acp-agent",
        authentication: "provider-owned",
      },
    });
    const { unmount } = renderExpanded(<ProviderSettingsView {...fixture()} />);
    expect(screen.queryByRole("button", { name: /^Locate binary for/ })).toBeNull();
    unmount();

    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: glm })}
        onLocateBinary={vi.fn(async () => ({ kind: "cancelled" }) as const)}
      />,
    );
    expect(screen.queryByRole("button", { name: "Locate binary for GLM" })).toBeNull();
  });

  it("offers the binary the scan found when the saved one is gone, and has the host check it on click", async () => {
    const user = userEvent.setup();
    const onUseScannedBinary = vi.fn(
      async (_instanceId: ProviderInstance["id"], _binaryPath: string) =>
        ({ kind: "located", version: "codex-cli 0.49.1" }) as const,
    );
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Missing Codex",
            driverKind: "codex",
            enabled: false,
            configuration: {
              kind: "codex-cli",
              binaryPath: "/Users/example/.local/lib/node_modules/@openai/codex/bin/codex.js",
            },
          }),
          discoverySnapshot: discoverySnapshot({
            candidates: [scannedCodexCandidate()],
            // The scan looked in the saved binary's own directory and found
            // nothing there, so the saved binary is known to be gone.
            searchedDirectories: searchedDirectoriesFor(
              "codex",
              "/Users/example/.local/bin",
              "/Users/example/.local/lib/node_modules/@openai/codex/bin",
            ),
          }),
        })}
        onUseScannedBinary={onUseScannedBinary}
      />,
    );

    const card = screen.getByRole("article", { name: "Missing Codex" });
    // The stable launcher is offered, not the versioned file it resolves to.
    const offer = within(card).getByRole("button", {
      name: "Use the one found at ~/.local/bin/codex (0.49.1) for Missing Codex",
    });
    expect(onUseScannedBinary).not.toHaveBeenCalled();

    await user.click(offer);

    expect(onUseScannedBinary).toHaveBeenCalledTimes(1);
    expect(onUseScannedBinary).toHaveBeenLastCalledWith(id, "/Users/example/.local/bin/codex");
    expect(await within(card).findByRole("status")).toHaveTextContent(
      "Octant checked the chosen binary and will use it (codex-cli 0.49.1).",
    );
  });

  it("reports the host's refusal of an offered binary and keeps the saved one", async () => {
    const user = userEvent.setup();
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Missing Codex",
            driverKind: "codex",
            enabled: false,
            configuration: { kind: "codex-cli", binaryPath: "/gone/bin/codex" },
          }),
          discoverySnapshot: discoverySnapshot({
            candidates: [scannedCodexCandidate()],
            searchedDirectories: searchedDirectoriesFor("codex", "/gone/bin"),
          }),
        })}
        onUseScannedBinary={vi.fn(
          async () =>
            ({
              kind: "refused",
              message: "The chosen file did not answer Codex CLI's version check.",
            }) as const,
        )}
      />,
    );

    const card = screen.getByRole("article", { name: "Missing Codex" });
    await user.click(within(card).getByRole("button", { name: /^Use the one found at/ }));

    expect(
      await within(card).findByText("The chosen file did not answer Codex CLI's version check."),
    ).toBeVisible();
  });

  it("offers the newest compatible scanned binary when the saved one is incompatible", async () => {
    const user = userEvent.setup();
    const onUseScannedBinary = vi.fn(
      async (_instanceId: ProviderInstance["id"], _binaryPath: string) =>
        ({ kind: "located", version: "2.1.2" }) as const,
    );
    const candidate = (
      binaryPath: string,
      version: string,
      patch: Partial<DiscoverySnapshot["candidates"][number]> = {},
    ) =>
      ({
        ...opencodeCandidate(),
        binaryPath,
        discoveredPath: undefined,
        version,
        pathSummary: binaryPath.replace("/Users/example", "~"),
        ...patch,
      }) as DiscoverySnapshot["candidates"][number];
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Old OpenCode",
            configuration: {
              kind: "opencode-cli",
              binaryPath: "/Users/example/.local/bin/opencode2",
            },
          }),
          observed: observation({ readiness: "incompatible", detectedVersion: "2.0.11" }),
          discoverySnapshot: discoverySnapshot({
            candidates: [
              candidate("/Users/example/.local/bin/opencode2", "2.0.11"),
              candidate("/Users/example/.opencode/bin/opencode", "2.1.2"),
              candidate("/Users/example/.cache/opencode", "2.0.30"),
              // Newer, but the scan itself found it unusable.
              candidate("/Users/example/.broken/opencode", "2.9.0", { readiness: "incompatible" }),
            ],
            searchedDirectories: searchedDirectoriesFor("opencode", "/Users/example/.local/bin"),
          }),
        })}
        onUseScannedBinary={onUseScannedBinary}
      />,
    );

    const card = screen.getByRole("article", { name: "Old OpenCode" });
    await user.click(
      within(card).getByRole("button", {
        name: "Use the one found at ~/.opencode/bin/opencode (2.1.2) for Old OpenCode",
      }),
    );

    expect(onUseScannedBinary).toHaveBeenLastCalledWith(
      id,
      "/Users/example/.opencode/bin/opencode",
    );
  });

  it("offers no scanned binary when the saved one is the one the scan found or still works", () => {
    const onUseScannedBinary = vi.fn(async () => ({ kind: "cancelled" }) as const);
    const saved = provider({
      displayName: "Detected Codex",
      driverKind: "codex",
      enabled: false,
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
    });
    const { unmount } = renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: saved,
          discoverySnapshot: discoverySnapshot({
            candidates: [codexCandidate(), scannedCodexCandidate()],
            searchedDirectories: searchedDirectoriesFor("codex", "/opt/homebrew/bin"),
          }),
        })}
        onUseScannedBinary={onUseScannedBinary}
      />,
    );
    // The saved spelling is the scan's launcher path: nothing to switch to.
    expect(screen.queryByRole("button", { name: /^Use the one found at/ })).toBeNull();
    unmount();

    // A saved binary that starts and answers is never second-guessed, even
    // when the scan did not look where it lives.
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Custom Codex",
            driverKind: "codex",
            configuration: { kind: "codex-cli", binaryPath: "/opt/custom/bin/codex" },
          }),
          observed: observation({ readiness: "ready" }),
          discoverySnapshot: discoverySnapshot({
            candidates: [scannedCodexCandidate()],
            searchedDirectories: searchedDirectoriesFor("codex", "/Users/example/.local/bin"),
          }),
        })}
        onUseScannedBinary={onUseScannedBinary}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Use the one found at/ })).toBeNull();
    expect(onUseScannedBinary).not.toHaveBeenCalled();
  });

  it("does not second-guess an enabled binary outside the searched directories just because the scan found another", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Custom Codex",
            driverKind: "codex",
            enabled: true,
            configuration: { kind: "codex-cli", binaryPath: "/opt/custom/bin/codex" },
          }),
          // The scan covered Codex, but only under ~/.local/bin: its silence
          // says nothing about /opt/custom/bin.
          discoverySnapshot: discoverySnapshot({
            candidates: [scannedCodexCandidate()],
            searchedDirectories: searchedDirectoriesFor("codex", "/Users/example/.local/bin"),
          }),
        })}
        onUseScannedBinary={vi.fn(async () => ({ kind: "cancelled" }) as const)}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Use the one found at/ })).toBeNull();
  });

  it("offers the scanned binary to a provider that is off and saved outside the searched directories", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: provider({
            displayName: "Old Codex",
            driverKind: "codex",
            enabled: false,
            // An npm prefix the scan does not search: nothing proves the file
            // gone, and nothing probes a provider that is off, yet the host
            // refuses to turn it on when the file is missing.
            configuration: {
              kind: "codex-cli",
              binaryPath: "/Users/example/.local/lib/node_modules/@openai/codex/bin/codex.js",
            },
          }),
          discoverySnapshot: discoverySnapshot({
            candidates: [scannedCodexCandidate()],
            searchedDirectories: searchedDirectoriesFor("codex", "/Users/example/.local/bin"),
          }),
        })}
        onUseScannedBinary={vi.fn(async () => ({ kind: "cancelled" }) as const)}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Use the one found at ~/.local/bin/codex (0.49.1) for Old Codex",
      }),
    ).toBeVisible();
  });

  it("makes no offer from a failed scan or without a way to use it", () => {
    const missing = provider({
      displayName: "Missing Codex",
      driverKind: "codex",
      enabled: false,
      configuration: { kind: "codex-cli", binaryPath: "/gone/bin/codex" },
    });
    const snapshot = (status: DiscoverySnapshot["status"]) =>
      discoverySnapshot({
        status,
        candidates: [scannedCodexCandidate()],
        searchedDirectories: searchedDirectoriesFor("codex", "/gone/bin"),
      });
    const { unmount } = renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: missing, discoverySnapshot: snapshot("failed") })}
        onUseScannedBinary={vi.fn(async () => ({ kind: "cancelled" }) as const)}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Use the one found at/ })).toBeNull();
    unmount();

    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: missing, discoverySnapshot: snapshot("completed") })}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Use the one found at/ })).toBeNull();
  });

  it("refuses to mark or enable a provider from a failed scan's stale candidates", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: provider({ enabled: false }),
          discoverySnapshot: discoverySnapshot({
            status: "failed",
            candidates: [opencodeCandidate()],
            searchedDirectories: searchedDirectoriesFor("opencode", "/opt/homebrew/bin"),
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Existing CLI" });
    expect(within(card).queryByLabelText("Detected locally")).toBeNull();
    const control = within(card).getByRole("switch", { name: "Enable Existing CLI" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAccessibleDescription(/failed/i);
  });

  it.each([
    { label: "not run", snapshot: undefined },
    {
      label: "failed",
      snapshot: discoverySnapshot({ status: "failed", candidates: [opencodeCandidate()] }),
    },
    {
      label: "cancelled",
      snapshot: discoverySnapshot({ status: "cancelled", candidates: [opencodeCandidate()] }),
    },
  ])(
    "groups a binary-backed provider under a neutral heading while the scan is $label",
    ({ snapshot }) => {
      renderProviderSettings(
        <ProviderSettingsView
          {...fixture({
            instance: provider({ enabled: false }),
            ...(snapshot === undefined ? {} : { discoverySnapshot: snapshot }),
          })}
        />,
      );

      expect(screen.queryByRole("heading", { name: "Detected on this host" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Supported, not detected" })).toBeNull();
      const neutral = screen.getByRole("heading", { name: "Other providers" });
      const card = screen.getByRole("article", { name: "Existing CLI" });
      expect(neutral.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(card).getByRole("switch", { name: "Enable Existing CLI" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    },
  );

  it("keeps a binary-backed provider fail-closed until a scan has run", () => {
    renderProviderSettings(
      <ProviderSettingsView {...fixture({ instance: provider({ enabled: false }) })} />,
    );

    const card = screen.getByRole("article", { name: "Existing CLI" });
    expect(within(card).queryByLabelText("Detected locally")).toBeNull();
    const control = within(card).getByRole("switch", { name: "Enable Existing CLI" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAccessibleDescription(/has not been scanned/i);
  });

  it("names the host's computer when a Linux host has not been scanned yet", () => {
    renderProviderSettings(
      <ProviderSettingsView {...fixture({ instance: provider({ enabled: false }) })} />,
      "linux",
    );
    const card = screen.getByRole("article", { name: "Existing CLI" });
    expect(
      within(card).getByRole("switch", { name: "Enable Existing CLI" }),
    ).toHaveAccessibleDescription(/^This computer has not been scanned for it yet\./);
  });

  it("keeps a manual endpoint enable-able and out of any detection group", () => {
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...fixture({
          instance: { ...httpProvider(), enabled: false },
          discoverySnapshot: discoverySnapshot({ candidates: [] }),
        })}
      />,
    );

    // Off shows on the row as words; its switch is on the endpoint's page.
    const row = screen.getByRole("link", { name: /^Private gateway, off, kept, not offered/ });
    expect(row).toBeVisible();
    fireEvent.click(row);
    const page = screen.getByRole("region", { name: "Private gateway" });
    expect(within(page).queryByLabelText("Detected locally")).toBeNull();
    const control = within(page).getByRole("switch", { name: "Use Private gateway" });
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("heading", { name: "Supported, not detected" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Other providers" })).toBeNull();
  });

  it("lists each provider group as one grouped list, a row per provider that expands in place", async () => {
    const user = userEvent.setup();
    const absent = {
      ...kiloProvider(),
      enabled: false,
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000095"),
    };
    const detectedCodex = {
      ...codexProvider(),
      enabled: false,
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000096"),
    };
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          observed: observation(),
          discoverySnapshot: discoverySnapshot({
            candidates: [codexCandidate()],
            searchedDirectories: [
              ...searchedDirectoriesFor("codex", "/opt/homebrew/bin"),
              ...searchedDirectoriesFor("kilo", "/opt/homebrew/bin"),
            ],
          }),
        })}
        instances={[provider(), detectedCodex, absent]}
      />,
    );

    const groups = [
      { region: screen.getByRole("region", { name: "Providers" }), rows: ["Existing CLI"] },
      {
        region: screen.getByRole("region", { name: "Detected on this host" }),
        rows: ["Codex local"],
      },
      {
        region: screen.getByRole("region", { name: "Supported, not detected" }),
        rows: ["Kilo local"],
      },
    ];
    for (const group of groups) {
      // One grouped surface per group, holding that group's rows and no other's.
      const lists = group.region.querySelectorAll(":scope > .provlist");
      expect(lists).toHaveLength(1);
      const list = lists[0];
      if (!(list instanceof HTMLElement)) throw new Error("Expected a provider list");
      expect(list).toHaveClass("setgroup");
      const rows = within(list).getAllByRole("article");
      expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(group.rows);
      for (const row of rows) {
        const name = row.getAttribute("aria-label") ?? "";
        expect(within(row).getByText(name)).toBeVisible();
        expect(row.querySelector(".prov-state")?.textContent).toMatch(/\S/);
        expect(within(row).getByRole("switch", { name: `Enable ${name}` })).toBeInTheDocument();
      }
    }

    const row = screen.getByRole("article", { name: "Existing CLI" });
    const disclosure = within(row).getByRole("button", { name: "Details for Existing CLI" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    disclosure.focus();
    await user.keyboard("{Enter}");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const details = document.getElementById(disclosure.getAttribute("aria-controls") ?? "");
    expect(details).not.toBeNull();
    expect(row).toContainElement(details);
    expect(
      within(row).getByRole("button", { name: "Check connection for Existing CLI" }),
    ).toBeVisible();

    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8").replace(
      /\s+/g,
      " ",
    );
    // Rows share one surface: no two-up card grid, no per-row card, no logo tile.
    expect(styles).not.toMatch(/\.provlist \{[^}]*grid-template-columns: repeat\(2/);
    expect(styles).toMatch(
      /\.settings-view \.provlist > \.provrow > \.icon-mark \{ grid-area: icon; width: 20px; height: 20px;/,
    );
  });

  it("opens only the first provider that needs attention, and none when every provider is fine", () => {
    const second = {
      ...codexProvider(),
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000097"),
    };
    const unauthenticated = (instanceId: ProviderInstance["id"]) => ({
      ...observation({ readiness: "unauthenticated" }),
      instanceId,
    });
    const view = renderProviderSettings(
      <ProviderSettingsView
        {...fixture()}
        instances={[provider(), second]}
        observedByInstance={
          new Map([
            [id, unauthenticated(id)],
            [second.id, unauthenticated(second.id)],
          ])
        }
      />,
    );

    expect(screen.getByRole("button", { name: "Details for Existing CLI" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Details for Codex local" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    view.unmount();
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture()}
        instances={[provider(), second]}
        observedByInstance={
          new Map([
            [id, observation()],
            [second.id, { ...observation(), instanceId: second.id }],
          ])
        }
      />,
    );
    for (const disclosure of screen.getAllByRole("button", { name: /^Details for / })) {
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("keeps the state dot neutral by default and lets only Vivid colour it", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8").replace(
      /\s+/g,
      " ",
    );
    const vivid = readFileSync(resolve(process.cwd(), "src/styles/vivid.css"), "utf8");

    // Ready is a filled dot in ink; a ring in ink needs setup; a muted ring is off.
    expect(styles).toMatch(
      /\.prov-state\[data-tone="ok"\]::before \{ background: var\(--oct-provider-ready, var\(--octant-text-primary\)\);/,
    );
    expect(styles).toMatch(
      /\.prov-state\[data-tone="warn"\]::before \{ background: transparent; border-color: var\(--oct-provider-setup, var\(--octant-text-primary\)\);/,
    );
    expect(styles).toMatch(
      /\.prov-state::before \{[^}]*border: 1\.5px solid var\(--octant-text-muted\)/,
    );
    // The ready and setup colours exist only under the Vivid style.
    expect(vivid).toMatch(
      /:root\[data-octant-style="vivid"\] \{[^}]*--oct-provider-ready: var\(--octant-palette-green[^}]*--oct-provider-setup: var\(--octant-palette-orange/,
    );
  });

  it("lists a switched-on provider under Configured providers even when the scan did not cover its binary", () => {
    const off = {
      ...kiloProvider(),
      enabled: false,
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000095"),
    };
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          // The scan finished without ever visiting the Codex binary's directory.
          discoverySnapshot: discoverySnapshot({ candidates: [] }),
        })}
        instances={[codexProvider(), off]}
      />,
    );

    const configuredHeading = screen.getByRole("heading", { name: "Configured providers" });
    const otherHeading = screen.getByRole("heading", { name: "Other providers" });
    const codexCard = screen.getByRole("article", { name: "Codex local" });
    const offCard = screen.getByRole("article", { name: "Kilo local" });

    expect(
      configuredHeading.compareDocumentPosition(codexCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      codexCard.compareDocumentPosition(otherHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      otherHeading.compareDocumentPosition(offCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Other providers" })).queryByRole("article", {
        name: "Codex local",
      }),
    ).toBeNull();
  });

  it("separates providers the scan found from supported providers it did not find", () => {
    const absent = {
      ...kiloProvider(),
      enabled: false,
      id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000095"),
    };
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          discoverySnapshot: discoverySnapshot({
            candidates: [codexCandidate()],
            searchedDirectories: [
              ...searchedDirectoriesFor("codex", "/opt/homebrew/bin"),
              ...searchedDirectoriesFor("kilo", "/opt/homebrew/bin"),
            ],
          }),
        })}
        instances={[absent, { ...codexProvider(), enabled: false }]}
      />,
    );

    const detectedHeading = screen.getByRole("heading", { name: "Detected on this host" });
    const supportedHeading = screen.getByRole("heading", { name: "Supported, not detected" });
    const detectedCard = screen.getByRole("article", { name: "Codex local" });
    const absentCard = screen.getByRole("article", { name: "Kilo local" });

    expect(
      detectedHeading.compareDocumentPosition(detectedCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      detectedCard.compareDocumentPosition(supportedHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      supportedHeading.compareDocumentPosition(absentCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Reordering must present the stored order the grips edit, not the groups.
    fireEvent.click(screen.getByRole("button", { name: "Reorder providers" }));
    expect(screen.queryByRole("heading", { name: "Detected on this host" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Supported, not detected" })).toBeNull();
    expect(screen.getByRole("article", { name: "Codex local" })).toBeVisible();
    expect(screen.getByRole("article", { name: "Kilo local" })).toBeVisible();
  });

  it("matches a symlink-spelled instance path through the scan's discovered path", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: { ...devinProvider(), enabled: false },
          discoverySnapshot: discoverySnapshot({
            candidates: [devinCandidate()],
            searchedDirectories: searchedDirectoriesFor("devin", "/Users/example/.local/bin"),
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Devin local" });
    expect(within(card).getByLabelText("Detected locally")).toBeVisible();
    const control = within(card).getByRole("switch", { name: "Enable Devin local" });
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(within(card).queryByText(/not found by the latest scan/i)).toBeNull();
  });

  it("keeps a binary outside every searched directory enable-able with an honest scan note", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: { ...devinProvider(), enabled: false },
          discoverySnapshot: discoverySnapshot({
            candidates: [],
            searchedDirectories: searchedDirectoriesFor("devin", "/opt/homebrew/bin"),
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Devin local" });
    expect(within(card).queryByLabelText("Detected locally")).toBeNull();
    const control = within(card).getByRole("switch", { name: "Enable Devin local" });
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(within(card).getByText(/not found by the latest scan/i)).toBeVisible();
  });

  it("says a provider the scan never reached was not checked rather than not found", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: { ...devinProvider(), enabled: false },
          discoverySnapshot: discoverySnapshot({
            candidates: [],
            status: "partial",
            message: "Discovery scan exceeded its time budget.",
            searchedDirectories: searchedDirectoriesFor("codex", "/opt/homebrew/bin"),
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Devin local" });
    const control = within(card).getByRole("switch", { name: "Enable Devin local" });
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(within(card).getByText(/did not check this provider/i)).toBeVisible();
    expect(within(card).queryByText(/not found by the latest scan/i)).toBeNull();
  });

  it("keeps detected Ollama enablement visible after a repeated scan", () => {
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...fixture({
          instance: decodeProviderInstance({ ...ollamaProvider(), enabled: false }),
          discoverySnapshot: discoverySnapshot({
            autoRegisteredInstanceIds: [],
            candidates: [
              {
                driverKind: "ollama",
                displayName: "Ollama",
                binaryPath: "/opt/homebrew/bin/ollama",
                readiness: "ready",
                pathSummary: "/opt/homebrew/bin/ollama",
                detectedAt: "2026-07-26T20:00:00.000Z" as never,
              },
            ],
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: /^Ollama local, off/ }));
    const page = screen.getByRole("region", { name: "Ollama local" });
    expect(within(page).getByRole("switch", { name: "Use Ollama local" })).toBeEnabled();
  });

  it("runs one automatic connection check after enabling a detected provider", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: provider({
        displayName: "Detected Codex",
        driverKind: "codex",
        enabled: false,
        configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      }),
      discoverySnapshot: discoverySnapshot({
        candidates: [codexCandidate()],
      }),
    });
    renderExpanded(<ProviderSettingsView {...props} />);

    await user.click(screen.getByRole("switch", { name: "Enable Detected Codex" }));

    expect(props.onSetEnabled).toHaveBeenCalledWith(id, true);
    expect(props.onProbe).toHaveBeenCalledWith(id, { quiet: true });
    expect(props.onProbe).toHaveBeenCalledTimes(1);
  });

  it("keeps a local CLI disabled when the completed scan searched its directory and found nothing", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture({
          instance: provider({ enabled: false }),
          discoverySnapshot: discoverySnapshot({
            candidates: [],
            searchedDirectories: searchedDirectoriesFor("opencode", "/opt/homebrew/bin"),
          }),
        })}
      />,
    );

    const control = screen.getByRole("switch", { name: "Enable Existing CLI" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAccessibleDescription(/did not find/i);
    expect(screen.queryByLabelText("Detected locally")).toBeNull();
    expect(screen.queryByText(/not found by the latest scan/i)).toBeNull();
  });

  it("renders the Bedrock Mantle setup guide only for an OpenAI-compatible endpoint", async () => {
    const user = userEvent.setup();
    renderAdding(<ModelEndpointSettingsView {...fixture()} />);
    await user.click(screen.getByRole("button", { name: /^Anthropic-compatible/ }));
    expect(screen.queryByText("Connecting Amazon Bedrock?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: /^OpenAI-compatible/ }));
    await user.click(screen.getByText("Connecting Amazon Bedrock?"));
    expect(screen.getByRole("heading", { name: "Amazon Bedrock Mantle setup" })).toBeVisible();
    expect(screen.getByText(/mantle\.us-east-1\.amazonaws\.com\/v1/)).toBeVisible();
    expect(
      screen.getByText(/does not currently expose the full Bedrock Converse API/i),
    ).toBeVisible();
  });
});

// Each host is seen from a window on the other platform, so copy that read the
// window's platform instead of the host's would name the wrong computer.
describe.each([
  {
    host: "linux",
    window: "MacIntel",
    computer: "this computer",
    store: "this computer's credential store",
    storeName: "credential store",
    elsewhere: /Keychain|this Mac/,
    keySetup: "On the Linux host, run octant provider key set",
    otherKeySetup: /On macOS/,
  },
  {
    host: "darwin",
    window: "Linux x86_64",
    computer: "this Mac",
    store: "this Mac's Keychain",
    storeName: "Keychain",
    elsewhere: /credential store|this computer/,
    keySetup: "On macOS, open this profile in Octant desktop",
    otherKeySetup: /Linux host|octant provider key set/,
  },
] as const)("provider forms on a $host host", (platform) => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", {
      value: platform.window,
      configurable: true,
    });
  });
  afterEach(() => Reflect.deleteProperty(window.navigator, "platform"));

  it("says where each image profile's key is kept and that a proxy may use HTTP only on the host's computer", async () => {
    const user = userEvent.setup();
    renderImageProviderCreation(fixture({ instance: openAiImageProvider() }), platform.host);
    for (const type of [
      "OpenAI Image",
      "Gemini Image",
      "Black Forest Labs Image",
      "Ideogram Image",
    ]) {
      await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), type);
      const guidance = screen.getByText(/The API key is stored write-only in/);
      expect(guidance).toHaveTextContent(`The API key is stored write-only in ${platform.store}.`);
      if (type === "Black Forest Labs Image" || type === "Ideogram Image") {
        expect(guidance).toHaveTextContent(`(HTTPS, or HTTP on ${platform.computer})`);
      }
      expect(guidance.textContent).not.toMatch(platform.elsewhere);
    }
  });

  it("says where an Azure AI Foundry endpoint's key is kept when its settings are edited", () => {
    renderExpanded(
      <ModelEndpointSettingsView {...fixture({ instance: foundryProvider() })} />,
      platform.host,
    );
    const guidance = within(screen.getByLabelText("Foundry relay")).getByText(
      /API keys are stored write-only in/,
    );
    expect(guidance).toHaveTextContent(
      `API keys are stored write-only in ${platform.store} and sent as the api-key header.`,
    );
    expect(guidance.textContent).not.toMatch(platform.elsewhere);
  });

  it("says where an Azure AI Foundry endpoint's key is kept when it is created", () => {
    renderProviderSettings(
      <ProviderCreateForm
        {...fixture()}
        allowedProviderTypes={["azure-foundry"]}
        initialProviderType="azure-foundry"
        triggerLabel="Add Foundry endpoint"
      />,
      platform.host,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Foundry endpoint" }));
    const guidance = screen.getByText(/API keys are stored write-only in/);
    expect(guidance).toHaveTextContent(
      `API keys are stored write-only in ${platform.store} and sent as the api-key header.`,
    );
    expect(guidance.textContent).not.toMatch(platform.elsewhere);
  });

  it("says where a Bedrock Mantle key is kept in the setup guide", async () => {
    const user = userEvent.setup();
    renderAdding(<ModelEndpointSettingsView {...fixture()} />, platform.host);
    await user.click(screen.getByRole("button", { name: /^OpenAI-compatible/ }));
    await user.click(screen.getByText("Connecting Amazon Bedrock?"));
    const step = screen.getByText(/Create a Bedrock API key/);
    expect(step).toHaveTextContent(platform.store);
    expect(step.textContent).not.toMatch(platform.elsewhere);
  });

  it("says where a missing Claude API key is kept in its repair guidance", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider("api-key"),
          observed: observation({ readiness: "unauthenticated", credentialStatus: "missing" }),
        })}
      />,
      platform.host,
    );
    const guidance = within(screen.getByRole("article", { name: "Claude local" })).getByText(
      /replace.*Anthropic API key/i,
    );
    expect(guidance).toHaveTextContent(
      `It remains write-only and is stored in ${platform.store}, then check the connection again.`,
    );
    expect(guidance.textContent).not.toMatch(platform.elsewhere);
  });

  it("gives a browser only the key setup for the host's own platform on a Claude card", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: claudeProvider("api-key"),
          credentialManagementAvailable: false,
          observed: observation({ readiness: "unauthenticated", credentialStatus: "missing" }),
        })}
      />,
      platform.host,
    );
    const note = within(screen.getByRole("article", { name: "Claude local" })).getByText(
      /This browser cannot save or remove credentials\./,
    );
    expect(note).toHaveTextContent(platform.keySetup);
    expect(note.textContent).not.toMatch(platform.otherKeySetup);
  });

  it("gives a browser only the key setup for the host's own platform when adding Claude", async () => {
    const user = userEvent.setup();
    renderExpanded(
      <ProviderSettingsView {...fixture({ credentialManagementAvailable: false })} />,
      platform.host,
    );
    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Claude Agent SDK");
    const create = screen.getByRole("form", { name: "Add Claude provider" });
    await chooseSelectFieldOption(
      user,
      within(create).getByLabelText("Claude authentication"),
      "Anthropic API key",
    );
    const note = within(create).getByText(/This browser cannot save API keys\./);
    expect(note).toHaveTextContent(platform.keySetup);
    expect(note.textContent).not.toMatch(platform.otherKeySetup);
  });

  it("names the host's store while checking a saved key and once it is found", async () => {
    const pending = deferred<ProviderCredentialStatus>();
    renderProviderListExpanded(
      {
        ...fixture({ instance: openAiImageProvider() }),
        onProviderCredentialStatus: vi.fn(() => pending.promise),
      },
      platform.host,
    );
    const card = screen.getByRole("article", { name: "GPT Image" });
    expect(within(card).getByText(`Checking the ${platform.storeName}…`)).toBeVisible();
    await act(async () => pending.resolve("stored"));
    expect(await within(card).findByText(`Stored in ${platform.store}`)).toBeVisible();
  });
});

describe("browser key setup before the host reports its platform", () => {
  it("gives both the Linux command and the macOS route while the host's platform is unknown", () => {
    render(
      <HostPlatformContext.Provider value={undefined}>
        <ProviderSettingsView
          {...fixture({
            instance: claudeProvider("api-key"),
            credentialManagementAvailable: false,
            observed: observation({ readiness: "unauthenticated", credentialStatus: "missing" }),
          })}
        />
      </HostPlatformContext.Provider>,
    );
    for (const details of screen.queryAllByRole("button", { name: /^Details for / })) {
      if (details.getAttribute("aria-expanded") === "false") fireEvent.click(details);
    }
    const note = within(screen.getByRole("article", { name: "Claude local" })).getByText(
      /This browser cannot save or remove credentials\./,
    );
    expect(note).toHaveTextContent("On the Linux host, run octant provider key set");
    expect(note).toHaveTextContent("On macOS, open this profile in Octant desktop");
  });
});

describe("where Settings lists each provider kind", () => {
  const endpointId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000b1");
  const ollamaId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000b2");
  const imageId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000b3");
  const planId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000b4");

  function mixedInstances(): ReadonlyArray<ProviderInstance> {
    return [
      provider(),
      { ...httpProvider(), id: endpointId },
      { ...ollamaProvider(), id: ollamaId },
      { ...openAiImageProvider(), id: imageId },
    ];
  }

  function chatGptPlanEndpoint(): ProviderInstance {
    return {
      id: planId,
      displayName: "ChatGPT plan",
      driverKind: "openai-compatible",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as never,
      createdAt: "2026-07-15T10:00:00.000Z" as never,
      updatedAt: "2026-07-15T10:00:00.000Z" as never,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://api.openai.com/v1",
        authentication: "bearer",
        protocol: "responses",
        manualModelIds: [],
        oauthDescriptorId: "chatgpt-plan" as never,
      },
    };
  }

  it("lists only agent runtimes under Providers & Models", () => {
    renderProviderSettings(<ProviderSettingsView {...fixture()} instances={mixedInstances()} />);

    expect(screen.getByRole("article", { name: "Existing CLI" })).toBeVisible();
    expect(screen.queryByRole("article", { name: "Private gateway" })).toBeNull();
    expect(screen.queryByRole("article", { name: "Ollama local" })).toBeNull();
    expect(screen.queryByRole("article", { name: "GPT Image" })).toBeNull();
  });

  it("lists existing API endpoints as rows that open an editable, removable detail page", async () => {
    const user = userEvent.setup();
    const props = {
      ...fixture(),
      onRolesUsing: vi.fn(async () => ["Main model", "Quick jobs"] as const),
    };
    renderProviderSettings(<ModelEndpointSettingsView {...props} instances={mixedInstances()} />);

    expect(screen.getByRole("heading", { name: "Model endpoints" })).toBeVisible();
    const list = screen.getByRole("list", { name: "Model endpoints" });
    expect(within(list).getByRole("link", { name: /^Private gateway,/ })).toBeVisible();
    expect(within(list).getByRole("link", { name: /^Ollama local,/ })).toBeVisible();
    expect(within(list).queryByText("Existing CLI")).toBeNull();
    expect(within(list).queryByText("GPT Image")).toBeNull();

    await user.click(within(list).getByRole("link", { name: /^Private gateway,/ }));
    const page = screen.getByRole("region", { name: "Private gateway" });
    const baseUrl = within(page).getByLabelText("API base URL for Private gateway");
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://gateway.example/v2");
    await user.click(
      within(page).getByRole("button", { name: "Save HTTP settings for Private gateway" }),
    );
    expect(props.onChangeOpenAiCompatibleConfiguration).toHaveBeenCalledWith(
      endpointId,
      expect.objectContaining({ baseUrl: "https://gateway.example/v2" }),
      expect.anything(),
    );

    // Remove asks first, names the roles that lose a model, and starts on Keep.
    await user.click(within(page).getByRole("button", { name: "Remove Private gateway…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Private gateway?" });
    expect(await within(dialog).findByText(/Main model, Quick jobs use its models/)).toBeVisible();
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Keep endpoint" })).toHaveFocus(),
    );
    expect(props.onRemove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove endpoint" }));
    expect(props.onRemove).toHaveBeenCalledWith(endpointId);
  });

  it("says it couldn't check the roles, rather than none, when the role lookup fails", async () => {
    const user = userEvent.setup();
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...fixture()}
        instances={mixedInstances()}
        onRolesUsing={vi.fn(async () => {
          throw new Error("routing unavailable");
        })}
      />,
    );
    await user.click(screen.getByRole("link", { name: /^Private gateway,/ }));
    await user.click(screen.getByRole("button", { name: "Remove Private gateway…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Private gateway?" });
    expect(
      await within(dialog).findByText(/Octant couldn't check which model roles use it\./),
    ).toBeVisible();
    expect(within(dialog).queryByText(/No model role uses its models/)).toBeNull();
  });

  it("returns to the endpoint list from the detail page and puts focus back on its row", async () => {
    const user = userEvent.setup();
    renderProviderSettings(
      <ModelEndpointSettingsView {...fixture()} instances={mixedInstances()} />,
    );

    await user.click(screen.getByRole("link", { name: /^Ollama local,/ }));
    expect(screen.getByRole("heading", { level: 1, name: "Ollama local" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Back to Octant Harness" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /^Ollama local,/ })).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "Ollama local" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("link", { name: /^Ollama local,/ })).toHaveFocus());
  });

  it("puts a failed check's precise reason and its one fix on the row, not in a page alert", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: { ...httpProvider(), id: endpointId, displayName: "Team gateway" },
    });
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...props}
        observedByInstance={
          new Map([
            [
              endpointId,
              observation({
                instanceId: endpointId,
                readiness: "degraded",
                models: [],
                message: "Provider probe failed.",
              }),
            ],
          ])
        }
        probeFailures={
          new Map([
            [
              endpointId,
              {
                category: "protocol",
                message: "The provider returned an invalid models response.",
                failedAt: "2026-10-08T19:34:00.000Z",
              },
            ],
          ])
        }
      />,
    );

    expect(screen.getByRole("link", { name: /^Team gateway, not working/ })).toBeVisible();
    const fix = screen.getByRole("group", { name: "Fix Team gateway" });
    expect(
      within(fix).getByText(/The address replied, but not with a list of models/),
    ).toBeVisible();
    expect(within(fix).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/degraded discovery/i)).toBeNull();

    await user.click(within(fix).getByRole("button", { name: "Edit address for Team gateway" }));
    const page = screen.getByRole("region", { name: "Team gateway" });
    expect(within(page).getByLabelText("API base URL for Team gateway")).toHaveFocus();
    // The precise answer stays under Diagnostics, which opens by itself while failing.
    const diagnostics = within(page).getByRole("region", { name: "Diagnostics" });
    expect(diagnostics.querySelector("details")).toHaveAttribute("open");
    expect(
      within(diagnostics).getByText(
        /failed \(protocol\): The provider returned an invalid models response\./,
      ),
    ).toBeVisible();
  });

  it.each([
    [
      "an unreachable address",
      { category: "unavailable", message: "The provider endpoint could not be reached." },
      "Can't connect",
      "Nothing answered at gateway.example.",
      "Try again",
    ],
    [
      "a busy server",
      { category: "unavailable", message: "The provider request failed with HTTP 503." },
      "Can't connect",
      "The server is busy or down (HTTP 503). Try again in a moment.",
      "Try again",
    ],
    [
      "a refused key",
      { category: "unauthenticated", message: "The provider rejected the configured credential." },
      "Key refused",
      "The service turned down the API key.",
      "Replace key",
    ],
    [
      "no usable model",
      { category: "unavailable", message: "No usable model.", reason: "no-usable-model" },
      "No models yet",
      "Connected, but it lists no models. Add the model IDs you use.",
      "Add model IDs",
    ],
  ] as const)(
    "says what %s means on the row with its one fix",
    (_case, failure, label, sentence, fix) => {
      renderProviderSettings(
        <ModelEndpointSettingsView
          {...fixture({ instance: httpProvider() })}
          probeFailures={new Map([[id, { ...failure, failedAt: "2026-10-08T19:34:00.000Z" }]])}
        />,
      );
      expect(
        screen.getByRole("link", { name: new RegExp(`^Private gateway, ${label.toLowerCase()}`) }),
      ).toBeVisible();
      const group = screen.getByRole("group", { name: "Fix Private gateway" });
      expect(within(group).getByText(sentence)).toBeVisible();
      expect(
        within(group).getByRole("button", { name: `${fix} for Private gateway` }),
      ).toBeVisible();
    },
  );

  it("checks an endpoint again from its row's Try again without a page alert", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: httpProvider(),
      observed: observation({ readiness: "unavailable", models: [] }),
    });
    renderProviderSettings(<ModelEndpointSettingsView {...props} />);

    await user.click(screen.getByRole("button", { name: "Try again for Private gateway" }));
    expect(props.onProbe).toHaveBeenCalledWith(id, { quiet: true });
  });

  it("says a ready endpoint's model count, and how many are shown once some are hidden", () => {
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...fixture({
          instance: httpProvider(),
          observed: observation({
            models: [
              ...observation().models,
              { ...observation().models[0]!, id: "model-2" as never, displayName: "Model Two" },
            ],
          }),
        })}
        defaults={{
          permissionPersistence: "current-session",
          version: 0 as never,
          hiddenModels: [{ providerInstanceId: id, modelId: "model-2" as never }],
        }}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Private gateway, ready, 1 of 2 shown. Open details" }),
    ).toBeVisible();
    expect(screen.getByText("gateway.example · API key")).toBeVisible();
  });

  it("filters an endpoint's models by shown, hidden, or all, and by search", async () => {
    const user = userEvent.setup();
    const models = [
      ...observation().models,
      {
        ...observation().models[0]!,
        id: "vision-2" as never,
        displayName: "Vision Two",
        inputModalities: ["text", "image"] as const,
      },
    ];
    const props = fixture({ instance: httpProvider(), observed: observation({ models }) });
    renderExpanded(
      <ModelEndpointSettingsView
        {...props}
        defaults={{
          permissionPersistence: "current-session",
          version: 0 as never,
          hiddenModels: [{ providerInstanceId: id, modelId: "vision-2" as never }],
        }}
      />,
    );
    const list = () => screen.getByRole("list", { name: "Private gateway models" });
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Shown 1" }));
    expect(within(list()).getByText("Model One")).toBeVisible();
    expect(within(list()).queryByText("Vision Two")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hidden 1" }));
    expect(within(list()).getByText("Vision Two")).toBeVisible();
    expect(within(list()).getByText("Reads images")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search Private gateway models" }),
      "one",
    );
    expect(within(list()).getAllByRole("listitem")).toHaveLength(1);

    await user.click(screen.getByRole("switch", { name: "Show Model One in the model picker" }));
    expect(props.onHiddenModelsChange).toHaveBeenCalledWith([
      { providerInstanceId: id, modelId: "vision-2" },
      { providerInstanceId: id, modelId: "model-1" },
    ]);
  });

  it("never says anything about a key on an endpoint that sends none", () => {
    renderExpanded(
      <ModelEndpointSettingsView
        {...fixture({
          instance: {
            ...httpProvider(),
            configuration: {
              kind: "openai-compatible-http",
              baseUrl: "http://127.0.0.1:8080/v1",
              authentication: "none",
              protocol: "auto",
              manualModelIds: [],
            },
          } as ProviderInstance,
          observed: observation(),
        })}
      />,
    );
    const page = screen.getByRole("region", { name: "Private gateway" });
    expect(within(page).queryByRole("heading", { name: "API key" })).toBeNull();
    expect(within(page).queryByText(/Credential/)).toBeNull();
    expect(within(page).queryByText("Unavailable")).toBeNull();
  });

  it("labels where data goes in plain words the person sets", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: httpProvider(), observed: observation() });
    renderExpanded(<ModelEndpointSettingsView {...props} />);

    await user.click(screen.getByRole("checkbox", { name: "Nothing is kept after the reply" }));
    expect(props.onDataTagsChange).toHaveBeenCalledWith(id, ["zdr"]);
  });

  it("goes on to an endpoint the host made even when storing its key failed", async () => {
    const user = userEvent.setup();
    const props = {
      ...fixture(),
      onCreateOpenAiCompatible: vi.fn(async (_name, _configuration, credential) => {
        credential.clear();
        return false;
      }),
    } as ProviderSettingsViewProps;
    const { rerender } = renderProviderSettings(
      <ModelEndpointSettingsView {...props} instances={[]} />,
    );
    await user.click(screen.getByRole("button", { name: "Add endpoint" }));
    await user.click(screen.getByRole("button", { name: /^OpenAI-compatible/ }));
    const create = screen.getByRole("form", { name: "Connect OpenAI-compatible" });
    await user.type(within(create).getByLabelText("Name"), "Private gateway");
    await user.type(within(create).getByLabelText("Address"), "https://gateway.example/v1");
    await user.click(screen.getByRole("button", { name: "Check and add" }));
    rerender(
      <ModelEndpointSettingsView
        {...props}
        instances={[httpProvider()]}
        message="The provider was created, but its credential could not be stored."
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Add a model endpoint" });
    expect(
      await within(dialog).findByRole("heading", { name: "Added Private gateway" }),
    ).toBeVisible();
    expect(
      within(dialog).getByText("The provider was created, but its credential could not be stored."),
    ).toBeVisible();
    expect(props.onProbe).toHaveBeenCalledWith(id, { quiet: true });
  });

  it("labels an endpoint whose models are all unverified Chat only, as the model pickers do", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: httpProvider(), observed: observation() });
    renderProviderSettings(<ModelEndpointSettingsView {...props} />);

    const row = screen.getByRole("link", { name: /^Private gateway, ready/ }).closest("li")!;
    expect(within(row).getByText("Chat only")).toBeVisible();
    await user.click(within(row).getByRole("button", { name: "Verify tools for Private gateway" }));

    // Verifying opens the endpoint on its models' Verify tools, one request away.
    expect(screen.getByRole("button", { name: "Verify tools for Model One" })).toHaveFocus();
  });

  it("drops the Chat only label from a row once one of its models is verified", () => {
    const props = fixture({
      instance: httpProvider(),
      observed: observation({ verifiedToolModelIds: ["model-1" as never] }),
    });
    renderProviderSettings(<ModelEndpointSettingsView {...props} />);

    const row = screen.getByRole("link", { name: /^Private gateway, ready/ }).closest("li")!;
    expect(within(row).queryByText("Chat only")).toBeNull();
  });

  it("says Needs key for an endpoint added from a browser without its key", async () => {
    const user = userEvent.setup();
    const props = fixture({ credentialManagementAvailable: false });
    const { rerender } = renderProviderSettings(
      <ModelEndpointSettingsView {...props} instances={[]} />,
    );
    await user.click(screen.getByRole("button", { name: "Add endpoint" }));
    await user.click(screen.getByRole("button", { name: /^Azure AI Foundry/ }));
    const create = screen.getByRole("form", { name: "Connect Azure AI Foundry" });
    await user.type(within(create).getByLabelText("Name"), "Foundry relay");
    await user.type(
      within(create).getByLabelText("Foundry address"),
      "https://foundry.example.openai.azure.com/openai/v1/",
    );
    await user.type(
      within(create).getByRole("textbox", { name: "Deployment name" }),
      "deployment-a",
    );
    await user.click(screen.getByRole("button", { name: "Check and add" }));
    expect(props.onCreateAzureFoundry).toHaveBeenCalledOnce();
    rerender(
      <ModelEndpointSettingsView
        {...props}
        instances={[foundryProvider()]}
        probeFailures={
          new Map([
            [
              id,
              {
                category: "unauthenticated",
                message: "The provider credential is missing or unavailable.",
                failedAt: "2026-10-09T10:00:00.000Z",
              },
            ],
          ])
        }
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Add a model endpoint" });
    expect(await within(dialog).findByText("Needs key")).toBeVisible();
    expect(
      within(dialog).getByText("Add its API key in the Octant desktop app on this Mac."),
    ).toBeVisible();
    // The browser cannot add the key, so the dialog offers no key fix.
    expect(within(dialog).queryByRole("button", { name: "Open details to fix" })).toBeNull();
    await user.keyboard("{Escape}");
    const row = screen.getByRole("link", { name: /^Foundry relay, needs key/ });
    expect(row).toBeVisible();
  });

  it("offers three ways in on first run", async () => {
    renderProviderSettings(<ModelEndpointSettingsView {...fixture()} instances={[]} />);

    expect(screen.getByRole("heading", { name: "Connect a model endpoint" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign in with OpenRouter" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add endpoint" })).toBeVisible();
    expect(screen.getAllByText(/Signing in accepts these terms/).length).toBe(2);
    expect(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toHaveAccessibleDescription(/Signing in accepts these terms/);
  });

  it("creates the ChatGPT plan endpoint at its fixed URL with no key and starts its sign-in", async () => {
    const user = userEvent.setup();
    const openUrl = vi.fn();
    const onProviderOAuth = vi.fn(async (command: { readonly kind: string }) =>
      command.kind === "begin"
        ? {
            kind: "awaiting-consent" as const,
            attemptId: "attempt-1",
            authorizationUrl: "https://auth.openai.com/api/accounts/authorize?x=1",
          }
        : { kind: "signed-out" as const, termsRequired: false },
    );
    const props = { ...fixture({ onOpenExternalUrl: openUrl }), onProviderOAuth };
    const { rerender } = renderProviderSettings(
      <ModelEndpointSettingsView {...props} instances={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));

    expect(props.onCreateOpenAiCompatible).toHaveBeenCalledOnce();
    const [name, configuration, credential, instanceId] = vi.mocked(props.onCreateOpenAiCompatible)
      .mock.calls[0]!;
    expect(name).toBe("ChatGPT plan");
    expect(configuration).toEqual({
      kind: "openai-compatible-http",
      baseUrl: "https://api.openai.com/v1",
      authentication: "bearer",
      protocol: "responses",
      manualModelIds: [],
      oauthDescriptorId: "chatgpt-plan",
    });
    expect(credential.value).toBe("");
    expect(instanceId).toBeDefined();

    rerender(
      <ModelEndpointSettingsView
        {...props}
        instances={[{ ...chatGptPlanEndpoint(), id: instanceId ?? planId }]}
      />,
    );

    await waitFor(() =>
      expect(onProviderOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "begin", descriptorId: "chatgpt-plan", instanceId }),
      ),
    );
    expect(screen.getByRole("heading", { level: 1, name: "ChatGPT plan" })).toBeVisible();
    expect(screen.queryByLabelText("API base URL for ChatGPT plan")).toBeNull();
    expect(screen.queryByLabelText("API key for ChatGPT plan")).toBeNull();
    expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/api/accounts/authorize?x=1");
    expect(await screen.findByText("Continue in the browser to finish signing in.")).toBeVisible();
  });

  it("records the sign-in terms and starts the sign-in from one click on the consent line", async () => {
    const user = userEvent.setup();
    let acknowledged = false;
    const onProviderOAuth = vi.fn(async (command: { readonly kind: string }) => {
      if (command.kind === "acknowledge") {
        acknowledged = true;
        return { kind: "signed-out" as const, termsRequired: false };
      }
      if (command.kind === "begin") {
        return acknowledged
          ? { kind: "awaiting-consent" as const, attemptId: "attempt-1" }
          : { kind: "refused" as const, reason: "terms-required" };
      }
      return { kind: "signed-out" as const, termsRequired: !acknowledged };
    });
    const props = { ...fixture(), onProviderOAuth };
    const { rerender } = renderProviderSettings(
      <ModelEndpointSettingsView {...props} instances={[]} />,
    );
    expect(screen.getAllByText(/Signing in accepts these terms/)[0]).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    const instanceId = vi.mocked(props.onCreateOpenAiCompatible).mock.calls[0]?.[3];
    rerender(
      <ModelEndpointSettingsView
        {...props}
        instances={[{ ...chatGptPlanEndpoint(), id: instanceId ?? planId }]}
      />,
    );

    expect(await screen.findByText("Continue in the browser to finish signing in.")).toBeVisible();
    const kinds = onProviderOAuth.mock.calls.map(([command]) => command.kind);
    expect(kinds.indexOf("acknowledge")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("acknowledge")).toBeLessThan(kinds.indexOf("begin"));
    expect(screen.queryByRole("button", { name: "Acknowledge and continue" })).toBeNull();
  });

  it("says Sign in to use on a sign-in endpoint that has never signed in, with the sign-in as its fix", async () => {
    const onProviderOAuth = vi.fn(async () => ({
      kind: "signed-out" as const,
      termsRequired: true,
    }));
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...fixture()}
        instances={[chatGptPlanEndpoint()]}
        onProviderOAuth={onProviderOAuth}
      />,
    );
    expect(
      await screen.findByRole("link", { name: /^ChatGPT plan, sign in to use/ }),
    ).toBeVisible();
    const fix = screen.getByRole("group", { name: "Fix ChatGPT plan" });
    expect(
      within(fix).getByRole("button", { name: "Sign in with ChatGPT for ChatGPT plan" }),
    ).toBeVisible();
    expect(within(fix).getByText(/Signing in accepts these terms/)).toBeVisible();
  });

  it("shows who is signed in on a ChatGPT plan row and keeps its URL and key out of its configuration", async () => {
    const user = userEvent.setup();
    const onProviderOAuth = vi.fn(async (command: { readonly kind: string }) =>
      command.kind === "sign-out"
        ? { kind: "signed-out" as const, termsRequired: false }
        : { kind: "signed-in" as const, accountLabel: "someone@example.com" },
    );
    renderProviderSettings(
      <ModelEndpointSettingsView
        {...fixture()}
        instances={[chatGptPlanEndpoint()]}
        onProviderOAuth={onProviderOAuth}
      />,
    );

    expect(await screen.findByText("Signed in as someone@example.com")).toBeVisible();
    await user.click(screen.getByRole("link", { name: /^ChatGPT plan,/ }));
    const page = screen.getByRole("region", { name: "ChatGPT plan" });
    const signIn = within(page).getByRole("region", { name: "Sign-in" });
    expect(await within(signIn).findByText(/Signed in as/)).toBeVisible();
    expect(within(signIn).queryByRole("button", { name: "Use an API key" })).toBeNull();
    expect(within(page).queryByLabelText("API base URL for ChatGPT plan")).toBeNull();
    expect(within(page).queryByLabelText("API key for ChatGPT plan")).toBeNull();
    expect(within(page).getByText(/The endpoint is fixed for this sign-in/)).toBeVisible();

    await user.click(within(signIn).getByRole("button", { name: "Sign out" }));
    expect(onProviderOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "sign-out",
        descriptorId: "chatgpt-plan",
        instanceId: planId,
      }),
    );
    expect(
      await within(signIn).findByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeVisible();
  });
});

function ControllerBackedProviderSettings(props: {
  readonly client: ProviderClient;
  readonly host: OctantHostBridge;
}) {
  const controller = useProviderController({ client: props.client, hostBridge: props.host });
  return (
    <ProviderSettingsView
      busy={controller.busy}
      credentialManagementAvailable={controller.credentialManagementAvailable}
      defaults={controller.defaults}
      instances={controller.instances}
      {...(controller.message === undefined ? {} : { message: controller.message })}
      observedByInstance={controller.observedByInstance}
      onAgentEligibleModelsChange={controller.updateAgentEligibleModels}
      onHiddenModelsChange={controller.updateHiddenModels}
      onChangeBinary={controller.changeBinary}
      onChangeClaudeConfiguration={controller.changeClaudeConfiguration}
      onChangeCodexConfiguration={controller.changeCodexConfiguration}
      onChangeAcpAgentConfiguration={controller.changeAcpAgentConfiguration}
      onChangePiConfiguration={controller.changePiConfiguration}
      onChangeOhMyPiConfiguration={controller.changeOhMyPiConfiguration}
      onChangeOllamaConfiguration={controller.changeOllamaConfiguration}
      onChangeOpenAiCompatibleConfiguration={controller.changeOpenAiCompatibleConfiguration}
      onChangeAnthropicCompatibleConfiguration={controller.changeAnthropicCompatibleConfiguration}
      onChangeAzureFoundryConfiguration={controller.changeAzureFoundryConfiguration}
      onChangeOpenAiImageConfiguration={controller.changeOpenAiImageConfiguration}
      onChangeGeminiImageConfiguration={controller.changeGeminiImageConfiguration}
      onChangeBflImageConfiguration={controller.changeBflImageConfiguration}
      onChangeIdeogramImageConfiguration={controller.changeIdeogramImageConfiguration}
      onClearProviderCredential={controller.clearProviderCredential}
      onBeginProviderAuthentication={controller.beginProviderAuthentication}
      onCompleteProviderAuthentication={controller.completeProviderAuthentication}
      onCreate={controller.create}
      onCreateClaude={controller.createClaude}
      onCreateAcpAgent={controller.createAcpAgent}
      onCreateOllama={controller.createOllama}
      onCreateOpenAiCompatible={controller.createOpenAiCompatible}
      onCreateAnthropicCompatible={controller.createAnthropicCompatible}
      onCreateAzureFoundry={controller.createAzureFoundry}
      onCreateOpenAiImage={controller.createOpenAiImage}
      onCreateGeminiImage={controller.createGeminiImage}
      onCreateBflImage={controller.createBflImage}
      onCreateIdeogramImage={controller.createIdeogramImage}
      onPermissionPersistenceChange={controller.updatePermissionPersistence}
      onProbe={controller.probe}
      onProviderOrderChange={controller.updateProviderOrder}
      onVerifyModelTools={controller.verifyModelTools}
      onProviderCredentialStatus={controller.providerCredentialStatus}
      onRemove={controller.remove}
      onRename={controller.rename}
      onRetry={controller.retry}
      onSetEnabled={controller.setEnabled}
      onDataTagsChange={controller.setDataTags}
      onModelDataTagsChange={controller.setModelDataTags}
      probingIds={controller.probingIds}
      updatingIds={controller.updatingIds}
      status={controller.status}
    />
  );
}

function controllerClient(): ProviderClient {
  const initial: ProviderRegistrySnapshot = {
    instances: [],
    defaults: { permissionPersistence: "current-session", version: 0 as never },
    observedStates: [],
  };
  const execute: ProviderClient["execute"] = async (command) => {
    if (command.kind !== "create-claude-provider") throw new Error("Unexpected command");
    return {
      kind: "provider-created",
      instance: decodeProviderInstance({
        id: command.instanceId,
        displayName: command.displayName,
        driverKind: "claude",
        configuration: command.configuration,
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: "2026-07-17T08:00:00.000Z",
        updatedAt: "2026-07-17T08:00:00.000Z",
      }),
    };
  };
  return {
    bootstrap: vi.fn(async () => initial),
    execute: vi.fn(execute),
    probe: vi.fn(),
  };
}

function controllerHost(
  addProviderApiKey: OctantHostBridge["addProviderApiKey"],
): OctantHostBridge {
  return {
    clearProviderCredential: vi.fn(async () => undefined),
    close: vi.fn(),
    maximizeOrRestore: vi.fn(),
    minimize: vi.fn(),
    projectWindowCapability: "C".repeat(43),
    providerCredentialStatus: vi.fn(async () => "missing" as const),
    resetBounds: vi.fn(),
    selectProjectRoot: vi.fn(async () => ({ kind: "cancelled" as const })),
    addProviderApiKey,
    setProviderCredential: vi.fn(),
    setSidebarMaterialPreference: vi.fn(),
    subscribeResolvedMaterial: vi.fn(() => vi.fn()),
    listProviderApiKeys: vi.fn(async () => []),
    renameProviderApiKey: vi.fn(),
    replaceProviderApiKey: vi.fn(),
    removeProviderApiKey: vi.fn(),
    setActiveProviderApiKey: vi.fn(),
    moveProviderApiKey: vi.fn(),
  };
}

function fixture(
  options: {
    observed?: ProviderObservedState;
    error?: string;
    instance?: ProviderInstance;
    credentialManagementAvailable?: boolean;
    discoverySnapshot?: DiscoverySnapshot;
    onOpenExternalUrl?: (url: string) => void;
    onRename?: ProviderSettingsViewProps["onRename"];
  } = {},
): ProviderSettingsViewProps {
  return {
    status: "ready",
    instances: [options.instance ?? provider()],
    ...(options.discoverySnapshot === undefined
      ? {}
      : { discoverySnapshot: options.discoverySnapshot }),
    defaults: { permissionPersistence: "current-session", version: 0 as never },
    observedByInstance: new Map(options.observed ? [[id, options.observed]] : []),
    probingIds: new Set(),
    updatingIds: new Set(),
    busy: false,
    ...(options.error ? { message: options.error } : {}),
    ...(options.onOpenExternalUrl === undefined
      ? {}
      : { onOpenExternalUrl: options.onOpenExternalUrl }),
    credentialManagementAvailable: options.credentialManagementAvailable ?? true,
    onCreate: vi.fn(async () => true),
    onCreateClaude: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateAcpAgent: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateOllama: vi.fn(async () => true),
    onCreateOpenAiCompatible: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateAnthropicCompatible: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateAzureFoundry: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateOpenAiImage: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateGeminiImage: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateBflImage: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateIdeogramImage: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onRename: options.onRename ?? vi.fn(async () => true),
    onChangeBinary: vi.fn(async () => true),
    onChangeClaudeConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeCodexConfiguration: vi.fn(async () => true),
    onChangeAcpAgentConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangePiConfiguration: vi.fn(async () => true),
    onChangeOhMyPiConfiguration: vi.fn(async () => true),
    onChangeOllamaConfiguration: vi.fn(async () => true),
    onBeginProviderAuthentication: vi.fn(async () => ({
      attemptId: "provider-attempt-1" as never,
      signInUrl: "https://auth.mistral.example/attempt",
      expiresAt: "2026-07-17T11:00:00.000Z" as never,
    })),
    onCompleteProviderAuthentication: vi.fn(async () => true),
    onChangeOpenAiCompatibleConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeAnthropicCompatibleConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeAzureFoundryConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeOpenAiImageConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeGeminiImageConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeBflImageConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeIdeogramImageConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onProviderCredentialStatus: vi.fn(async () => "stored" as const),
    onClearProviderCredential: vi.fn(async () => true),
    onSetEnabled: vi.fn(async () => true),
    onDataTagsChange: vi.fn(async () => true),
    onModelDataTagsChange: vi.fn(async () => true),
    onRemove: vi.fn(async () => true),
    onProbe: vi.fn(async () => true),
    onVerifyModelTools: vi.fn(async () => "supported" as const),
    onPermissionPersistenceChange: vi.fn(async () => true),
    onProviderOrderChange: vi.fn(async () => true),
    onAgentEligibleModelsChange: vi.fn(async () => true),
    onHiddenModelsChange: vi.fn(async () => true),
    onRetry: vi.fn(async () => true),
  };
}

function provider(patch: Partial<ProviderInstance> = {}): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName: "Existing CLI",
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-14T10:00:00.000Z" as never,
    updatedAt: "2026-07-14T10:00:00.000Z" as never,
    ...patch,
  });
}

function cliNamedProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Codex CLI",
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
  });
}

function codexProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Codex local",
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
  });
}

function kimiProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Kimi local",
    driverKind: "kimi-code",
    configuration: { kind: "kimi-code-acp", binaryPath: "/opt/homebrew/bin/kimi" },
  });
}

function claudeProvider(
  authentication: "subscription" | "api-key" = "subscription",
): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Claude local",
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication,
    },
  });
}

function vibeProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Mistral Vibe local",
    driverKind: "mistral-vibe",
    configuration: {
      kind: "mistral-vibe-acp",
      binaryPath: "/Users/example/.local/bin/vibe-acp",
      authentication: "subscription",
    },
  });
}

function devinProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Devin local",
    driverKind: "devin",
    configuration: {
      kind: "devin-acp",
      binaryPath: "/Users/example/.local/bin/devin",
      authentication: "subscription",
    },
  });
}

function piProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Pi local",
    driverKind: "pi",
    configuration: { kind: "pi-rpc", binaryPath: "/opt/homebrew/bin/pi" },
  });
}

function ohMyPiProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Oh My Pi local",
    driverKind: "oh-my-pi",
    configuration: {
      kind: "oh-my-pi-rpc",
      binaryPath: "/Users/example/.bun/bin/omp",
      supportedVersion: "17.2.1",
    },
  });
}

function kiloProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Kilo local",
    driverKind: "kilo",
    configuration: { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
  });
}

function ollamaProvider(): ProviderInstance {
  return decodeProviderInstance({
    ...provider(),
    displayName: "Ollama local",
    driverKind: "ollama",
    configuration: {
      kind: "ollama-native-http",
      baseUrl: "http://127.0.0.1:11434",
    },
  });
}

function httpProvider(): ProviderInstance {
  return {
    id,
    displayName: "Private gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: ["model-a" as never],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-15T10:00:00.000Z" as never,
    updatedAt: "2026-07-15T10:00:00.000Z" as never,
  };
}

function anthropicProvider(): ProviderInstance {
  return {
    id,
    displayName: "Anthropic gateway",
    driverKind: "anthropic-compatible",
    configuration: {
      kind: "anthropic-compatible-http",
      baseUrl: "https://api.anthropic.example/v1/",
      authentication: "api-key",
      protocol: "auto",
      protocolVersion: "2023-06-01",
      manualModelIds: ["claude-3-5-sonnet" as never],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-15T10:00:00.000Z" as never,
    updatedAt: "2026-07-15T10:00:00.000Z" as never,
  };
}

function openAiImageProvider(): ProviderInstance {
  return {
    id,
    displayName: "GPT Image",
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2" as never],
      defaultModel: "gpt-image-2" as never,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-08-28T10:00:00.000Z" as never,
    updatedAt: "2026-08-28T10:00:00.000Z" as never,
  };
}

function geminiImageProvider(): ProviderInstance {
  return {
    id,
    displayName: "Gemini Image",
    driverKind: "gemini-native-image",
    configuration: {
      kind: "gemini-native-image-http",
      modelAllowlist: ["gemini-3.1-flash-image" as never],
      defaultModel: "gemini-3.1-flash-image" as never,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-08-28T10:00:00.000Z" as never,
    updatedAt: "2026-08-28T10:00:00.000Z" as never,
  };
}

function bflImageProvider(): ProviderInstance {
  return {
    id,
    displayName: "FLUX",
    driverKind: "bfl-image",
    configuration: {
      kind: "bfl-image-http",
      modelAllowlist: ["flux-pro-1.1" as never],
      defaultModel: "flux-pro-1.1" as never,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-08-28T10:00:00.000Z" as never,
    updatedAt: "2026-08-28T10:00:00.000Z" as never,
  };
}

function ideogramImageProvider(): ProviderInstance {
  return {
    id,
    displayName: "Ideogram",
    driverKind: "ideogram-image",
    configuration: {
      kind: "ideogram-image-http",
      modelAllowlist: ["ideogram-v3" as never],
      defaultModel: "ideogram-v3" as never,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-08-28T10:00:00.000Z" as never,
    updatedAt: "2026-08-28T10:00:00.000Z" as never,
  };
}

function foundryProvider(): ProviderInstance {
  return {
    id,
    displayName: "Foundry relay",
    driverKind: "azure-foundry",
    configuration: {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "api-key",
      protocol: "auto",
      manualModelIds: ["deployment-a" as never],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-19T10:00:00.000Z" as never,
    updatedAt: "2026-07-19T10:00:00.000Z" as never,
  };
}

function directoryGatewayProvider(): ProviderInstance {
  return {
    id,
    displayName: "Company gateway",
    driverKind: "openai-compatible",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-19T10:00:00.000Z" as never,
    updatedAt: "2026-07-19T10:00:00.000Z" as never,
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://llm.example.test/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: [],
      directory: {
        issuer: "https://login.example.test/oauth2/gateway" as never,
        clientId: "0oa1octantDesktop" as never,
        scope: "gateway.models" as never,
      },
    },
  };
}

function directoryFoundryProvider(): ProviderInstance {
  return {
    id,
    displayName: "Foundry relay",
    driverKind: "azure-foundry",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-19T10:00:00.000Z" as never,
    updatedAt: "2026-07-19T10:00:00.000Z" as never,
    configuration: {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://contoso.openai.azure.com/openai/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: ["deployment-a" as never],
      directory: {
        tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f" as never,
        clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d" as never,
      },
    },
  };
}

const foundryBinding = {
  tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f" as never,
  clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d" as never,
  endpointOrigin: "https://contoso.openai.azure.com",
};

function observation(patch: Partial<ProviderObservedState> = {}): ProviderObservedState {
  return {
    instanceId: id,
    readiness: "ready",
    processState: "running",
    detectedVersion: "1.17.19",
    models: [
      {
        id: "model-1" as never,
        displayName: "Model One",
        source: "discovered",
        verification: "verified",
        reasoning: "supported",
        inputModalities: ["text"],
        options: [],
      },
    ],
    capabilities: {
      streaming: "supported",
      resume: "unsupported",
      interruption: "unavailable",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "supported",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "unsupported",
      diffs: "supported",
      taskProgress: "supported",
      nativeChildAgents: "unavailable",
      harnessAutoReview: "unsupported",
      nativeAttachments: "unavailable",
      nativeWebResearch: "unavailable",
      appManagedTools: "unavailable",
      citations: "unavailable",
    },
    observedAt: "2026-07-14T10:00:00.000Z" as never,
    ...patch,
  };
}

function searchedDirectoriesFor(
  driverKind: DiscoverySnapshot["candidates"][number]["driverKind"],
  ...directories: string[]
) {
  return [{ driverKind, directories }];
}

function discoverySnapshot(patch: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return decodeDiscoverySnapshot({
    hostId: "local",
    candidates: [],
    scannedAt: "2026-07-26T20:00:00.000Z",
    scanDurationMs: 150,
    status: "completed",
    ...patch,
  });
}

function codexCandidate(): DiscoverySnapshot["candidates"][number] {
  return {
    driverKind: "codex",
    displayName: "Codex CLI",
    // Homebrew installs the CLI through a `bin/codex` symlink; the scan probes
    // the realpath, so the canonical path and the discovered spelling differ.
    binaryPath: "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    discoveredPath: "/opt/homebrew/bin/codex",
    readiness: "ready",
    pathSummary: "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    detectedAt: "2026-07-26T20:00:00.000Z" as never,
  } as DiscoverySnapshot["candidates"][number];
}

/** A Codex whose launcher symlink points at a versioned file under the home folder. */
function scannedCodexCandidate(): DiscoverySnapshot["candidates"][number] {
  return {
    driverKind: "codex",
    displayName: "Codex CLI",
    binaryPath: "/Users/example/.local/share/codex/versions/0.49.1/codex",
    discoveredPath: "/Users/example/.local/bin/codex",
    version: "codex-cli 0.49.1",
    readiness: "ready",
    pathSummary: "~/.local/share/codex/versions/0.49.1/codex",
    detectedAt: "2026-07-26T20:00:00.000Z" as never,
  } as DiscoverySnapshot["candidates"][number];
}

function devinCandidate(): DiscoverySnapshot["candidates"][number] {
  return {
    driverKind: "devin",
    displayName: "Devin ACP",
    binaryPath: "/Users/example/.local/share/devin/cli/_versions/3000.10.21/bin/devin",
    discoveredPath: "/Users/example/.local/bin/devin",
    readiness: "ready",
    pathSummary: "/Users/example/.local/bin/devin",
    detectedAt: "2026-07-26T20:00:00.000Z" as never,
  } as DiscoverySnapshot["candidates"][number];
}

function opencodeCandidate(): DiscoverySnapshot["candidates"][number] {
  return {
    driverKind: "opencode",
    displayName: "OpenCode",
    binaryPath: "/opt/homebrew/lib/node_modules/@opencode-ai/cli/bin/opencode.exe",
    discoveredPath: "/opt/homebrew/bin/opencode",
    readiness: "ready",
    pathSummary: "/opt/homebrew/lib/node_modules/@opencode-ai/cli/bin/opencode.exe",
    detectedAt: "2026-07-26T20:00:00.000Z" as never,
  } as DiscoverySnapshot["candidates"][number];
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
