import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderCreateForm, type ProviderCreateFormProps } from "./ProviderSettingsConfiguration";

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
    ...overrides,
  };
}

describe("ProviderCreateForm presentation limits", () => {
  it("opens directly on image providers and only offers image provider types", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCreateForm
        {...props()}
        allowedProviderTypes={[
          "openai-image",
          "gemini-native-image",
          "bfl-image",
          "ideogram-image",
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
    expect(screen.queryByText("OpenAI-compatible HTTP")).not.toBeInTheDocument();
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
});
