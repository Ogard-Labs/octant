import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NextMessageSuggestionsSettings } from "./NextMessageSuggestionsSettings";

describe("Suggest my next message setting", () => {
  it("starts on in every mode and saves a mode turned off", async () => {
    const onChange = vi.fn();
    render(
      <NextMessageSuggestionsSettings
        focusedSetting={undefined}
        onChange={onChange}
        value={undefined}
      />,
    );
    for (const name of [
      "Suggest my next message",
      "Suggest my next message in chat",
      "Suggest my next message in work",
      "Suggest my next message in code",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeChecked();
    }
    await userEvent.click(screen.getByRole("switch", { name: "Suggest my next message in work" }));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, modes: ["chat", "code"] });
  });

  it("keeps the chosen modes when switched off, and greys them out", async () => {
    const onChange = vi.fn();
    render(
      <NextMessageSuggestionsSettings
        focusedSetting={undefined}
        onChange={onChange}
        value={{ enabled: true, modes: ["code"] }}
      />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Suggest my next message" }));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false, modes: ["code"] });
  });

  it("does not let a mode change while the switch is off", () => {
    render(
      <NextMessageSuggestionsSettings
        focusedSetting={undefined}
        onChange={vi.fn()}
        value={{ enabled: false, modes: ["chat"] }}
      />,
    );
    // Base UI marks a disabled switch with aria-disabled rather than the attribute.
    expect(screen.getByRole("switch", { name: "Suggest my next message in code" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
