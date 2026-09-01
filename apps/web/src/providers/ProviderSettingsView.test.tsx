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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderSettingsView, type ProviderSettingsViewProps } from "./ProviderSettingsView";
import { useProviderController } from "./useProviderController";
import type { OctantHostBridge } from "../shell/hostBridge";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";

const id = decodeProviderInstanceId("80000000-0000-4000-8000-000000000092");

const renderProviderSettings = render;

function renderExpanded(ui: ReactElement) {
  const result = renderProviderSettings(ui);
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

  it("adds no pane heading of its own and orders discovery, then providers, then defaults", () => {
    renderProviderSettings(
      <ProviderSettingsView
        {...fixture()}
        discovery={<section aria-label="Detected on this Mac" />}
      />,
    );

    // The settings shell owns the pane's single visible title; the pane body
    // must not repeat a "Providers" heading of its own.
    expect(screen.queryByRole("heading", { name: "Providers" })).not.toBeInTheDocument();

    const discovery = screen.getByRole("region", { name: "Detected on this Mac" });
    const providers = screen.getByRole("region", { name: "Providers" });
    const defaults = screen.getByRole("region", { name: "Defaults" });
    expect(within(defaults).getByLabelText("Permission persistence")).toBeVisible();
    expect(
      discovery.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      providers.compareDocumentPosition(defaults) & Node.DOCUMENT_POSITION_FOLLOWING,
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

  it("keeps manual provider setup behind an advanced disclosure", async () => {
    const user = userEvent.setup();
    renderProviderSettings(<ProviderSettingsView {...fixture()} />);
    const disclosure = screen.getByRole("button", { name: "Add provider manually" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Provider type")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Display name for Existing CLI")).not.toBeInTheDocument();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Custom endpoint or binary" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Details for Existing CLI" }));
    const configure = screen.getByRole("button", { name: "Configure Existing CLI" });
    expect(configure).toHaveAttribute("aria-controls");
    await user.click(configure);
    expect(screen.getByLabelText("Display name for Existing CLI")).toBeVisible();
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

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Kimi Code CLI");
    const form = screen.getByRole("form", { name: "Add provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Kimi local");
    await user.type(within(form).getByLabelText("Kimi Code binary"), "/opt/homebrew/bin/kimi");
    expect(
      within(form).queryByLabelText(/api key|credential|authentication/i),
    ).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Kimi Code" }));

    expect(props.onCreate).toHaveBeenCalledWith(
      "kimi-code",
      "Kimi local",
      "/opt/homebrew/bin/kimi",
    );
  });

  it("creates Devin from the shared form with provider-owned subscription authentication", async () => {
    const user = userEvent.setup();
    const props = fixture();
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Devin ACP");
    const form = screen.getByRole("form", { name: "Add provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Devin local");
    await user.type(within(form).getByLabelText("Devin binary"), "/Users/example/.local/bin/devin");
    expect(within(form).getByText(/subscription authentication/i)).toBeVisible();
    expect(within(form).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Devin" }));

    expect(props.onCreate).toHaveBeenCalledWith(
      "devin",
      "Devin local",
      "/Users/example/.local/bin/devin",
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
    const form = screen.getByRole("form", { name: "Add provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Kilo local");
    await user.type(within(form).getByLabelText("Kilo binary"), "/opt/homebrew/bin/kilo");
    expect(within(form).getByText(/provider-owned authentication/i)).toBeVisible();
    expect(within(form).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add Kilo" }));

    expect(props.onCreate).toHaveBeenCalledWith("kilo", "Kilo local", "/opt/homebrew/bin/kilo");
  });

  it("creates and edits Ollama as a loopback-only native API without credentials or binary controls", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: ollamaProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "Ollama native HTTP",
    );
    const create = screen.getByRole("form", { name: "Add Ollama provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Ollama local");
    expect(within(create).queryByLabelText(/binary|api key|credential/i)).not.toBeInTheDocument();
    expect(within(create).getByText(/existing user-managed Ollama service/i)).toBeVisible();
    await user.clear(within(create).getByLabelText("Ollama API base URL"));
    await user.type(within(create).getByLabelText("Ollama API base URL"), "http://127.0.0.1:11434");
    await user.click(within(create).getByRole("button", { name: "Add Ollama" }));
    expect(props.onCreateOllama).toHaveBeenCalledWith("Ollama local", {
      kind: "ollama-native-http",
      baseUrl: "http://127.0.0.1:11434",
    });

    const card = screen.getByRole("article", { name: "Ollama local" });
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

  it("gives Ollama service guidance instead of CLI binary guidance", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: ollamaProvider(),
          observed: observation({ readiness: "unavailable" }),
        })}
      />,
    );
    expect(screen.getByText(/start the user-managed Ollama service/i)).toBeVisible();
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

  it("creates Mistral Vibe and delegates subscription browser sign-in", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: vibeProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Mistral Vibe ACP");
    const create = screen.getByRole("form", { name: "Add Mistral Vibe provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Mistral Vibe local");
    await user.type(
      within(create).getByLabelText("vibe-acp binary"),
      "/Users/example/.local/bin/vibe-acp",
    );
    expect(within(create).getByLabelText("vibe-acp binary")).toHaveAttribute(
      "placeholder",
      "/absolute/path/to/vibe-acp",
    );
    expect(within(create).getByLabelText("Mistral Vibe authentication")).toHaveTextContent(
      "Mistral subscription",
    );
    await user.click(within(create).getByRole("button", { name: "Add Mistral Vibe" }));
    expect(props.onCreateMistralVibe).toHaveBeenCalledWith(
      "Mistral Vibe local",
      {
        kind: "mistral-vibe-acp",
        binaryPath: "/Users/example/.local/bin/vibe-acp",
        authentication: "subscription",
      },
      expect.objectContaining({ value: "" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Start Mistral browser sign-in for Mistral Vibe local" }),
    );
    expect(await screen.findByRole("link", { name: "Open Mistral sign-in" })).toHaveAttribute(
      "href",
      "https://auth.mistral.example/attempt",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Complete Mistral browser sign-in for Mistral Vibe local",
      }),
    );
    expect(props.onCompleteProviderAuthentication).toHaveBeenCalledWith(id, "provider-attempt-1");
  });

  it("disables only Claude API-key creation when host credential operations are unavailable", async () => {
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
    expect(submit).toBeDisabled();
    expect(within(create).getByText(/API-key providers.*Octant host app/i)).toBeVisible();
    expect(props.onCreateClaude).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "clears the real controller-backed Claude key input after host storage %s",
    async (outcome) => {
      const user = userEvent.setup();
      const setProviderCredential = vi.fn(async () => {
        if (outcome === "failure") throw new Error("private-value raw Keychain diagnostic");
      });
      const host = controllerHost(setProviderCredential);
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
      expect(setProviderCredential).toHaveBeenCalledWith(expect.any(String), "private-value");
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
    expect(within(card).getByText(/Remember for this Project/)).toHaveTextContent(/one-shot/i);
    expect(within(card).getByText(/Remember for this Project/)).toHaveTextContent(
      /Current session only/i,
    );
    expect(card.textContent).not.toMatch(/account identity|CODEX_HOME|config\.toml|access token/i);
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
    expect(within(card).getByText("Kimi Code CLI")).toBeVisible();
    expect(within(card).getByText(/kimi login/i)).toHaveTextContent(/Octant-managed profile/i);
    expect(within(card).getByText(/kimi login/i)).toHaveTextContent(
      /do not use your ordinary Kimi profile/i,
    );
    expect(within(card).getByLabelText("Binary path for Kimi local")).toHaveValue(
      "/opt/homebrew/bin/kimi",
    );
    expect(
      within(card).queryByLabelText(/api key|credential|authentication/i),
    ).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /log in|oauth/i })).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/account identity|oauth token|KIMI_CODE_HOME|transcript/i);
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
    expect(within(card).getByLabelText("Binary path for Devin local")).toHaveValue(
      "/Users/example/.local/bin/devin",
    );
    expect(within(card).getByText(/Devin subscription/i)).toBeVisible();
    expect(within(card).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/account|team|oauth token|credentials\.toml|raw acp/i);
  });

  it("renders Pi RPC identity, provider-owned authentication guidance, and strict configuration", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: piProvider(), observed: observation({ readiness: "ready" }) })}
      />,
    );

    const card = screen.getByRole("article", { name: "Pi local" });
    expect(within(card).getByText("Pi RPC")).toBeVisible();
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
          observed: observation({ readiness: "ready" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Oh My Pi local" });
    expect(within(card).getByText("Oh My Pi RPC")).toBeVisible();
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
    expect(within(card).getByLabelText("Binary path for Kilo local")).toHaveValue(
      "/opt/homebrew/bin/kilo",
    );
    expect(within(card).queryByLabelText(/api key|credential/i)).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/auth\.json|oauth token|plugin|skill|raw acp/i);
  });

  it("explains the fail-closed Kimi runtime and managed-profile boundary", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({
          instance: kimiProvider(),
          observed: observation({ readiness: "incompatible" }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Kimi local" });
    expect(within(card).getByText(/managed safety profile/i)).toHaveTextContent(/incompatible/i);
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
    expect(within(card).getByText(/update your Claude installation/i)).toBeVisible();
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
    expect(within(card).getByText(/Manage credentials in the Octant host app/)).toBeVisible();
  });

  it("shows semantic provider state and never renders runtime secrets or addresses", () => {
    renderExpanded(<ProviderSettingsView {...fixture({ observed: observation() })} />);
    const card = screen.getByRole("article", { name: "Existing CLI" });
    expect(within(card).getByText("Ready")).toBeVisible();
    expect(within(card).getByText(/Process: Running/)).toBeVisible();
    expect(within(card).getByText("Model One")).toBeVisible();
    expect(within(card).getAllByText("Supported").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("Unsupported").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/password|authorization|127\.0\.0\.1:\d+/i);
  });

  it("renders OpenAI-compatible providers as read-only HTTP summaries", () => {
    renderExpanded(<ProviderSettingsView {...fixture({ instance: httpProvider() })} />);
    const card = screen.getByRole("article", { name: "Private gateway" });

    expect(within(card).getByText("OpenAI-compatible HTTP")).toBeVisible();
    expect(within(card).getByText("https://gateway.example/v1/")).toBeVisible();
    expect(within(card).getByText(/Configured protocol: Automatic/)).toBeVisible();
    expect(within(card).getByText(/Authentication: Bearer/)).toBeVisible();
    expect(within(card).queryByLabelText(/Binary path/)).not.toBeInTheDocument();
  });

  it("creates an HTTP provider with a write-only credential and clears it after settlement", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: httpProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "OpenAI-compatible HTTP",
    );
    const create = screen.getByRole("form", { name: "Add OpenAI-compatible provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Secure gateway");
    await user.type(within(create).getByLabelText("API base URL"), "https://gateway.example/v1");
    await user.type(within(create).getByLabelText("API key"), "private-value");
    await chooseSelectFieldOption(
      user,
      within(create).getByLabelText("Protocol preference"),
      "Responses",
    );
    await user.type(within(create).getByLabelText("Manual model IDs"), "model-a, model-b\nmodel-a");
    await user.click(screen.getByRole("button", { name: "Add OpenAI-compatible provider" }));

    expect(props.onCreateOpenAiCompatible).toHaveBeenCalledOnce();
    const [name, configuration, credential] = vi.mocked(props.onCreateOpenAiCompatible).mock
      .calls[0]!;
    expect(name).toBe("Secure gateway");
    expect(configuration).toMatchObject({
      baseUrl: "https://gateway.example/v1",
      authentication: "bearer",
      protocol: "responses",
      manualModelIds: ["model-a", "model-b"],
    });
    expect(credential.value).toBe("private-value");
    credential.clear();
    expect(within(create).getByLabelText("API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("private-value");
  });

  it("creates an Anthropic-compatible provider with an API key credential", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: anthropicProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "Anthropic-compatible HTTP",
    );
    const create = screen.getByRole("form", { name: "Add Anthropic-compatible provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Anthropic relay");
    await user.type(
      within(create).getByLabelText("API base URL"),
      "https://relay.anthropic.example/v1",
    );
    await user.type(within(create).getByLabelText("API key"), "anthropic-secret");
    await user.type(within(create).getByLabelText("Anthropic protocol version"), "2023-06-01");
    await chooseSelectFieldOption(
      user,
      within(create).getByLabelText("Protocol preference"),
      "Messages",
    );
    await user.type(within(create).getByLabelText("Manual model IDs"), "claude-3-5-sonnet");
    await user.click(screen.getByRole("button", { name: "Add Anthropic-compatible provider" }));

    expect(props.onCreateAnthropicCompatible).toHaveBeenCalledOnce();
    const [name, configuration, credential] = vi.mocked(props.onCreateAnthropicCompatible).mock
      .calls[0]!;
    expect(name).toBe("Anthropic relay");
    expect(configuration).toMatchObject({
      baseUrl: "https://relay.anthropic.example/v1",
      authentication: "api-key",
      protocol: "messages",
      protocolVersion: "2023-06-01",
      manualModelIds: ["claude-3-5-sonnet"],
    });
    expect(credential.value).toBe("anthropic-secret");
    credential.clear();
    expect(within(create).getByLabelText("API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("anthropic-secret");
  });

  it("creates an Azure AI Foundry provider with an api-key credential", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: foundryProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Azure AI Foundry");
    const create = screen.getByRole("form", { name: "Add Azure AI Foundry provider" });
    await user.type(within(create).getByLabelText("Provider name"), "Foundry relay");
    await user.type(
      within(create).getByLabelText("Foundry OpenAI v1 base URL"),
      "https://foundry.example.openai.azure.com/openai/v1/",
    );
    await user.type(within(create).getByLabelText("API key"), "foundry-secret");
    await chooseSelectFieldOption(
      user,
      within(create).getByLabelText("Protocol preference"),
      "Responses",
    );
    await user.type(within(create).getByLabelText("Deployment IDs"), "deployment-a");
    await user.click(screen.getByRole("button", { name: "Add Azure AI Foundry provider" }));

    expect(props.onCreateAzureFoundry).toHaveBeenCalledOnce();
    const [name, configuration, credential] = vi.mocked(props.onCreateAzureFoundry).mock.calls[0]!;
    expect(name).toBe("Foundry relay");
    expect(configuration).toMatchObject({
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "api-key",
      protocol: "responses",
      manualModelIds: ["deployment-a"],
    });
    expect(credential.value).toBe("foundry-secret");
    credential.clear();
    expect(within(create).getByLabelText("API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("foundry-secret");
  });

  it("saves Azure AI Foundry configuration changes for an existing provider", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: foundryProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

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

  it("creates an OpenAI image profile with a write-only key and no base URL", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: openAiImageProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "OpenAI Image");
    const create = screen.getByRole("form", { name: "Add OpenAI image profile" });
    expect(within(create).queryByLabelText("API base URL")).not.toBeInTheDocument();
    expect(within(create).getByText(/Organization Verification/i)).toBeVisible();
    await user.type(within(create).getByLabelText("Provider name"), "Studio images");
    await user.type(within(create).getByLabelText("Model allowlist"), "gpt-image-2, gpt-image-1");
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

  it("shows stored Keychain status and omits a connection check for an OpenAI image profile", async () => {
    renderExpanded(<ProviderSettingsView {...fixture({ instance: openAiImageProvider() })} />);
    const stored = screen.getByRole("article", { name: "GPT Image" });
    expect(await within(stored).findByText("Stored in Keychain")).toBeVisible();
    expect(
      within(stored).queryByRole("button", { name: /check connection/i }),
    ).not.toBeInTheDocument();
    expect(within(stored).queryByLabelText(/API base URL/i)).not.toBeInTheDocument();
  });

  it("shows a missing image-profile credential as not configured", async () => {
    const props = fixture({ instance: openAiImageProvider() });
    renderExpanded(
      <ProviderSettingsView
        {...props}
        onProviderCredentialStatus={vi.fn(async () => "missing" as const)}
      />,
    );
    expect(
      await within(screen.getByRole("article", { name: "GPT Image" })).findByText("Not configured"),
    ).toBeVisible();
  });

  it("shows unavailable credential status for an image profile on a remote client", () => {
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: openAiImageProvider(), credentialManagementAvailable: false })}
      />,
    );
    const card = screen.getByRole("article", { name: "GPT Image" });
    expect(within(card).getByText("Unavailable")).toBeVisible();
    expect(within(card).getByLabelText("API key for GPT Image")).toBeDisabled();
  });

  it("saves OpenAI image configuration and clears the stored key on remove", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: openAiImageProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);
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
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Gemini Image");
    const create = screen.getByRole("form", { name: "Add Gemini image profile" });
    expect(within(create).queryByLabelText("API base URL")).not.toBeInTheDocument();
    await user.type(within(create).getByLabelText("Provider name"), "Nano Banana");
    await user.type(
      within(create).getByLabelText("Model allowlist"),
      "gemini-3.1-flash-image, gemini-2.5-flash-image",
    );
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

  it("resets stale api-key auth back to bearer when switching from Anthropic to OpenAI-compatible", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: anthropicProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "Anthropic-compatible HTTP",
    );
    const anthropicCreate = screen.getByRole("form", { name: "Add Anthropic-compatible provider" });
    await chooseSelectFieldOption(
      user,
      within(anthropicCreate).getByLabelText("Authentication"),
      "API key (x-api-key header)",
    );

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "OpenAI-compatible HTTP",
    );
    const openAiCreate = screen.getByRole("form", { name: "Add OpenAI-compatible provider" });
    const auth = within(openAiCreate).getByLabelText("Authentication");
    expect(auth).toHaveTextContent("Bearer API key");
  });

  it("clears and disables the create credential when authentication changes to none", async () => {
    const user = userEvent.setup();
    renderExpanded(<ProviderSettingsView {...fixture({ instance: httpProvider() })} />);

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "OpenAI-compatible HTTP",
    );
    const create = screen.getByRole("form", { name: "Add OpenAI-compatible provider" });
    const authentication = within(create).getByLabelText("Authentication");
    const key = within(create).getByLabelText("API key");
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
  });

  it("submits an empty create credential for no authentication despite injected DOM text", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: httpProvider(),
      observed: observation({ credentialStatus: "missing" }),
    });
    renderExpanded(<ProviderSettingsView {...props} />);

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "OpenAI-compatible HTTP",
    );
    const create = screen.getByRole("form", { name: "Add OpenAI-compatible provider" });
    await user.type(within(create).getByLabelText("Provider name"), "No-auth gateway");
    await user.type(within(create).getByLabelText("API base URL"), "http://127.0.0.1:11434/v1");
    await chooseSelectFieldOption(
      user,
      within(create).getByLabelText("Authentication"),
      "No authentication (trusted loopback only)",
    );
    const key = within(create).getByLabelText("API key");
    (key as HTMLInputElement).value = "injected-secret";
    await user.click(screen.getByRole("button", { name: "Add OpenAI-compatible provider" }));

    const [, configuration, credential] = vi.mocked(props.onCreateOpenAiCompatible).mock.calls[0]!;
    expect(configuration.authentication).toBe("none");
    expect(credential.value).toBe("");
    expect(key).toHaveValue("");
    expect(screen.getByText("Not configured")).toBeVisible();
    expect(screen.queryByText("Stored in Keychain")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("injected-secret");
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

  it("shows endpoint and authentication guidance without credential controls remotely", async () => {
    const user = userEvent.setup();
    renderExpanded(
      <ProviderSettingsView
        {...fixture({ instance: httpProvider(), credentialManagementAvailable: false })}
      />,
    );

    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "OpenAI-compatible HTTP",
    );
    expect(screen.getAllByText(/remote endpoints require HTTPS/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/manage credentials in the Octant host app/i).length,
    ).toBeGreaterThan(0);
    expect(
      within(screen.getByRole("form", { name: "Add OpenAI-compatible provider" })).getByLabelText(
        "API key",
      ),
    ).toBeDisabled();
    expect(
      within(screen.getByRole("article", { name: "Private gateway" })).queryByRole("button", {
        name: /clear stored api key/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "Private gateway" })).getByText("Unavailable"),
    ).toBeVisible();
  });

  it("edits HTTP configuration, preserves a blank key, and supports explicit clearing", async () => {
    const user = userEvent.setup();
    const props = fixture({ instance: httpProvider() });
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Private gateway" });

    expect(await within(card).findByText("Stored in Keychain")).toBeVisible();
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
    expect(await within(card).findByText("Not configured")).toBeVisible();
  });

  it("shows a pending credential check without claiming the key is missing", async () => {
    const pending = deferred<ProviderCredentialStatus>();
    const props = {
      ...fixture({ instance: httpProvider() }),
      onProviderCredentialStatus: vi.fn(() => pending.promise),
    };
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Private gateway" });

    expect(within(card).getByText("Checking Keychain…")).toBeVisible();
    expect(within(card).queryByText("Not configured")).not.toBeInTheDocument();

    await act(async () => pending.resolve("missing"));
    expect(await within(card).findByText("Not configured")).toBeVisible();
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
    const { rerender } = renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Private gateway" });
    expect(within(card).getByText("Checking Keychain…")).toBeVisible();

    rerender(
      <ProviderSettingsView
        {...props}
        observedByInstance={new Map([[id, observation({ credentialStatus: "stored" })]])}
      />,
    );
    expect(within(card).getByText("Stored in Keychain")).toBeVisible();

    await act(async () => first.resolve("missing"));
    expect(within(card).getByText("Stored in Keychain")).toBeVisible();
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
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Private gateway" });

    await user.click(
      within(card).getByRole("button", { name: "Clear stored API key for Private gateway" }),
    );
    expect(await within(card).findByText("Not configured")).toBeVisible();

    await act(async () => pending.resolve("stored"));
    expect(within(card).getByText("Not configured")).toBeVisible();
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
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Private gateway" });

    await user.type(within(card).getByLabelText("API key for Private gateway"), "replacement");
    await user.click(
      within(card).getByRole("button", { name: "Save HTTP settings for Private gateway" }),
    );
    expect(await within(card).findByText("Stored in Keychain")).toBeVisible();

    await act(async () => pending.resolve("missing"));
    expect(within(card).getByText("Stored in Keychain")).toBeVisible();
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
    const { rerender } = renderExpanded(<ProviderSettingsView {...props} />);
    let card = screen.getByRole("article", { name: "Private gateway" });

    await user.type(within(card).getByLabelText("API key for Private gateway"), "replacement");
    await user.click(
      within(card).getByRole("button", { name: "Save HTTP settings for Private gateway" }),
    );
    expect(within(card).getByText("Checking Keychain…")).toBeVisible();

    rerender(
      <ProviderSettingsView {...props} instances={[{ ...httpProvider(), version: 2 as never }]} />,
    );
    card = screen.getByRole("article", { name: "Private gateway" });
    expect(within(card).getByText("Checking Keychain…")).toBeVisible();

    await act(async () => update.resolve(true));
    expect(await within(card).findByText("Stored in Keychain")).toBeVisible();
  });

  it("discards API-key text for no-authentication saves without claiming storage", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: httpProvider(),
      observed: observation({ credentialStatus: "missing" }),
    });
    renderExpanded(<ProviderSettingsView {...props} />);
    const card = screen.getByRole("article", { name: "Private gateway" });
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
    expect(within(card).getByText("Not configured")).toBeVisible();
    expect(within(card).queryByText("Stored in Keychain")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("retained-value");
  });

  it("separates configured and observed protocol and labels model provenance", () => {
    renderExpanded(
      <ProviderSettingsView
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
    const card = screen.getByRole("article", { name: "Private gateway" });

    expect(within(card).getByText("Configured protocol: Automatic")).toBeVisible();
    expect(within(card).getByText("Observed protocol: Responses")).toBeVisible();
    expect(within(card).getByText(/Model One · Discovered · Verified/)).toBeVisible();
    expect(within(card).getByText(/manual-model · Manual · Unverified/)).toBeVisible();
    expect(within(card).getAllByText("Unsupported", { selector: "dd" }).length).toBeGreaterThan(0);
    expect(
      within(card).getByText(/remains usable with degraded discovery or streaming/i),
    ).toBeVisible();
  });

  it("does not infer an observed protocol from a successful connection check", () => {
    renderExpanded(
      <ProviderSettingsView {...fixture({ instance: httpProvider(), observed: observation() })} />,
    );
    const card = screen.getByRole("article", { name: "Private gateway" });
    expect(within(card).getByText("Observed protocol: Not observed by a real turn")).toBeVisible();
  });

  it.each([
    ["unauthenticated", /authenticate with OpenCode/i],
    ["incompatible", /update your OpenCode installation/i],
    ["degraded", /review unavailable capabilities/i],
  ] as const)("provides actionable %s guidance", (readiness, guidance) => {
    renderExpanded(<ProviderSettingsView {...fixture({ observed: observation({ readiness }) })} />);
    expect(screen.getByText(guidance)).toBeVisible();
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

  it("labels disabled auto-registered providers with detected-host enable copy", () => {
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
            candidates: [
              {
                driverKind: "codex",
                displayName: "Codex CLI",
                binaryPath: "/opt/homebrew/bin/codex",
                readiness: "ready",
                pathSummary: "/opt/homebrew/bin/codex",
                detectedAt: "2026-07-26T20:00:00.000Z" as never,
              } as DiscoverySnapshot["candidates"][number],
            ],
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Detected Codex" });
    expect(within(card).getByText("Detected on this host — enable to use")).toBeVisible();
  });

  it("exposes detected-provider enablement without opening Details", () => {
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
            autoRegisteredInstanceIds: [id],
          }),
        })}
      />,
    );

    const card = screen.getByRole("article", { name: "Detected Codex" });
    expect(within(card).getByRole("switch", { name: "Enable Detected Codex" })).toBeVisible();
    expect(
      within(card).getByRole("button", { name: "Details for Detected Codex" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps detected Ollama enablement visible after a repeated scan", () => {
    renderProviderSettings(
      <ProviderSettingsView
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

    const card = screen.getByRole("article", { name: "Ollama local" });
    expect(within(card).getByRole("switch", { name: "Enable Ollama local" })).toBeVisible();
  });

  it("runs one automatic connection check after enabling a disabled auto-registered provider", async () => {
    const user = userEvent.setup();
    const props = fixture({
      instance: provider({
        displayName: "Detected Codex",
        driverKind: "codex",
        enabled: false,
        configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      }),
      discoverySnapshot: discoverySnapshot({
        autoRegisteredInstanceIds: [id],
        candidates: [
          {
            driverKind: "codex",
            displayName: "Codex CLI",
            binaryPath: "/opt/homebrew/bin/codex",
            readiness: "ready",
            pathSummary: "/opt/homebrew/bin/codex",
            detectedAt: "2026-07-26T20:00:00.000Z",
          } as DiscoverySnapshot["candidates"][number],
        ],
      }),
    });
    renderExpanded(<ProviderSettingsView {...props} />);

    await user.click(screen.getByRole("switch", { name: "Enable Detected Codex" }));

    expect(props.onSetEnabled).toHaveBeenCalledWith(id, true);
    expect(props.onProbe).toHaveBeenCalledWith(id);
    expect(props.onProbe).toHaveBeenCalledTimes(1);
  });

  it("renders the Bedrock Mantle setup guide only for an OpenAI-compatible endpoint", async () => {
    const user = userEvent.setup();
    renderExpanded(<ProviderSettingsView {...fixture()} />);
    expect(
      screen.queryByRole("heading", { name: "Amazon Bedrock Mantle setup" }),
    ).not.toBeInTheDocument();
    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Provider type"),
      "OpenAI-compatible HTTP",
    );
    expect(screen.getByRole("heading", { name: "Amazon Bedrock Mantle setup" })).toBeVisible();
    expect(screen.getByText(/mantle\.us-east-1\.amazonaws\.com\/v1/)).toBeVisible();
    expect(
      screen.getByText(/does not currently expose the full Bedrock Converse API/i),
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
      onChangeBinary={controller.changeBinary}
      onChangeClaudeConfiguration={controller.changeClaudeConfiguration}
      onChangeDevinConfiguration={controller.changeDevinConfiguration}
      onChangeKiloConfiguration={controller.changeKiloConfiguration}
      onChangePiConfiguration={controller.changePiConfiguration}
      onChangeOhMyPiConfiguration={controller.changeOhMyPiConfiguration}
      onChangeOllamaConfiguration={controller.changeOllamaConfiguration}
      onChangeMistralVibeConfiguration={controller.changeMistralVibeConfiguration}
      onChangeGrokConfiguration={controller.changeGrokConfiguration}
      onChangeOpenAiCompatibleConfiguration={controller.changeOpenAiCompatibleConfiguration}
      onChangeAnthropicCompatibleConfiguration={controller.changeAnthropicCompatibleConfiguration}
      onChangeAzureFoundryConfiguration={controller.changeAzureFoundryConfiguration}
      onChangeOpenAiImageConfiguration={controller.changeOpenAiImageConfiguration}
      onChangeGeminiImageConfiguration={controller.changeGeminiImageConfiguration}
      onClearProviderCredential={controller.clearProviderCredential}
      onBeginProviderAuthentication={controller.beginProviderAuthentication}
      onCompleteProviderAuthentication={controller.completeProviderAuthentication}
      onCreate={controller.create}
      onCreateClaude={controller.createClaude}
      onCreateMistralVibe={controller.createMistralVibe}
      onCreateGrok={controller.createGrok}
      onCreateOllama={controller.createOllama}
      onCreateOpenAiCompatible={controller.createOpenAiCompatible}
      onCreateAnthropicCompatible={controller.createAnthropicCompatible}
      onCreateAzureFoundry={controller.createAzureFoundry}
      onCreateOpenAiImage={controller.createOpenAiImage}
      onCreateGeminiImage={controller.createGeminiImage}
      onPermissionPersistenceChange={controller.updatePermissionPersistence}
      onProbe={controller.probe}
      onProviderOrderChange={controller.updateProviderOrder}
      onVerifyFoundryTools={controller.verifyFoundryTools}
      onProviderCredentialStatus={controller.providerCredentialStatus}
      onRemove={controller.remove}
      onRename={controller.rename}
      onRetry={controller.retry}
      onSetEnabled={controller.setEnabled}
      probingIds={controller.probingIds}
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
  setProviderCredential: OctantHostBridge["setProviderCredential"],
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
    setProviderCredential,
    setSidebarMaterialPreference: vi.fn(),
    subscribeResolvedMaterial: vi.fn(() => vi.fn()),
  };
}

function fixture(
  options: {
    observed?: ProviderObservedState;
    error?: string;
    instance?: ProviderInstance;
    credentialManagementAvailable?: boolean;
    discoverySnapshot?: DiscoverySnapshot;
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
    busy: false,
    ...(options.error ? { message: options.error } : {}),
    credentialManagementAvailable: options.credentialManagementAvailable ?? true,
    onCreate: vi.fn(async () => true),
    onCreateClaude: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateMistralVibe: vi.fn(async (_name, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onCreateGrok: vi.fn(async (_name, _configuration, credential) => {
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
    onRename: vi.fn(async () => true),
    onChangeBinary: vi.fn(async () => true),
    onChangeClaudeConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeDevinConfiguration: vi.fn(async () => true),
    onChangeKiloConfiguration: vi.fn(async () => true),
    onChangePiConfiguration: vi.fn(async () => true),
    onChangeOhMyPiConfiguration: vi.fn(async () => true),
    onChangeOllamaConfiguration: vi.fn(async () => true),
    onChangeMistralVibeConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
    onChangeGrokConfiguration: vi.fn(async (_id, _configuration, credential) => {
      credential.clear();
      return true;
    }),
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
    onProviderCredentialStatus: vi.fn(async () => "stored" as const),
    onClearProviderCredential: vi.fn(async () => true),
    onSetEnabled: vi.fn(async () => true),
    onRemove: vi.fn(async () => true),
    onProbe: vi.fn(async () => true),
    onVerifyFoundryTools: vi.fn(async () => true),
    onPermissionPersistenceChange: vi.fn(async () => true),
    onProviderOrderChange: vi.fn(async () => true),
    onAgentEligibleModelsChange: vi.fn(async () => true),
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
      nativeAttachments: "unavailable",
      nativeWebResearch: "unavailable",
      appManagedTools: "unavailable",
      citations: "unavailable",
    },
    observedAt: "2026-07-14T10:00:00.000Z" as never,
    ...patch,
  };
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
