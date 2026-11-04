import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_WORKSPACE_SERVICES } from "@octant/domain";
import { GoogleWorkspaceSetup } from "./GoogleWorkspaceSetup";

describe("Google Workspace connection setup", () => {
  it("explains the service's read permissions before accepting a Desktop client, without collecting a secret", async () => {
    const user = userEvent.setup();
    const configure = vi.fn(async () => ({ kind: "configured" as const }));
    const service = GOOGLE_WORKSPACE_SERVICES[0];
    if (service === undefined) throw new Error("Gmail profile missing");
    render(<GoogleWorkspaceSetup service={service} configure={configure} disabled={false} />);
    expect(screen.getByText(/Cannot draft, send, label, or delete/)).toBeVisible();
    expect(screen.getByText(/Developer Preview/)).toBeVisible();
    expect(screen.getByText(/AI-powered agent/)).toBeVisible();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
    await user.type(screen.getByLabelText("Desktop client ID"), "123-test.apps.googleusercontent.com");
    await user.click(screen.getByRole("button", { name: "Save Google setup" }));
    expect(configure).toHaveBeenCalledWith({ clientId: "123-test.apps.googleusercontent.com", redirectPort: 43125 });
  });

  it("retains the client ID and explains a configuration failure so the person can retry", async () => {
    const user = userEvent.setup();
    const configure = vi.fn(async () => ({ kind: "refused" as const, message: "The sign-in service is unavailable. Try again." }));
    const service = GOOGLE_WORKSPACE_SERVICES[0];
    if (service === undefined) throw new Error("Gmail profile missing");
    render(<GoogleWorkspaceSetup service={service} configure={configure} disabled={false} />);
    await user.type(screen.getByLabelText("Desktop client ID"), "123-test.apps.googleusercontent.com");
    await user.click(screen.getByRole("button", { name: "Save Google setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
    expect(screen.getByLabelText("Desktop client ID")).toHaveValue("123-test.apps.googleusercontent.com");
  });

  it("refuses an invalid client or callback port before saving setup", async () => {
    const user = userEvent.setup();
    const configure = vi.fn(async () => ({ kind: "configured" as const }));
    const service = GOOGLE_WORKSPACE_SERVICES[0];
    if (service === undefined) throw new Error("Gmail profile missing");
    render(<GoogleWorkspaceSetup service={service} configure={configure} disabled={false} />);
    await user.click(screen.getByRole("button", { name: "Save Google setup" }));
    expect(configure).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Desktop client ID")).toHaveAttribute("aria-invalid", "true");
  });
});
