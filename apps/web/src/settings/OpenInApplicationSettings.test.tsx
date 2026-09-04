import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OpenInApplicationSettings } from "./OpenInApplicationSettings";

describe("OpenInApplicationSettings", () => {
  it("configures enabled applications and their order from the detected catalogue", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <OpenInApplicationSettings
        applications={["vscode", "finder"]}
        hostBridge={
          {
            listOpenInApplications: async () => [
              { id: "vscode", label: "VS Code", available: true },
              { id: "finder", label: "Finder", available: true },
              { id: "zed", label: "Zed", available: false },
            ],
          } as never
        }
        onChange={onChange}
      />,
    );

    expect(await screen.findAllByText("Installed")).toHaveLength(2);
    expect(screen.getByRole("switch", { name: "Zed" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("switch", { name: "VS Code" }));
    expect(onChange).toHaveBeenCalledWith(["finder"]);

    await user.click(screen.getByRole("button", { name: "Move Finder up" }));
    expect(onChange).toHaveBeenLastCalledWith(["finder", "vscode"]);
  });
});
