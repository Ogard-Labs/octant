import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OpenInMenu } from "./OpenInMenu";

describe("OpenInMenu", () => {
  it("shows detected enabled applications in preference order and launches the selected one", async () => {
    const user = userEvent.setup();
    const openCodeCheckoutInApplication = vi.fn(async () => undefined);
    render(
      <OpenInMenu
        applications={["zed", "finder", "vscode"]}
        hostBridge={
          {
            listOpenInApplications: async () => [
              { id: "vscode", label: "VS Code", available: true },
              { id: "zed", label: "Zed", available: false },
              { id: "finder", label: "Finder", available: true },
            ],
            openCodeCheckoutInApplication,
          } as never
        }
        threadId="20000000-0000-4000-8000-000000000001"
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "Open checkout in an application. Default Finder",
    });
    await user.click(trigger);
    expect(screen.queryByRole("menuitem", { name: "Zed" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "VS Code" }));

    expect(openCodeCheckoutInApplication).toHaveBeenCalledWith({
      threadId: "20000000-0000-4000-8000-000000000001",
      applicationId: "vscode",
    });
  });
});
