import type { ShellSettings } from "@octant/contracts/shell";
import type { UserProfile } from "@octant/contracts/user-profile";
import { useState } from "react";
import { ProfileEditor } from "./ProfileEditor";

export interface UserProfileSettingsViewProps {
  readonly profile: UserProfile;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
}

/**
 * The same profile first run collects, editable for the life of the host.
 *
 * The draft is local and only written when an edit settles, because the shell
 * settings write is a journaled replacement: committing per keystroke would
 * record one settings event per character typed into the name field.
 */
export function UserProfileSettingsView(props: UserProfileSettingsViewProps) {
  const [draft, setDraft] = useState<UserProfile>(props.profile);
  const [synced, setSynced] = useState<UserProfile>(props.profile);
  const [editing, setEditing] = useState(false);

  // Settings can stay mounted while the host's own profile changes underneath
  // it — another window wrote one, or a conflict forced a reload. Holding the
  // draft from before would let the next settled edit put the old values back.
  if (synced !== props.profile) {
    setSynced(props.profile);
    if (!editing) setDraft(props.profile);
  }

  return (
    <ProfileEditor
      onChange={(next) => {
        setEditing(true);
        setDraft(next);
      }}
      onCommit={(profile) => {
        setEditing(false);
        props.onSettingsChange({ userProfile: profile });
      }}
      profile={draft}
    />
  );
}
