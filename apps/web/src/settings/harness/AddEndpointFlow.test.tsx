import {
  LOCAL_HOST_ID,
  type HostPlatform,
  decodeProviderInstanceId,
  type NativeHarnessRoutingSettings,
  type ProviderModel,
  type ProviderObservedState,
} from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HostPlatformContext } from "../../platform";
import type { ModelToolCheck } from "../../providers/useProviderController";
import { chooseSelectFieldOption } from "../../test/chooseSelectFieldOption.test-support";
import { endpointPreset } from "./addEndpointSteps";
import { AddEndpointFlow, type AddEndpointFlowProps, type AddedEndpoint } from "./AddEndpointFlow";
import { EndpointChoices } from "./AddModelEndpoint";
import { endpointStatus, type EndpointStatus, type ModelEndpointInstance } from "./endpointStatus";

const id = decodeProviderInstanceId("80000000-0000-4000-8000-0000000004a7");
const READY: EndpointStatus = { tone: "ready", label: "Ready" };

function model(modelId: string, patch: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: modelId as never,
    displayName: modelId,
    source: "discovered",
    verification: "verified",
    reasoning: "supported",
    inputModalities: ["text"],
    options: [],
    ...patch,
  } as ProviderModel;
}

function observed(models: ReadonlyArray<ProviderModel>): ProviderObservedState {
  return {
    instanceId: id,
    readiness: "ready",
    processState: "running",
    models: [...models],
    capabilities: {} as ProviderObservedState["capabilities"],
    observedAt: "2026-10-09T10:00:00.000Z" as never,
  };
}

function endpoint(kind: ModelEndpointInstance["driverKind"], name = "Team gateway") {
  const base = {
    id,
    displayName: name,
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-10-09T10:00:00.000Z" as never,
    updatedAt: "2026-10-09T10:00:00.000Z" as never,
  } as const;
  if (kind === "azure-foundry") {
    return {
      ...base,
      driverKind: kind,
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://team.openai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "auto",
        manualModelIds: [],
      },
    } as ModelEndpointInstance;
  }
  if (kind === "ollama") {
    return {
      ...base,
      driverKind: kind,
      configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
    } as ModelEndpointInstance;
  }
  if (kind === "anthropic-compatible") {
    return {
      ...base,
      driverKind: kind,
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://relay.example/v1",
        authentication: "api-key",
        protocol: "auto",
        protocolVersion: "2023-06-01",
        manualModelIds: [],
      },
    } as ModelEndpointInstance;
  }
  return {
    ...base,
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
  } as ModelEndpointInstance;
}

const routingSettings: NativeHarnessRoutingSettings = {
  configuration: {
    slots: [
      {
        id: "default" as never,
        candidates: [
          {
            hostId: LOCAL_HOST_ID,
            providerInstanceId: decodeProviderInstanceId("80000000-0000-4000-8000-0000000004a8"),
            modelId: "older-model" as never,
          },
        ],
      },
    ],
    jobSlots: [],
  },
  version: 3 as never,
  updatedAt: "2026-10-09T10:00:00.000Z" as never,
};

type Overrides = Partial<AddEndpointFlowProps> & {
  /** The endpoint the registry lists once a create succeeds. */
  readonly creates?: ModelEndpointInstance;
  readonly observedAfterCreate?: ProviderObservedState;
  readonly statusAfterCreate?: EndpointStatus;
};

function flowProps(overrides: Overrides = {}): AddEndpointFlowProps {
  const clearing = vi.fn(
    async (_name: string, _configuration: unknown, credential: { clear(): void }) => {
      credential.clear();
      return true;
    },
  );
  return {
    busy: false,
    credentialManagementAvailable: true,
    defaults: { permissionPersistence: "current-session", version: 0 as never },
    added: undefined,
    onCreateOpenAiCompatible: clearing,
    onCreateAnthropicCompatible: clearing,
    onCreateAzureFoundry: clearing,
    onCreateAmazonBedrock: vi.fn(async () => true),
    onCreateOllama: vi.fn(async () => true),
    onChangeOpenAiCompatibleConfiguration: vi.fn(async () => true),
    onChangeAnthropicCompatibleConfiguration: vi.fn(async () => true),
    onChangeAzureFoundryConfiguration: vi.fn(async () => true),
    onHiddenModelsChange: vi.fn(async () => true),
    onAgentEligibleModelsChange: vi.fn(async () => true),
    onProbe: vi.fn(async () => true),
    onVerifyModelTools: vi.fn(async () => "supported" as const),
    onCheckModelTools: vi.fn(async (): Promise<ModelToolCheck> => ({ outcome: "supported" })),
    onOpenAdded: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  } as AddEndpointFlowProps;
}

/**
 * The flow with a stand-in registry: a create that succeeds lists `creates`,
 * with its observation, the way the settings page hands the new endpoint back.
 */
