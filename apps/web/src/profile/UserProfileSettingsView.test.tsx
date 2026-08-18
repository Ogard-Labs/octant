import type { UserProfile } from "@octant/contracts/user-profile";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserProfileSettingsView } from "./UserProfileSettingsView";

const empty: UserProfile = { accent: "indigo", avatar: { kind: "initials" } };
const stored: UserProfile = { displayName: "Ada", accent: "teal", avatar: { kind: "initials" } };

describe("UserProfileSettingsView", () => {
  it("adopts a profile the host loads while this view is already open", () => {
    const onSettingsChange = vi.fn();
    const view = render(
      <UserProfileSettingsView onSettingsChange={onSettingsChange} profile={empty} />,
    );

    // Another window wrote a profile, or a conflict forced a reload. Keeping
    // the draft from before would let the next settled edit put it back.
    view.rerender(<UserProfileSettingsView onSettingsChange={onSettingsChange} profile={stored} />);

    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
  });

  it("keeps an edit in progress rather than replacing it mid-typing", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const view = render(
      <UserProfileSettingsView onSettingsChange={onSettingsChange} profile={empty} />,
    );

    await user.type(screen.getByLabelText("Name"), "Grace");
    view.rerender(<UserProfileSettingsView onSettingsChange={onSettingsChange} profile={stored} />);

    expect(screen.getByLabelText("Name")).toHaveValue("Grace");
  });

  it("writes the profile only once an edit settles", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<UserProfileSettingsView onSettingsChange={onSettingsChange} profile={empty} />);

    await user.type(screen.getByLabelText("Name"), "Ada");
    expect(onSettingsChange).not.toHaveBeenCalled();

    await user.tab();
    expect(onSettingsChange).toHaveBeenCalledWith({
      userProfile: expect.objectContaining({ displayName: "Ada" }),
    });
  });
});
