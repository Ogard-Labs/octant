import type { UserProfile } from "@octant/contracts/user-profile";
import { avatarInitials } from "@octant/domain";
import { UserRound } from "lucide-react";
import "./profile.css";

export interface UserAvatarProps {
  readonly profile: UserProfile;
  /** Rendered square, in pixels. */
  readonly size?: number;
  /**
   * Name this avatar for assistive technology. Omit when the profile's name is
   * already shown next to it: repeating it would announce the person twice.
   */
  readonly label?: string;
}

/**
 * The person using this host, drawn.
 *
 * Three honest states, in order: the picture they imported, the initials of
 * the name they gave, and — when they gave neither — a neutral person glyph.
 * The glyph is deliberate. Inventing a letter from the OS account name would
 * show the user something they never told Octant.
 */
export function UserAvatar(props: UserAvatarProps) {
  const size = props.size ?? 40;
  const initials = avatarInitials(props.profile.displayName);
  const accessibility =
    props.label === undefined
      ? ({ "aria-hidden": true } as const)
      : ({ role: "img", "aria-label": props.label } as const);

  if (props.profile.avatar.kind === "image") {
    return (
      <img
        alt=""
        className="user-avatar user-avatar--image"
        height={size}
        src={props.profile.avatar.dataUrl}
        style={{ inlineSize: `${String(size)}px`, blockSize: `${String(size)}px` }}
        width={size}
        {...accessibility}
      />
    );
  }

  return (
    <span
      className="user-avatar"
      data-accent={props.profile.accent}
      style={{
        inlineSize: `${String(size)}px`,
        blockSize: `${String(size)}px`,
        fontSize: `${String(Math.round(size * 0.4))}px`,
      }}
      {...accessibility}
    >
      {initials === "" ? <UserRound size={Math.round(size * 0.5)} /> : initials}
    </span>
  );
}