function Harness(props: { readonly flow: AddEndpointFlowProps; readonly overrides: Overrides }) {
  const [added, setAdded] = useState<AddedEndpoint | undefined>(props.flow.added);
  const listed = (created: boolean) => {
    if (created && props.overrides.creates !== undefined) {
      setAdded({
        instance: props.overrides.creates,
        observed: props.overrides.observedAfterCreate,
        status: props.overrides.statusAfterCreate ?? READY,
        checking: false,
      });
    }
    return created;
  };
  return (
    <AddEndpointFlow
      {...props.flow}
      added={added}
      onCreateAnthropicCompatible={async (...args) =>
        listed(await props.flow.onCreateAnthropicCompatible(...args))
      }
      onCreateAzureFoundry={async (...args) =>
        listed(await props.flow.onCreateAzureFoundry(...args))
      }
      onCreateAmazonBedrock={async (...args) =>
        listed(await props.flow.onCreateAmazonBedrock(...args))
      }
      onCreateOllama={async (...args) => listed(await props.flow.onCreateOllama(...args))}
      onCreateOpenAiCompatible={async (...args) =>
        listed(await props.flow.onCreateOpenAiCompatible(...args))
      }
    />
  );
}

/** Renders the flow against a host that reports `hostPlatform`, macOS unless named. */
function renderFlow(overrides: Overrides = {}, hostPlatform: HostPlatform = "darwin") {
  const flow = flowProps(overrides);
  render(
    <HostPlatformContext.Provider value={hostPlatform}>
      <Harness flow={flow} overrides={overrides} />
    </HostPlatformContext.Provider>,
  );
  return flow;
}

async function connect(
  user: ReturnType<typeof userEvent.setup>,
  kind: string,
  fields: { readonly name?: string; readonly url?: string; readonly key?: string },
) {
  await user.click(
    screen.getByRole("button", {
      name: new RegExp(`^${kind.replace(/[()]/g, (bracket) => `\\${bracket}`)}`),
    }),
  );
  const form = screen.getByRole("form", { name: `Connect ${kind}` });
  if (fields.name !== undefined) {
    await user.clear(within(form).getByLabelText("Name"));
    await user.type(within(form).getByLabelText("Name"), fields.name);
  }
  if (fields.url !== undefined) {
    const address = within(form).getByRole("textbox", { name: /address/i });
    await user.clear(address);
    await user.type(address, fields.url);
  }
  if (fields.key !== undefined) await user.type(within(form).getByLabelText("API key"), fields.key);
  return form;
}

