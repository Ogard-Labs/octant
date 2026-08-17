import type { UserProfile } from "@octant/contracts/user-profile";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProfileEditor } from "./ProfileEditor";
import type { AvatarImageEnvironment } from "./avatarImage";

const empty: UserProfile = { accent: "indigo", avatar: { kind: "initials" } };
const encoded = "data:image/webp;base64,AAAA";

function environment(overrides: Partial<AvatarImageEnvironment> = {}): AvatarImageEnvironment {
  return {
    decode: vi.fn(async () => ({ width: 200, height: 200 })),
    encode: vi.fn(async () => ({ dataUrl: encoded })),
    fetch: vi.fn(async () => new Response("binary", { status: 200 })),
    digest: vi.fn(async () => "hashed"),
    ...overrides,
  };
}

/** Controlled harness: the editor is controlled, so a parent has to hold state. */
function Harness(props: {
  readonly initial?: UserProfile;
  readonly onCommit?: (profile: UserProfile) => void;
  readonly environment?: AvatarImageEnvironment;
}) {
  const [profile, setProfile] = useState<UserProfile>(props.initial ?? empty);
  return (
    <ProfileEditor
      environment={props.environment ?? environment()}
      onChange={setProfile}
      profile={profile}
      {...(props.onCommit === undefined ? {} : { onCommit: props.onCommit })}
    />
  );
}

describe("ProfileEditor", () => {
  it("treats an untouched profile as valid and shows a neutral avatar", () => {
    render(<Harness />);

    // No name means no invented initial: the avatar says nothing rather than
    // showing a letter the user never gave.
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Email (optional)")).toHaveValue("");
  });

  it("commits a settled edit once, not on every keystroke", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.type(screen.getByLabelText("Name"), "Ada");
    expect(onCommit).not.toHaveBeenCalled();

    await user.tab();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Ada" }));
  });

  it("lets an ordinary two-word name be typed", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    // The stored name is trimmed, so a field showing the stored value loses the
    // space the moment it is typed and no multi-word name can be entered at all.
    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace");

    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Ada Lovelace" }));
  });

  it("will not store a name longer than the contract accepts, and says why", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.click(screen.getByLabelText("Name"));
    await user.paste("A".repeat(65));
    await user.tab();

    // Storing it would fail when the settings replacement is decoded, long
    // after the user left the field that caused it.
    expect(screen.getByText("That name is 65 characters. Octant stores at most 64.")).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("adopts a profile that arrives after the fields were first shown", () => {
    const stored: UserProfile = {
      displayName: "Ada",
      email: "ada@example.com",
      accent: "indigo",
      avatar: { kind: "initials" },
    };
    const view = render(<ProfileEditor onChange={vi.fn()} profile={empty} />);

    // A store still loading hands over the empty profile first. Keeping the
    // fields empty afterwards would show a name the host does not hold.
    view.rerender(<ProfileEditor onChange={vi.fn()} profile={stored} />);

    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Email (optional)")).toHaveValue("ada@example.com");
  });

  it("treats tabbing through an untouched field as no edit at all", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.click(screen.getByLabelText("Name"));
    await user.tab();
    await user.tab();

    // Otherwise every surface downstream persists a settings replacement
    // identical to the one it already held.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("will not store an address that cannot be one, and says why", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.type(screen.getByLabelText("Email (optional)"), "ada@example");
    await user.tab();

    expect(screen.getByText("That does not look like an email address yet.")).toBeVisible();
    expect(screen.getByLabelText("Email (optional)")).toHaveAttribute("aria-invalid", "true");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("stops reporting an address once the user has typed on past it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProfileEditor onChange={onChange} profile={{ ...empty, email: "ada@example.com" }} />);

    await user.type(screen.getByLabelText("Email (optional)"), "@");

    // An owner left holding the last value that happened to parse would persist
    // an address the field no longer shows and the user did not choose.
    expect(onChange).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ email: expect.anything() }),
    );
  });

  it("offers Gravatar only once an address has been entered", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Gravatar is the one thing here that leaves this Mac, so it is never
    // offered from anything the host merely happens to know.
    expect(screen.getByRole("button", { name: "Use Gravatar" })).toBeDisabled();

    await user.type(screen.getByLabelText("Email (optional)"), "ada@example.com");
    expect(screen.getByRole("button", { name: "Use Gravatar" })).toBeEnabled();
  });

  it("says that choosing Gravatar contacts gravatar.com", () => {
    render(<Harness />);

    expect(screen.getByText(/sends a hash of it to gravatar.com once/)).toBeVisible();
  });

  it("imports a Gravatar and records where the picture came from", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.type(screen.getByLabelText("Email (optional)"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Use Gravatar" }));
    await screen.findByText("Gravatar imported and saved on this Mac.");

    // The address typed immediately before the import survives it: the commit
    // must not rebuild the profile from the render the import started in.
    expect(onCommit).toHaveBeenLastCalledWith({
      accent: "indigo",
      email: "ada@example.com",
      avatar: { kind: "image", source: "gravatar", dataUrl: encoded },
    });
  });

  it("keeps the current avatar when an import fails, and reports the reason", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <Harness
        environment={environment({
          fetch: vi.fn(async () => new Response(null, { status: 404 })),
        })}
        onCommit={onCommit}
      />,
    );

    await user.type(screen.getByLabelText("Email (optional)"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Use Gravatar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That address has no Gravatar");
    expect(onCommit).not.toHaveBeenCalledWith(
      expect.objectContaining({ avatar: expect.objectContaining({ kind: "image" }) }),
    );
  });

  it("lets a picture be replaced by initials again", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <Harness
        initial={{
          ...empty,
          avatar: { kind: "image", source: "upload", dataUrl: encoded },
        }}
        onCommit={onCommit}
      />,
    );

    // A colour is only meaningful for the initials avatar, so it is not
    // offered while a picture is in use.
    expect(screen.queryByRole("radiogroup")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Use initials" }));

    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({ avatar: { kind: "initials" } }),
    );
    expect(screen.getByRole("radiogroup")).toBeVisible();
  });

  it("records an accent choice immediately", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.click(screen.getByRole("radio", { name: "Teal" }));

    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ accent: "teal" }));
  });
});
