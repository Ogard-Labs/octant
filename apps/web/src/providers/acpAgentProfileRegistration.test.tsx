import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AcpAgentProviderInstance } from "@octant/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";

// A throwaway profile that exists only in this test. Settings must offer,
// create, and configure it from the profile table alone.
vi.mock("@octant/contracts/acp-agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octant/contracts/acp-agent-profiles")>();
  const profiles = {
    ...actual.ACP_AGENT_PROFILES,
    "probe-agent": {
      name: "Probe Agent",
      executable: "probe-agent",
      versionProbeArgs: ["--version"],
      authentication: ["provider-owned", "api-key"],
      apiKeyLabel: "Probe API key",
      signInGuidance: "Run probe-agent login, then check the connection again.",
      bundledPluginSerial: 0x19,
    },
  } satisfies Readonly<Record<string, import("@octant/contracts").AcpAgentProfileDescriptor>>;
  const kinds = Object.keys(profiles);
  const isKind = (kind: string): kind is keyof typeof profiles => kinds.includes(kind);
  // The module's own lookups close over the shipped table, so the ones every
  // consumer calls are rebuilt over the extended table here.
  return {
    ...actual,
    ACP_AGENT_PROFILES: profiles,
    ACP_AGENT_KINDS: kinds,
    isAcpAgentKind: isKind,
    acpAgentProfile: (kind: string) => {
      if (!isKind(kind)) throw new Error(`no profile for ${kind}`);
      return profiles[kind];
    },
    acpAgentKindOfConfiguration: (kind: string) => {
      const agent = kind.replace(/-acp$/, "");
      if (!isKind(agent)) throw new Error(`no profile for ${kind}`);
      return agent;
    },
  };
});

// The DOM setup file already loaded the shipped contracts, so each test
// reloads the Settings modules over the extended table.
async function loadSettings() {
  vi.resetModules();
  const [contracts, domain, configuration, presentation] = await Promise.all([
    import("@octant/contracts"),
    import("@octant/domain"),
    import("./ProviderSettingsConfiguration"),
    import("./providerSettingsPresentation"),
  ]);
  return { contracts, domain, configuration, presentation };
}

let settings: Awaited<ReturnType<typeof loadSettings>>;

beforeEach(async () => {
  settings = await loadSettings();
});

function probeInstance(): AcpAgentProviderInstance {
  const instance = settings.contracts.decodeProviderInstance({
    id: "80000000-0000-4000-8000-0000000009a1",
    displayName: "Probe local",
    driverKind: "probe-agent",
    configuration: {
      kind: "probe-agent-acp",
      binaryPath: "/opt/homebrew/bin/probe-agent",
      authentication: "provider-owned",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
  });
  if (!settings.domain.isAcpAgentInstance(instance)) {
    throw new Error("expected an ACP agent instance");
  }
  return instance;
}

describe("a new ACP agent profile in Settings", () => {
  it("is offered and created through the shared form from its row alone", async () => {
    const user = userEvent.setup();
    const callback = vi.fn(async () => true);
    const onCreateAcpAgent = vi.fn(async () => true);
    const { ProviderCreateForm } = settings.configuration;
    render(
      <ProviderCreateForm
        busy={false}
        credentialManagementAvailable
        onCreate={callback}
        onCreateAcpAgent={onCreateAcpAgent}
        onCreateAnthropicCompatible={callback}
        onCreateAzureFoundry={callback}
        onCreateBflImage={callback}
        onCreateClaude={callback}
        onCreateGeminiImage={callback}
        onCreateIdeogramImage={callback}
        onCreateOllama={callback}
        onCreateOpenAiCompatible={callback}
        onCreateOpenAiImage={callback}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add provider manually" }));

    await chooseSelectFieldOption(user, screen.getByLabelText("Provider type"), "Probe Agent ACP");
    const form = screen.getByRole("form", { name: "Add Probe Agent provider" });
    await user.type(within(form).getByLabelText("Provider name"), "Probe local");
    await user.type(
      within(form).getByLabelText("Probe Agent binary"),
      "/opt/homebrew/bin/probe-agent",
    );
    expect(within(form).getByLabelText("Probe Agent binary")).toHaveAttribute(
      "placeholder",
      "/absolute/path/to/probe-agent",
    );
    expect(within(form).getByLabelText("Probe Agent authentication")).toHaveTextContent(
      "Provider CLI login (recommended)",
    );
    expect(within(form).getByText(/probe-agent login/)).toBeVisible();
    await user.click(within(form).getByRole("button", { name: "Add Probe Agent" }));

    expect(onCreateAcpAgent).toHaveBeenCalledWith(
      "Probe local",
      {
        kind: "probe-agent-acp",
        binaryPath: "/opt/homebrew/bin/probe-agent",
        authentication: "provider-owned",
      },
      expect.objectContaining({ value: "" }),
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("configures an instance through the shared card form with its own key label", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    const instance = probeInstance();
    const { AcpAgentConfigurationForm } = settings.configuration;
    render(
      <AcpAgentConfigurationForm
        credentialManagementAvailable
        disabled={false}
        instance={instance}
        onChange={onChange}
      />,
    );

    // The compiler knows only the shipped rows; only the mocked table knows this one.
    expect(settings.presentation.driverLabel(instance.driverKind)).toBe("Probe Agent");
    expect(screen.getByLabelText("probe-agent binary path for Probe local")).toHaveValue(
      "/opt/homebrew/bin/probe-agent",
    );
    await chooseSelectFieldOption(
      user,
      screen.getByLabelText("Probe Agent authentication for Probe local"),
      "Probe API key",
    );
    await user.type(screen.getByLabelText("Probe API key for Probe local"), "probe-key");
    await user.click(
      screen.getByRole("button", { name: "Save Probe Agent settings for Probe local" }),
    );

    expect(onChange).toHaveBeenCalledWith(
      instance.id,
      {
        kind: "probe-agent-acp",
        binaryPath: "/opt/homebrew/bin/probe-agent",
        authentication: "api-key",
      },
      expect.objectContaining({ value: "probe-key" }),
    );
  });
});
