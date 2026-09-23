import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeProviderInstanceId, type ProviderInstance } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DevinConfigurationForm,
  FxConfigurationForm,
  ProviderCreateForm,
  type ProviderCreateFormProps,
} from "./ProviderSettingsConfiguration";

function props(overrides: Partial<ProviderCreateFormProps> = {}): ProviderCreateFormProps {
  const callback = vi.fn(async () => true);
  return {
    busy: false,
    credentialManagementAvailable: true,
    onCreate: callback,
    onCreateAnthropicCompatible: callback,
    onCreateAzureFoundry: callback,
    onCreateBflImage: callback,
    onCreateClaude: callback,
    onCreateGemini: callback,
    onCreateGeminiImage: callback,
    onCreateGrok: callback,
    onCreateGlm: callback,
    onCreateCline: callback,
    onCreateIdeogramImage: callback,
    onCreateMistralVibe: callback,
    onCreateOllama: callback,
    onCreateOpenAiCompatible: callback,
    onCreateOpenAiImage: callback,
    onCreateQwen: callback,
    onCreateFx: callback,
    ...overrides,
  };
}

describe("ProviderCreateForm presentation limits", () => {
  it("offers dedicated and custom HTTP image providers without coding agents", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCreateForm
        {...props()}
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
    );

    await user.click(screen.getByRole("button", { name: "Add image provider" }));
    expect(screen.getByRole("heading", { name: "Custom endpoint or binary" })).toBeVisible();
    expect(screen.getByLabelText("Default model")).toBeVisible();

    await user.click(screen.getByLabelText("Provider type"));
    expect(screen.getAllByText("OpenAI Image").length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByRole("option", { name: "Gemini Image" })).toBeVisible();
    expect(await screen.findByRole("option", { name: "Black Forest Labs Image" })).toBeVisible();
    expect(await screen.findByRole("option", { name: "Ideogram Image" })).toBeVisible();
    expect(screen.queryByText("OpenCode CLI")).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "OpenAI-compatible HTTP" })).toBeVisible();
  });

  it("keeps image creation disabled when host credential storage is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCreateForm
        {...props({ credentialManagementAvailable: false })}
        allowedProviderTypes={["openai-image"]}
        initialProviderType="openai-image"
        triggerLabel="Add image provider"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add image provider" }));
    expect(screen.getByRole("button", { name: "Add OpenAI image profile" })).toBeDisabled();
    expect(screen.getByLabelText("API key")).toBeDisabled();
  });

  it("passes the image configuration and transient credential to the existing create lifecycle", async () => {
    const user = userEvent.setup();
    const onCreateOpenAiImage = vi.fn<ProviderCreateFormProps["onCreateOpenAiImage"]>(
      async (_name, configuration, credential) => {
        expect(configuration.defaultModel).toBe("gpt-image-2");
        expect(configuration.modelAllowlist).toEqual(["gpt-image-2", "gpt-image-1"]);
        expect(credential.value).toBe("secret");
        credential.clear();
        return true;
      },
    );
    render(
      <ProviderCreateForm
        {...props({ onCreateOpenAiImage })}
        allowedProviderTypes={["openai-image"]}
        initialProviderType="openai-image"
        triggerLabel="Add image provider"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add image provider" }));
    await user.type(screen.getByLabelText("Provider name"), "OpenAI Images");
    await user.type(screen.getByLabelText("Model allowlist"), "gpt-image-2, gpt-image-1");
    await user.type(screen.getByLabelText("Default model"), "gpt-image-2");
    await user.type(screen.getByLabelText("API key"), "secret");
    await user.click(screen.getByRole("button", { name: "Add OpenAI image profile" }));

    expect(onCreateOpenAiImage).toHaveBeenCalledTimes(1);
  });

  it("keeps image provider drafts when the authorized create operation fails", async () => {
    const user = userEvent.setup();
    const onCreateOpenAiImage = vi.fn<ProviderCreateFormProps["onCreateOpenAiImage"]>(
      async () => false,
    );
    render(
      <ProviderCreateForm
        {...props({ onCreateOpenAiImage })}
        allowedProviderTypes={["openai-image"]}
        initialProviderType="openai-image"
        triggerLabel="Add image provider"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add image provider" }));
    const name = screen.getByLabelText("Provider name");
    await user.type(name, "Unfinished image provider");
    await user.type(screen.getByLabelText("Model allowlist"), "gpt-image-2");
    await user.type(screen.getByLabelText("Default model"), "gpt-image-2");
    await user.type(screen.getByLabelText("API key"), "secret");
    await user.click(screen.getByRole("button", { name: "Add OpenAI image profile" }));

    expect(onCreateOpenAiImage).toHaveBeenCalledTimes(1);
    expect(name).toHaveValue("Unfinished image provider");
    expect(screen.getByLabelText("API key")).toHaveValue("secret");
  });

  it("keeps fx creation disabled when host credential storage is unavailable", async () => {
    const user = userEvent.setup();
    const onCreateFx = vi.fn(async () => true);
    render(
      <ProviderCreateForm
        {...props({ onCreateFx, credentialManagementAvailable: false })}
        allowedProviderTypes={["fx"]}
        initialProviderType="fx"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add provider manually" }));

    // fx has no provider-owned posture, so a host without credential storage
    // can never complete the create form.
    expect(screen.getByRole("button", { name: "Add fx" })).toBeDisabled();
    expect(onCreateFx).not.toHaveBeenCalled();
  });
});

describe("FxConfigurationForm", () => {
  it("submits the api-key posture without offering a provider-owned login", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    const instance: Extract<ProviderInstance, { driverKind: "fx" }> = {
      id: decodeProviderInstanceId("80000000-0000-4000-8000-0000000000f1"),
      displayName: "fx local",
      driverKind: "fx",
      configuration: {
        kind: "fx-acp",
        binaryPath: "/Users/example/.local/bin/fx",
        authentication: "api-key",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as never,
      createdAt: "2026-07-14T10:00:00.000Z" as never,
      updatedAt: "2026-07-14T10:00:00.000Z" as never,
    };

    render(
      <FxConfigurationForm
        credentialManagementAvailable
        disabled={false}
        instance={instance}
        onChange={onChange}
      />,
    );

    // fx's configuration carries exactly one authentication literal, so the
    // shared selector would submit a value the server refuses to decode.
    expect(screen.queryByLabelText("Authentication for fx local")).toBeNull();
    await user.clear(screen.getByLabelText("fx binary path for fx local"));
    await user.type(screen.getByLabelText("fx binary path for fx local"), "/opt/homebrew/bin/fx");
    await user.type(
      screen.getByLabelText(/Vercel AI Gateway API key.*for fx local/),
      "gateway-key",
    );
    await user.click(screen.getByRole("button", { name: "Save fx settings for fx local" }));

    expect(onChange).toHaveBeenCalledWith(
      instance.id,
      {
        kind: "fx-acp",
        binaryPath: "/opt/homebrew/bin/fx",
        authentication: "api-key",
      },
      expect.anything(),
    );
  });
});

describe("DevinConfigurationForm", () => {
  it("renders the binary path inside a setting row without changing its accessible name", () => {
    const instance: Extract<ProviderInstance, { driverKind: "devin" }> = {
      id: decodeProviderInstanceId("80000000-0000-4000-8000-0000000000d1"),
      displayName: "Devin local",
      driverKind: "devin",
      configuration: {
        kind: "devin-acp",
        binaryPath: "/Users/example/.local/bin/devin",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as never,
      createdAt: "2026-07-14T10:00:00.000Z" as never,
      updatedAt: "2026-07-14T10:00:00.000Z" as never,
    };
    const onChange = vi.fn(async () => true);

    render(<DevinConfigurationForm disabled={false} instance={instance} onChange={onChange} />);

    const row = document.querySelector(
      `[data-setting-id="provider-${String(instance.id)}-binary-path"]`,
    );
    expect(row).not.toBeNull();
    if (row === null) throw new Error("expected the Devin binary-path setting row");
    expect(row).toContainElement(screen.getByLabelText("Binary path for Devin local"));
  });
});
