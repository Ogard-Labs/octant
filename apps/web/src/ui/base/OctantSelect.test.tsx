import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantSelectField } from "./OctantSelect";
import { OctantButton } from "./OctantButton";

describe("OctantSelectField", () => {
  it("chooses a labeled option and reports its id", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <OctantSelectField
        aria-label="Protocol preference"
        onValueChange={onValueChange}
        options={[
          { id: "auto", label: "Automatic" },
          { id: "messages", label: "Messages" },
        ]}
        value="auto"
      />,
    );

    expect(screen.getByRole("combobox", { name: "Protocol preference" })).toHaveTextContent(
      "Automatic",
    );
    await user.click(screen.getByRole("combobox", { name: "Protocol preference" }));
    await user.click(await screen.findByRole("option", { name: "Messages" }));
    expect(onValueChange).toHaveBeenCalledWith("messages");
  });

  it("keeps an empty option id for form filters and FormData", async () => {
    const user = userEvent.setup();
    let submitted = "";
    render(
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submitted = String(new FormData(event.currentTarget).get("quality") ?? "missing");
        }}
      >
        <OctantSelectField
          aria-label="Quality"
          defaultValue=""
          name="quality"
          options={[
            { id: "", label: "Provider default" },
            { id: "high", label: "high" },
          ]}
        />
        <OctantButton type="submit">Save</OctantButton>
      </form>,
    );

    expect(screen.getByRole("combobox", { name: "Quality" })).toHaveTextContent("Provider default");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(submitted).toBe("");

    await user.click(screen.getByRole("combobox", { name: "Quality" }));
    await user.click(await screen.findByRole("option", { name: "high" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(submitted).toBe("high");
  });

  it("restores the default option when the owning form resets", async () => {
    const user = userEvent.setup();
    render(
      <form noValidate>
        <OctantSelectField
          aria-label="Protocol preference"
          defaultValue="auto"
          name="protocol"
          options={[
            { id: "auto", label: "Automatic" },
            { id: "responses", label: "Responses" },
          ]}
        />
        <OctantButton type="reset">Reset</OctantButton>
      </form>,
    );

    await user.click(screen.getByRole("combobox", { name: "Protocol preference" }));
    await user.click(await screen.findByRole("option", { name: "Responses" }));
    expect(screen.getByRole("combobox", { name: "Protocol preference" })).toHaveTextContent(
      "Responses",
    );
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("combobox", { name: "Protocol preference" })).toHaveTextContent(
      "Automatic",
    );
  });
});