describe("Add endpoint, step by step", () => {
  it("starts with five kinds of endpoint by their plain names", () => {
    renderFlow();

    const kinds = screen.getByRole("list", { name: "Kinds of endpoint" });
    expect(
      within(kinds)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      expect.stringMatching(/^Azure AI Foundry/),
      expect.stringMatching(/^Amazon Bedrock/),
      expect.stringMatching(/^OpenAI-compatible/),
      expect.stringMatching(/^Anthropic-compatible/),
      expect.stringMatching(/^Local \(Ollama\)/),
    ]);
  });

  it("asks for a name, address and key, with the protocol folded under Advanced", async () => {
    const user = userEvent.setup();
    renderFlow();
    const form = await connect(user, "OpenAI-compatible", {});

    expect(within(form).getByLabelText("Name")).toBeEnabled();
    expect(within(form).getByRole("textbox", { name: /address/i })).toBeEnabled();
    expect(within(form).getByLabelText("API key")).toBeEnabled();
    expect(within(form).getByLabelText("Protocol")).not.toBeVisible();
    // Nothing on the step is greyed out without a reason.
    expect(form.querySelectorAll("input:disabled, button:disabled")).toHaveLength(0);
  });

  it("creates an OpenAI-compatible endpoint with a write-only key and clears it", async () => {
    const user = userEvent.setup();
    const props = renderFlow();
    const form = await connect(user, "OpenAI-compatible", {
      name: "Team gateway",
      url: "https://gateway.example/v1",
      key: "private-value",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    expect(props.onCreateOpenAiCompatible).toHaveBeenCalledWith(
      "Team gateway",
      {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v1",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: [],
      },
      expect.objectContaining({ value: "private-value" }),
    );
    expect(within(form).getByLabelText("API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain("private-value");
  });

  it("sends no key for a server that takes none, chosen under Advanced", async () => {
    const user = userEvent.setup();
    const props = renderFlow();
    const form = await connect(user, "OpenAI-compatible", {
      name: "Local server",
      url: "http://127.0.0.1:8080/v1",
    });
    await user.click(within(form).getByText("Advanced"));
    await user.click(within(form).getByRole("checkbox", { name: /It takes no key/ }));
    expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    const [, configuration, credential] = vi.mocked(props.onCreateOpenAiCompatible).mock.calls[0]!;
    expect(configuration.authentication).toBe("none");
    expect(credential.value).toBe("");
  });

  it("creates an Anthropic-compatible endpoint that sends its key as x-api-key", async () => {
    const user = userEvent.setup();
    const props = renderFlow();
    const form = await connect(user, "Anthropic-compatible", {
      name: "Relay",
      url: "https://relay.example/v1",
      key: "anthropic-secret",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    const [name, configuration, credential] = vi.mocked(props.onCreateAnthropicCompatible).mock
      .calls[0]!;
    expect(name).toBe("Relay");
    expect(configuration).toMatchObject({
      authentication: "api-key",
      protocol: "auto",
      protocolVersion: "2023-06-01",
    });
    expect(credential.value).toBe("anthropic-secret");
  });

  it("suggests Azure AI Foundry when an OpenAI-compatible address is on Azure, keeping the name", async () => {
    const user = userEvent.setup();
    const props = renderFlow();
    await connect(user, "OpenAI-compatible", {
      name: "Team Azure",
      url: "https://team.openai.azure.com/openai/deployments/gpt/chat",
    });

    const suggestion = screen.getByTestId("endpoint-azure-suggestion");
    expect(suggestion).toHaveTextContent("This looks like an Azure AI Foundry address");
    await user.click(
      within(suggestion).getByRole("button", { name: "Switch to Azure AI Foundry" }),
    );

    const form = screen.getByRole("form", { name: "Connect Azure AI Foundry" });
    expect(within(form).getByLabelText("Name")).toHaveValue("Team Azure");
    expect(within(form).getByRole("textbox", { name: /address/i })).toHaveValue(
      "https://team.openai.azure.com/openai/v1/",
    );
    expect(screen.queryByTestId("endpoint-azure-suggestion")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("API key"), "azure-secret");
    await user.type(within(form).getByRole("textbox", { name: "Deployment name" }), "gpt-main");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    expect(props.onCreateAzureFoundry).toHaveBeenCalledWith(
      "Team Azure",
      expect.objectContaining({
        baseUrl: "https://team.openai.azure.com/openai/v1/",
        manualModelIds: ["gpt-main"],
      }),
      expect.objectContaining({ value: "azure-secret" }),
    );
  });

  it("adds an organization's gateway that signs in at its own issuer, with no key and nothing rewritten", async () => {
    const user = userEvent.setup();
    const props = renderFlow();
    const form = await connect(user, "OpenAI-compatible", {
      name: "Company gateway",
      url: "https://llm.example.test/v1/",
    });

    await chooseSelectFieldOption(
      user,
      within(form).getByLabelText("Sign in with"),
      "Organization account (your sign-in provider)",
    );
    expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("Issuer"), "http://login.example.test");
    await user.type(within(form).getByLabelText("Client ID"), "0oa1octantDesktop");
    await user.type(within(form).getByLabelText("Scope"), "openid");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    // An identity scope names no resource, and a sign-in page must be https.
    expect(screen.getByText(/the one scope your gateway requires/)).toBeVisible();
    expect(props.onCreateOpenAiCompatible).not.toHaveBeenCalled();

    const issuer = within(form).getByLabelText("Issuer");
    await user.clear(issuer);
    await user.type(issuer, " https://login.example.test/oauth2/Gateway/ ");
    const scope = within(form).getByLabelText("Scope");
    await user.clear(scope);
    await user.type(scope, "gateway.models");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    expect(props.onCreateOpenAiCompatible).toHaveBeenCalledWith(
      "Company gateway",
      {
        kind: "openai-compatible-http",
        baseUrl: "https://llm.example.test/v1/",
        authentication: "directory-oauth",
        protocol: "auto",
        manualModelIds: [],
        // The issuer is compared exactly with what its tokens name: trimmed,
        // never lowercased or stripped of its trailing slash.
        directory: {
          issuer: "https://login.example.test/oauth2/Gateway/",
          clientId: "0oa1octantDesktop",
          scope: "gateway.models",
        },
      },
      expect.objectContaining({ value: "" }),
    );
  });

  it("adds an Azure AI Foundry endpoint that signs in with the organization's account, with no key and the ids lowercased", async () => {
    const user = userEvent.setup();
    const props = renderFlow();
    const form = await connect(user, "Azure AI Foundry", {
      name: "Contoso Foundry",
      url: "https://contoso.openai.azure.com/openai/v1/",
    });

    await chooseSelectFieldOption(
      user,
      within(form).getByLabelText("Sign in with"),
      "Organization account (Microsoft Entra ID)",
    );
    expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();
    await user.type(
      within(form).getByRole("textbox", { name: "Deployment name" }),
      "gpt-main{Enter}",
    );
    await user.type(
      within(form).getByLabelText("Directory (tenant) ID"),
      "contoso.onmicrosoft.com",
    );
    await user.type(
      within(form).getByLabelText("Application (client) ID"),
      "0A1B2C3D-4E5F-4A6B-9C7D-8E9F0A1B2C3D",
    );
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    // A domain name would let the directory pick a tenant; only a GUID binds one.
    expect(screen.getByText(/each a GUID/)).toBeVisible();
    expect(props.onCreateAzureFoundry).not.toHaveBeenCalled();

    const tenant = within(form).getByLabelText("Directory (tenant) ID");
    await user.clear(tenant);
    await user.type(tenant, " 6F1C2D3E-4A5B-4C6D-8E7F-9A0B1C2D3E4F ");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    expect(props.onCreateAzureFoundry).toHaveBeenCalledWith(
      "Contoso Foundry",
      {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://contoso.openai.azure.com/openai/v1/",
        authentication: "directory-oauth",
        protocol: "auto",
        manualModelIds: ["gpt-main"],
        directory: {
          tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
          clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
        },
      },
      expect.objectContaining({ value: "" }),
    );
  });

  it("adds Amazon Bedrock by portal, account, role, and models with no key or address, and ends at its sign-in", async () => {
    const user = userEvent.setup();
    const configuration = {
      kind: "amazon-bedrock-converse-http",
      region: "us-west-2" as never,
      authentication: "cloud-iam",
      cloudIam: {
        startUrl: "https://contoso.awsapps.com/start" as never,
        ssoRegion: "us-east-1" as never,
        accountId: "123456789012" as never,
        roleName: "BedrockUser" as never,
      },
      manualModelIds: [
        "anthropic.claude-sonnet-4-20250514-v1:0" as never,
        "amazon.nova-pro-v1:0" as never,
      ],
    } as const;
    const instance: ModelEndpointInstance = {
      id,
      displayName: "Contoso Bedrock",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as never,
      createdAt: "2026-10-09T10:00:00.000Z" as never,
      updatedAt: "2026-10-09T10:00:00.000Z" as never,
      driverKind: "amazon-bedrock",
      configuration,
    };
    const props = renderFlow({
      creates: instance,
      statusAfterCreate: endpointStatus({
        instance,
        checking: false,
        hostPlatform: "darwin",
        observed: {
          ...observed([]),
          readiness: "unauthenticated",
          unauthenticatedReason: "missing",
        },
      }),
    });
    await user.click(screen.getByRole("button", { name: /^Amazon Bedrock/ }));
    const form = screen.getByRole("form", { name: "Connect Amazon Bedrock" });
    expect(
      within(screen.getByRole("list", { name: "Steps" }))
        .getAllByRole("listitem")
        .map((step) => step.textContent),
    ).toEqual(["1Kind", "2Connect"]);
    expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();
    expect(within(form).queryByRole("textbox", { name: /address/i })).not.toBeInTheDocument();
    await user.clear(within(form).getByLabelText("Name"));
    await user.type(within(form).getByLabelText("Name"), "Contoso Bedrock");
    await user.type(within(form).getByLabelText("Region"), "us-west-2");
    await user.type(within(form).getByLabelText("Access portal"), "https://contoso.example/start");
    await user.type(within(form).getByLabelText("Portal region"), "us-east-1");
    await user.type(within(form).getByLabelText("Account ID"), "1234-5678-9012");
    await user.type(within(form).getByLabelText("Role"), "BedrockUser");
    await user.type(
      within(form).getByLabelText("Model IDs"),
      "anthropic.claude-sonnet-4-20250514-v1:0, amazon.nova-pro-v1:0",
    );
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    // Only the cloud's own portal addresses are accepted, so a look-alike is refused here.
    expect(screen.getByText(/your organization's access portal/)).toBeVisible();
    expect(props.onCreateAmazonBedrock).not.toHaveBeenCalled();

    const portal = within(form).getByLabelText("Access portal");
    await user.clear(portal);
    // Pasted from the browser's address bar, with the page's trailing /#/.
    await user.type(portal, "https://contoso.awsapps.com/start/#/");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    expect(props.onCreateAmazonBedrock).toHaveBeenCalledWith("Contoso Bedrock", configuration);
    expect(await screen.findByText("Sign in to use")).toBeVisible();
    expect(
      screen.getByText(/run octant provider sign-in "Contoso Bedrock" and enter the code/),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(props.onProbe).toHaveBeenCalledWith(id, { quiet: true });
    // Its models were named on Connect, and checking their tools needs the sign-in.
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.getByRole("heading", { name: "Added Contoso Bedrock" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Steps" })).not.toBeInTheDocument();
  });

  it("does not suggest Azure for an ordinary address", async () => {
    const user = userEvent.setup();
    renderFlow();
    await connect(user, "OpenAI-compatible", { url: "https://gateway.example/v1" });
    expect(screen.queryByTestId("endpoint-azure-suggestion")).not.toBeInTheDocument();
  });

  it("names Azure deployments as chips and saves them before checking tools", async () => {
    const user = userEvent.setup();
    const props = renderFlow({
      creates: {
        ...endpoint("azure-foundry", "Team Azure"),
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: "https://team.openai.azure.com/openai/v1/",
          authentication: "api-key",
          protocol: "auto",
          manualModelIds: ["gpt-main" as never],
        },
      } as ModelEndpointInstance,
    });
    const form = await connect(user, "Azure AI Foundry", {
      name: "Team Azure",
      url: "https://team.openai.azure.com/openai/v1/",
      key: "azure-secret",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    // The host lists base models rather than deployments, so one is needed up front.
    expect(screen.getByText("Name at least one deployment.")).toBeVisible();
    expect(props.onCreateAzureFoundry).not.toHaveBeenCalled();
    await user.type(
      within(form).getByRole("textbox", { name: "Deployment name" }),
      "gpt-main{Enter}",
    );
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    expect(props.onCreateAzureFoundry).toHaveBeenCalledWith(
      "Team Azure",
      expect.objectContaining({ manualModelIds: ["gpt-main"] }),
      expect.objectContaining({ value: "azure-secret" }),
    );
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    const input = screen.getByRole("textbox", { name: "Deployment name" });
    await user.type(input, "gpt-small");
    await user.click(screen.getByRole("button", { name: "Add deployment" }));
    await user.type(input, "typo{Enter}");
    const chips = screen.getByRole("list", { name: "Deployments" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["gpt-main", "gpt-small", "typo"]);
    await user.click(within(chips).getByRole("button", { name: "Remove deployment typo" }));
    await user.click(
      screen.getByRole("button", { name: "Continue and verify tools (2 requests)" }),
    );

    expect(props.onChangeAzureFoundryConfiguration).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ manualModelIds: ["gpt-main", "gpt-small"] }),
      expect.objectContaining({ value: "" }),
    );
    expect(props.onProbe).toHaveBeenCalledWith(id, { quiet: true });
    expect(await screen.findByRole("heading", { name: "Verify tools" })).toBeVisible();
  });

  it("searches a long catalogue without listing all of it, and adds a model by ID", async () => {
    const user = userEvent.setup();
    const catalogue = Array.from({ length: 40 }, (_, index) => model(`vendor/model-${index}`));
    const props = renderFlow({
      creates: endpoint("openai-compatible"),
      observedAfterCreate: observed(catalogue),
    });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Router",
      url: "https://router.example/v1",
      key: "k",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    const list = screen.getByRole("list", { name: "Models" });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(8);
    expect(
      within(list)
        .getAllByRole("checkbox")
        .every((box) => !(box as HTMLInputElement).checked),
    ).toBe(true);
    expect(screen.getByText("32 more match. Search to narrow the list.")).toBeVisible();

    await user.type(screen.getByRole("searchbox", { name: "Search 40 models" }), "model-37");
    expect(within(list).getAllByRole("checkbox")).toHaveLength(1);
    await user.click(within(list).getByRole("checkbox", { name: "vendor/model-37" }));

    await user.type(screen.getByRole("textbox", { name: "Model ID" }), "private/unlisted");
    await user.click(screen.getByRole("button", { name: "Add by ID" }));
    expect(within(list).getByRole("checkbox", { name: /private\/unlisted/ })).toBeChecked();

    await user.click(
      screen.getByRole("button", { name: "Continue and verify tools (2 requests)" }),
    );
    expect(props.onChangeOpenAiCompatibleConfiguration).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ manualModelIds: ["private/unlisted"] }),
      expect.objectContaining({ value: "" }),
    );
    // The 39 models left unchosen stay out of the model picker.
    const [hidden] = vi.mocked(props.onHiddenModelsChange).mock.calls[0]!;
    expect(hidden).toHaveLength(39);
    expect(hidden.some((ref) => String(ref.modelId) === "vendor/model-37")).toBe(false);
  });

  it("moves focus to the result when Check and add replaces the form", async () => {
    const user = userEvent.setup();
    renderFlow({ creates: endpoint("openai-compatible") });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Router",
      url: "https://router.example/v1",
      key: "k",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /^Added / })).toHaveFocus());
  });

  it("stays on Models with a way to retry when hiding the unchosen models is refused", async () => {
    const user = userEvent.setup();
    const props = renderFlow({
      creates: endpoint("openai-compatible"),
      observedAfterCreate: observed([model("vendor/a"), model("vendor/b")]),
      onHiddenModelsChange: vi.fn(async () => false),
    });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Router",
      url: "https://router.example/v1",
      key: "k",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("checkbox", { name: "vendor/a" }));
    await user.click(screen.getByRole("button", { name: /^Continue and verify tools/ }));

    expect(props.onHiddenModelsChange).toHaveBeenCalled();
    expect(
      await screen.findByText("Octant couldn't hide the models you left out. Try again."),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Verify tools" })).not.toBeInTheDocument();
  });

  it("offers the fix for an added endpoint that needs its key before going on", async () => {
    const user = userEvent.setup();
    const props = renderFlow({
      creates: endpoint("openai-compatible"),
      statusAfterCreate: {
        tone: "needs-you",
        label: "Needs key",
        sentence: "Add its API key.",
        fix: { kind: "add-key", label: "Add key" },
      },
    });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Router",
      url: "https://router.example/v1",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    await user.click(await screen.findByRole("button", { name: "Open details to fix" }));

    expect(props.onOpenAdded).toHaveBeenCalledWith("key");
  });

  it("lists Ollama's installed models with no Add by ID and verifies each one's tools locally", async () => {
    const user = userEvent.setup();
    const props = renderFlow({
      creates: endpoint("ollama", "Ollama"),
      observedAfterCreate: observed([model("llama3.2"), model("qwen3")]),
      onCheckModelTools: vi.fn(async (_instance, modelId) => ({
        outcome: String(modelId) === "qwen3" ? ("supported" as const) : ("unsupported" as const),
      })),
    });
    const form = await connect(user, "Local (Ollama)", {});
    expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    expect(props.onCreateOllama).toHaveBeenCalledWith("Ollama", {
      kind: "ollama-native-http",
      baseUrl: "http://127.0.0.1:11434",
    });
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    const installed = screen.getByRole("list", { name: "Installed models" });
    expect(within(installed).getAllByRole("checkbox", { checked: true })).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: "Model ID" })).not.toBeInTheDocument();
    expect(screen.getByText(/which Ollama runs on this computer/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Continue and verify tools (2 requests)" }),
    );

    const checks = await screen.findByRole("list", { name: "Tool checks" });
    expect(await within(checks).findByText("Verified")).toBeVisible();
    expect(within(checks).getAllByText("Chat only")).toHaveLength(1);
    expect(within(checks).getByText(/Ollama says it can't use tools/)).toBeVisible();
    expect(
      within(checks).getByRole("button", { name: "Retry the tool check for llama3.2" }),
    ).toBeVisible();
    expect(props.onCheckModelTools).toHaveBeenCalledTimes(2);
  });

  async function reachVerify(
    user: ReturnType<typeof userEvent.setup>,
    check: (modelId: string) => Promise<ModelToolCheck>,
    extra: Overrides = {},
  ) {
    const props = renderFlow({
      creates: endpoint("openai-compatible"),
      observedAfterCreate: observed([model("good-model"), model("chatty-model")]),
      onCheckModelTools: vi.fn(async (_instance, modelId) => check(String(modelId))),
      ...extra,
    });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Team gateway",
      url: "https://gateway.example/v1",
      key: "k",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(
      screen.getByRole("button", { name: "Continue and verify tools (2 requests)" }),
    );
    return props;
  }

  it("checks each model's tools, says why one stays Chat only, and retries it", async () => {
    const user = userEvent.setup();
    let chattyCalls = 0;
    const props = await reachVerify(user, async (modelId) => {
      if (modelId === "good-model") return { outcome: "supported" };
      chattyCalls += 1;
      return chattyCalls === 1 ? { outcome: "unsupported" } : { outcome: "supported" };
    });

    const checks = screen.getByRole("list", { name: "Tool checks" });
    await waitFor(() => expect(within(checks).getByText("Verified")).toBeVisible());
    expect(within(checks).getByText("Chat only")).toBeVisible();
    expect(
      within(checks).getByText("It answered without calling Octant's test tool."),
    ).toBeVisible();
    // One request at a time, in the order the models were chosen.
    expect(vi.mocked(props.onCheckModelTools!).mock.calls.map(([, modelId]) => modelId)).toEqual([
      "good-model",
      "chatty-model",
    ]);

    await user.click(
      within(checks).getByRole("button", { name: "Retry the tool check for chatty-model" }),
    );
    await waitFor(() => expect(within(checks).getAllByText("Verified")).toHaveLength(2));
  });

  it("never lets a failed tool check stop the endpoint being added", async () => {
    const user = userEvent.setup();
    const props = await reachVerify(user, async () => ({
      outcome: "failed",
      failure: {
        category: "unavailable",
        message: "The provider endpoint could not be reached.",
        failedAt: "2026-10-09T10:00:00.000Z",
      },
    }));

    const checks = screen.getByRole("list", { name: "Tool checks" });
    await waitFor(() =>
      expect(within(checks).getAllByText("The service didn't answer the check.")).toHaveLength(2),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("heading", { name: "Added Team gateway" })).toBeVisible();
    expect(screen.getByText(/2 Chat only/)).toBeVisible();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("offers agent work and roles to verified models only, saved with the roles' version", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn(async () => ({
      kind: "routing-settings" as const,
      settings: routingSettings,
    }));
    const props = await reachVerify(
      user,
      async (modelId) =>
        modelId === "good-model" ? { outcome: "supported" } : { outcome: "unsupported" },
      {
        roles: {
          client: { routing: vi.fn(async () => routingSettings), updateRouting },
          hostId: LOCAL_HOST_ID,
        },
        onRolesSaved: vi.fn(),
      },
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const good = screen.getByRole("checkbox", { name: "Helper agents can use good-model" });
    const chatty = screen.getByRole("checkbox", { name: "Helper agents can use chatty-model" });
    expect(good).toBeEnabled();
    expect(chatty).toBeDisabled();
    expect(chatty).toHaveAccessibleDescription(/Chat only models can't take agent work/);

    const main = await screen.findByRole("combobox", { name: "Main model" });
    await user.click(main);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Keep older-model", "good-model"]);
    await user.click(screen.getByRole("option", { name: "good-model" }));
    await user.click(good);
    await user.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() =>
      expect(props.onAgentEligibleModelsChange).toHaveBeenCalledWith([
        { providerInstanceId: id, modelId: "good-model" },
      ]),
    );
    expect(updateRouting).toHaveBeenCalledWith({
      expectedVersion: 3,
      configuration: {
        jobSlots: [],
        slots: [
          {
            id: "default",
            candidates: [
              { hostId: LOCAL_HOST_ID, providerInstanceId: id, modelId: "good-model" },
              routingSettings.configuration.slots[0]!.candidates[0],
            ],
          },
        ],
      },
    });
    expect(await screen.findByRole("heading", { name: "Added Team gateway" })).toBeVisible();
    // The roles panel reads the table again rather than keep the version it had.
    expect(props.onRolesSaved).toHaveBeenCalledOnce();
  });

  it("reloads the roles and asks again when they changed elsewhere", async () => {
    const user = userEvent.setup();
    const routing = vi.fn(async () => routingSettings);
    await reachVerify(user, async () => ({ outcome: "supported" }), {
      roles: {
        client: {
          routing,
          updateRouting: vi.fn(async () => ({
            kind: "routing-refused" as const,
            reason: "stale-version" as const,
            message: "Stale.",
          })),
        },
        hostId: LOCAL_HOST_ID,
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("combobox", { name: "Planning" }));
    await user.click(await screen.findByRole("option", { name: "good-model" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(
      await screen.findByText("Model roles changed elsewhere. Octant reloaded them; choose again."),
    ).toBeVisible();
    expect(routing).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
  });

  it("says a model stayed Chat only because its endpoint needs a key", async () => {
    const user = userEvent.setup();
    renderFlow({
      credentialManagementAvailable: false,
      creates: {
        ...endpoint("azure-foundry", "Team Azure"),
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: "https://team.openai.azure.com/openai/v1/",
          authentication: "api-key",
          protocol: "auto",
          manualModelIds: ["gpt-main" as never],
        },
      } as ModelEndpointInstance,
      statusAfterCreate: {
        tone: "needs-you",
        label: "Needs key",
        sentence: "Add its API key in the Octant desktop app on this Mac.",
      },
      // The host answers a keyless check with its generic failure.
      onCheckModelTools: vi.fn(
        async (): Promise<ModelToolCheck> => ({
          outcome: "failed",
          failure: {
            category: "unavailable",
            message: "Octant Provider service is unavailable.",
            failedAt: "2026-10-09T10:00:00.000Z",
          },
        }),
      ),
    });
    const form = await connect(user, "Azure AI Foundry", {
      name: "Team Azure",
      url: "https://team.openai.azure.com/openai/v1/",
    });
    await user.type(within(form).getByRole("textbox", { name: "Deployment name" }), "gpt-main");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    expect(await screen.findByText("Needs key")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue and verify tools (1 request)" }));

    expect(
      await screen.findByText("It needs its API key, which you add in the Octant desktop app."),
    ).toBeVisible();
  });

  it("saves an endpoint that needs a key without one in a browser, and says the key comes later", async () => {
    const user = userEvent.setup();
    const props = renderFlow({ credentialManagementAvailable: false });
    const form = await connect(user, "Azure AI Foundry", {
      name: "Team Azure",
      url: "https://team.openai.azure.com/openai/v1/",
    });

    expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();
    expect(within(form).getByTestId("endpoint-key-later")).toHaveTextContent(
      "Add it now and it shows Needs key; then add the key in the Octant desktop app on this Mac.",
    );
    await user.type(within(form).getByRole("textbox", { name: "Deployment name" }), "gpt-main");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    expect(props.onCreateAzureFoundry).toHaveBeenCalledWith(
      "Team Azure",
      expect.objectContaining({ kind: "azure-foundry-openai-http" }),
      expect.objectContaining({ value: "" }),
    );
  });

  it("names a Linux host's credential store, not this Mac's Keychain, where the key is kept", async () => {
    const user = userEvent.setup();
    // The window says Mac; the host that keeps the key runs Linux.
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      renderFlow({}, "linux");
      const form = await connect(user, "Azure AI Foundry", {});
      expect(
        within(form).getByText(
          "Saved in this computer's credential store. Octant can't show it again.",
        ),
      ).toBeVisible();
      expect(within(form).queryByText(/Keychain|this Mac/)).not.toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(window.navigator, "platform");
    }
  });

  it("tells a browser on a Linux host the key is added on this computer", async () => {
    const user = userEvent.setup();
    renderFlow({ credentialManagementAvailable: false }, "linux");
    const form = await connect(user, "Azure AI Foundry", {});
    expect(within(form).getByTestId("endpoint-key-later")).toHaveTextContent(
      "then add the key in the Octant desktop app on this computer.",
    );
  });
});

describe("Add endpoint presets", () => {
  it("fills in OpenCode Go's name, address and protocol from its row, and links to where the key is made", async () => {
    const user = userEvent.setup();
    const props = renderFlow({
      signIns: (flow) => (
        <EndpointChoices
          credentialManagementAvailable
          disabled={false}
          onAddWithKey={flow.choosePreset}
          onSignIn={vi.fn()}
        />
      ),
    });
    await user.click(screen.getByRole("button", { name: "Add with key, OpenCode Go" }));

    const form = screen.getByRole("form", { name: "Connect OpenCode Go" });
    expect(within(form).getByLabelText("Name")).toHaveValue("OpenCode Go");
    expect(within(form).getByRole("textbox", { name: /address/i })).toHaveValue(
      "https://opencode.ai/inference/go/v1",
    );
    expect(within(form).getByRole("link", { name: "the OpenCode console" })).toHaveAttribute(
      "href",
      "https://opencode.ai/console/go",
    );
    await user.type(within(form).getByLabelText("API key"), "private-value");
    await user.click(within(form).getByRole("button", { name: "Check and add" }));

    expect(props.onCreateOpenAiCompatible).toHaveBeenCalledWith(
      "OpenCode Go",
      {
        kind: "openai-compatible-http",
        baseUrl: "https://opencode.ai/inference/go/v1",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: [],
      },
      expect.objectContaining({ value: "private-value" }),
    );
  });

  it("opens on Connect, filled in, for a preset chosen on the page", () => {
    renderFlow({ initialPreset: endpointPreset("mistral") });
    const form = screen.getByRole("form", { name: "Connect Mistral" });
    expect(within(form).getByRole("textbox", { name: /address/i })).toHaveValue(
      "https://api.mistral.ai/v1",
    );
    expect(screen.queryByRole("list", { name: "Kinds of endpoint" })).not.toBeInTheDocument();
  });

  it("links to where a preset's key is made even where the browser cannot store keys", () => {
    renderFlow({ credentialManagementAvailable: false, initialPreset: endpointPreset("mistral") });
    const form = screen.getByRole("form", { name: "Connect Mistral" });
    expect(within(form).getByTestId("endpoint-key-later")).toBeVisible();
    expect(
      within(form).getByRole("link", { name: endpointPreset("mistral").keyPage.label }),
    ).toHaveAttribute("href", endpointPreset("mistral").keyPage.url);
  });
});

describe("voice models on a new endpoint", () => {
  it("offers a listed transcription model to Voice on the last step, in one click", async () => {
    const user = userEvent.setup();
    const onUseForTranscription = vi.fn(async () => true);
    renderFlow({
      creates: endpoint("openai-compatible"),
      observedAfterCreate: observed([model("gpt-4.1"), model("whisper-1")]),
      voice: { settings: undefined, onUseForTranscription, onOpenVoice: vi.fn() },
    });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Team gateway",
      url: "https://gateway.example/v1",
      key: "k",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    const tip = await screen.findByTestId("voice-tip");
    expect(tip).toHaveTextContent("This endpoint has voice models.");
    expect(tip).toHaveTextContent("whisper-1 can turn your speech into text.");
    await user.click(within(tip).getByRole("button", { name: "Use for Transcription" }));
    expect(onUseForTranscription).toHaveBeenCalledWith(id, "whisper-1");
  });

  it("offers no voice tip for an endpoint Voice could not use, even when it lists a voice model", async () => {
    const user = userEvent.setup();
    renderFlow({
      creates: { ...endpoint("openai-compatible"), enabled: false } as ModelEndpointInstance,
      observedAfterCreate: observed([model("gpt-4.1"), model("whisper-1")]),
      voice: { settings: undefined, onUseForTranscription: vi.fn(), onOpenVoice: vi.fn() },
    });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Team gateway",
      url: "https://gateway.example/v1",
      key: "k",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.queryByTestId("voice-tip")).not.toBeInTheDocument();
  });

  it("says nothing about voice when the endpoint lists no voice model", async () => {
    const user = userEvent.setup();
    renderFlow({
      creates: endpoint("openai-compatible"),
      observedAfterCreate: observed([model("gpt-4.1")]),
      voice: { settings: undefined, onUseForTranscription: vi.fn(), onOpenVoice: vi.fn() },
    });
    const form = await connect(user, "OpenAI-compatible", {
      name: "Team gateway",
      url: "https://gateway.example/v1",
      key: "k",
    });
    await user.click(within(form).getByRole("button", { name: "Check and add" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.queryByTestId("voice-tip")).not.toBeInTheDocument();
  });
});
