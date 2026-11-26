import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CREDENTIAL_PASS_THROUGH_FACT,
  ProviderCredentialPassThroughSettings,
} from "./ProviderCredentialPassThroughSettings";

describe("ProviderCredentialPassThroughSettings", () => {
  it("starts with nothing let through and says what the list does", () => {
    render(<ProviderCredentialPassThroughSettings onChange={vi.fn()} value={{}} />);
    expect(
      screen.getByText("Nothing is added. Under Strict, each provider gets only its fixed list."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Let through under Strict" })).toBeVisible();
    expect(PROVIDER_CREDENTIAL_PASS_THROUGH_FACT).toBe(
      "Outside Strict, a provider already gets your environment. Under Strict it gets a short fixed list. Name a variable here, such as GH_TOKEN, to add it to that list for one provider. A model provider's key can never be added. Applies from the next turn. A provider terminal also runs your shell's startup files, which may set credentials again.",
    );
    expect(screen.getByText(PROVIDER_CREDENTIAL_PASS_THROUGH_FACT)).toBeVisible();
  });

  it("lets a named variable through to the chosen provider and lists it with its provider", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ProviderCredentialPassThroughSettings onChange={onChange} value={{}} />);
    await user.type(screen.getByLabelText("Variable to let through"), "GH_TOKEN");
    await user.click(screen.getByRole("button", { name: "Let through" }));
    expect(onChange).toHaveBeenCalledWith({ claude: ["GH_TOKEN"] });
  });

  it("lists each let-through variable with its provider and takes one back", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCredentialPassThroughSettings
        onChange={onChange}
        value={{ codex: ["GH_TOKEN", "NPM_TOKEN"] }}
      />,
    );
    expect(screen.getAllByText("Codex · Let through")).toHaveLength(2);
    await user.click(
      screen.getByRole("button", { name: "Stop letting GH_TOKEN through to Codex" }),
    );
    expect(onChange).toHaveBeenCalledWith({ codex: ["NPM_TOKEN"] });
  });

  it("offers OpenCode among the providers, whose Strict launch reads the list too", () => {
    render(
      <ProviderCredentialPassThroughSettings
        onChange={vi.fn()}
        value={{ opencode: ["GH_TOKEN"] }}
      />,
    );
    expect(screen.getByText("OpenCode · Let through")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Stop letting GH_TOKEN through to OpenCode" }),
    ).toBeVisible();
  });

  it("refuses a name that is not an environment variable or is one of Octant's own, and keeps the draft", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ProviderCredentialPassThroughSettings onChange={onChange} value={{}} />);
    const field = screen.getByLabelText("Variable to let through");
    await user.type(field, "OCTANT_DESKTOP_BRIDGE_SECRET");
    await user.click(screen.getByRole("button", { name: "Let through" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Octant's own variables never reach a provider.")).toBeVisible();
    expect(field).toHaveValue("OCTANT_DESKTOP_BRIDGE_SECRET");
  });

  it("refuses another model provider's key, which the launch never lets through, and keeps the draft", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ProviderCredentialPassThroughSettings onChange={onChange} value={{}} />);
    const field = screen.getByLabelText("Variable to let through");
    await user.type(field, "OPENAI_API_KEY");
    await user.click(screen.getByRole("button", { name: "Let through" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "This is a model provider's key. Under Strict a provider gets its own and no other provider's.",
      ),
    ).toBeVisible();
    expect(field).toHaveValue("OPENAI_API_KEY");
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses a name past the most one provider may let through, and keeps the draft", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const full = Array.from({ length: 64 }, (_, index) => `TOKEN_${index}`);
    render(<ProviderCredentialPassThroughSettings onChange={onChange} value={{ claude: full }} />);
    const field = screen.getByLabelText("Variable to let through");
    await user.type(field, "GH_TOKEN");
    await user.click(screen.getByRole("button", { name: "Let through" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("A provider can let at most 64 credentials through. Remove one first."),
    ).toBeVisible();
    expect(field).toHaveValue("GH_TOKEN");
  });

  it("says a provider terminal runs the person's shell startup files, which may set credentials again", () => {
    render(<ProviderCredentialPassThroughSettings onChange={vi.fn()} value={{}} />);
    expect(
      screen.getByText(
        /A provider terminal also runs your shell's startup files, which may set credentials again\./,
      ),
    ).toBeVisible();
  });
});
