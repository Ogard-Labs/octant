import {
  AVATAR_ACCENTS,
  MAX_USER_DISPLAY_NAME_CHARACTERS,
  MAX_USER_EMAIL_CHARACTERS,
  type AvatarAccent,
  type UserAvatar as UserAvatarValue,
  type UserProfile,
} from "@octant/contracts/user-profile";
import { canImportGravatar } from "@octant/domain";
import { useId, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { UserAvatar } from "./UserAvatar";
import {
  browserAvatarEnvironment,
  importAvatarFromFile,
  importAvatarFromGravatar,
  type AvatarImageEnvironment,
} from "./avatarImage";
import "./profile.css";

export interface ProfileEditorProps {
  readonly profile: UserProfile;
  /** Fires on every edit. The parent decides whether that is a draft or a write. */
  readonly onChange: (next: UserProfile) => void;
  /**
   * Fires when an edit has settled — a text field blurred, an accent or avatar
   * chosen. A surface that persists each change uses this instead of writing
   * on every keystroke.
   */
  readonly onCommit?: (next: UserProfile) => void;
  readonly disabled?: boolean;
  /**
   * Fires while an avatar import is in flight. A surface that can be dismissed
   * needs this: the import's result arrives as a later `onChange`, which is
   * lost if the surface resolved in the meantime.
   */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Browser seam for image decoding and the Gravatar request. Tests supply their own. */
  readonly environment?: AvatarImageEnvironment;
  /** Lets a dialog put initial focus on the first field the user should fill. */
  readonly nameRef?: RefObject<HTMLInputElement | null>;
}

const ACCENT_NAMES: Record<AvatarAccent, string> = {
  slate: "Slate",
  indigo: "Indigo",
  violet: "Violet",
  teal: "Teal",
  green: "Green",
  amber: "Amber",
  rose: "Rose",
  cyan: "Cyan",
};

/**
 * Name, address, and avatar for the person using this host.
 *
 * Everything here is optional and stays on this Mac. The one exception is the
 * Gravatar button, which contacts gravatar.com — so it says so in the surface
 * itself, is offered only once an address has been typed, and never runs on
 * its own. A failed import leaves the previous avatar alone and reports why,
 * rather than quietly falling back to initials.
 */
export function ProfileEditor(props: ProfileEditorProps) {
  const nameId = useId();
  const emailId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "gravatar" | undefined>(undefined);
  const [notice, setNotice] = useState<{ tone: "info" | "attention"; message: string }>();
  const [nameDraft, setNameDraft] = useState(props.profile.displayName ?? "");
  const [emailDraft, setEmailDraft] = useState(props.profile.email ?? "");
  const [syncedProfile, setSyncedProfile] = useState(props.profile);
  const latestProfile = useRef(props.profile);
  latestProfile.current = props.profile;
  const pendingCommit = useRef(false);
  const reported = useRef<UserProfile | undefined>(undefined);

  // The typed fields keep their own text so a half-typed value survives
  // normalization, which means an owner that replaces the profile — a store
  // that finished loading, a surface reopened on a different one — would
  // otherwise leave them showing the value from before. Adopt the incoming
  // text only where it actually says something different: `Ada ` normalizes to
  // the `Ada` the owner just echoed back, and must not lose its space.
  if (syncedProfile !== props.profile) {
    setSyncedProfile(props.profile);
    // An owner re-renders with what this editor just reported, and that echo
    // is not an external update. Text the contract refuses is reported as no
    // value at all, so adopting the echo would erase the entry the user still
    // has in front of them — together with the message saying what to fix.
    const echo = reported.current !== undefined && sameProfile(props.profile, reported.current);
    if (!echo) {
      const name = props.profile.displayName ?? "";
      const email = props.profile.email ?? "";
      if (name !== nameDraft.trim()) setNameDraft(name);
      if (email !== emailDraft.trim()) setEmailDraft(email);
    }
  }

  const disabled = props.disabled === true || busy !== undefined;
  const nameProblem = nameValidationMessage(nameDraft);
  const emailProblem = emailValidationMessage(emailDraft);
  const gravatarReady = emailProblem === undefined && canImportGravatar({ email: emailDraft });

  /**
   * Report an edit, and commit it once it settles.
   *
   * A field that is blurred without being changed produces no edit at all —
   * not a change event, and not a commit. Otherwise merely tabbing through an
   * untouched profile would look like an answer, and every surface downstream
   * would persist a settings replacement identical to what it already held.
   */
  function apply(next: UserProfile, settled: boolean) {
    if (!sameProfile(next, props.profile)) {
      pendingCommit.current = true;
      reported.current = next;
      props.onChange(next);
    }
    if (settled && pendingCommit.current) {
      pendingCommit.current = false;
      props.onCommit?.(next);
    }
  }

  function setName(value: string, settled: boolean) {
    setNameDraft(value);
    const trimmed = value.trim();
    const { displayName: _cleared, ...rest } = props.profile;
    // A name the contract would refuse is not written, and neither is the last
    // one that would have been: a name typed past the limit one character at a
    // time leaves the owner holding the prefix that was still valid, which the
    // field no longer shows and the user never settled on. Clearing it keeps
    // the owner's draft equal to what is on screen, so anything written later
    // is something the user can see. Reporting the problem here, while the
    // field still holds it, is the only point at which they can fix it.
    const storable = trimmed !== "" && nameValidationMessage(trimmed) === undefined;
    apply(storable ? { ...rest, displayName: trimmed } : rest, settled);
  }

  function setEmail(value: string, settled: boolean) {
    setEmailDraft(value);
    const trimmed = value.trim();
    const { email: _cleared, ...rest } = props.profile;
    // An address that cannot be an address is not written: the profile would
    // then hold something no Gravatar lookup or display could ever use. Nor is
    // the last intermediate value that happened to parse — typing on past
    // `ada@example.com` must not leave the owner holding that address while
    // the field shows something else.
    const storable = trimmed !== "" && emailValidationMessage(trimmed) === undefined;
    apply(storable ? { ...rest, email: trimmed } : rest, settled);
  }

  function setAvatar(avatar: UserAvatarValue) {
    // An import started before the last text edit settled would otherwise
    // rebuild the profile from the render it began in, silently dropping the
    // address the user typed on the way to pressing the button.
    apply({ ...latestProfile.current, avatar }, true);
  }

  async function runImport(
    kind: "upload" | "gravatar",
    run: (environment: AvatarImageEnvironment) => ReturnType<typeof importAvatarFromFile>,
  ) {
    setBusy(kind);
    props.onBusyChange?.(true);
    setNotice(undefined);
    // An import that fails in an unforeseen way must still end as a message,
    // not as a button that spun and then said nothing.
    const result = await run(props.environment ?? browserAvatarEnvironment()).catch(() => ({
      kind: "failed" as const,
      failure: {
        kind: "unreadable" as const,
        message: "That picture could not be imported on this Mac.",
      },
    }));
    setBusy(undefined);
    if (result.kind === "failed") {
      props.onBusyChange?.(false);
      setNotice({ tone: "attention", message: result.failure.message });
      return;
    }
    setAvatar({
      kind: "image",
      source: kind === "upload" ? "upload" : "gravatar",
      dataUrl: result.dataUrl,
    });
    // Released only after the avatar has been handed over, so an owner that was
    // waiting on this import resolves with the picture rather than without it.
    props.onBusyChange?.(false);
    setNotice(
      kind === "gravatar"
        ? { tone: "info", message: "Gravatar imported and saved on this Mac." }
        : undefined,
    );
  }

  function onFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clearing the input means picking the same file twice still fires.
    event.target.value = "";
    if (file === undefined) return;
    void runImport("upload", (environment) => importAvatarFromFile(file, environment));
  }

  return (
    <div className="profile-editor">
      <div className="profile-editor__identity">
        <UserAvatar profile={props.profile} size={56} />
        <div className="profile-editor__identity-actions">
          <OctantButton
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
            type="button"
            variant="ghost"
          >
            {busy === "upload" ? "Reading photo…" : "Upload photo"}
          </OctantButton>
          <OctantButton
            disabled={disabled || !gravatarReady}
            onClick={() =>
              void runImport("gravatar", (environment) =>
                importAvatarFromGravatar(emailDraft, environment),
              )
            }
            type="button"
            variant="ghost"
          >
            {busy === "gravatar" ? "Checking Gravatar…" : "Use Gravatar"}
          </OctantButton>
          {props.profile.avatar.kind === "image" ? (
            <OctantButton
              disabled={disabled}
              onClick={() => {
                setNotice(undefined);
                setAvatar({ kind: "initials" });
              }}
              type="button"
              variant="ghost"
            >
              Use initials
            </OctantButton>
          ) : null}
          <input
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Avatar photo"
            className="sr-only"
            onChange={onFilePicked}
            ref={fileInput}
            tabIndex={-1}
            type="file"
          />
        </div>
      </div>

      {notice === undefined ? null : (
        <p
          className="profile-editor__notice"
          data-tone={notice.tone}
          role={notice.tone === "attention" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}

      <div className="profile-editor__field">
        <label className="profile-editor__label" htmlFor={nameId}>
          Name
        </label>
        <OctantInput
          aria-describedby={nameProblem === undefined ? undefined : `${nameId}-problem`}
          aria-invalid={nameProblem !== undefined}
          autoComplete="name"
          disabled={props.disabled === true}
          id={nameId}
          onBlur={(event) => setName(event.target.value, true)}
          onChange={(event) => setName(event.target.value, false)}
          placeholder="How Octant should address you"
          {...(props.nameRef === undefined ? {} : { ref: props.nameRef })}
          value={nameDraft}
        />
        {nameProblem === undefined ? null : (
          <p className="profile-editor__hint" id={`${nameId}-problem`} role="alert">
            {nameProblem}
          </p>
        )}
      </div>

      <div className="profile-editor__field">
        <label className="profile-editor__label" htmlFor={emailId}>
          Email <span className="profile-editor__hint">(optional)</span>
        </label>
        <OctantInput
          aria-describedby={`${emailId}-hint`}
          aria-invalid={emailProblem !== undefined}
          autoComplete="email"
          disabled={props.disabled === true}
          id={emailId}
          onBlur={(event) => setEmail(event.target.value, true)}
          onChange={(event) => setEmail(event.target.value, false)}
          placeholder="you@example.com"
          type="email"
          value={emailDraft}
        />
        <p className="profile-editor__hint" id={`${emailId}-hint`} role="status">
          {emailProblem ??
            "Kept on this Mac. Choosing “Use Gravatar” sends a hash of it to gravatar.com once, to fetch that picture."}
        </p>
      </div>

      {props.profile.avatar.kind === "image" ? null : (
        <fieldset
          aria-label="Avatar colour"
          className="profile-editor__field"
          disabled={props.disabled === true}
        >
          <legend className="profile-editor__label">Avatar colour</legend>
          <div className="profile-editor__accents" role="radiogroup">
            {AVATAR_ACCENTS.map((accent) => (
              <OctantButton
                aria-checked={props.profile.accent === accent}
                aria-label={ACCENT_NAMES[accent]}
                className="profile-editor__accent user-avatar"
                data-accent={accent}
                key={accent}
                onClick={() => apply({ ...props.profile, accent }, true)}
                role="radio"
                type="button"
                variant="ghost"
              />
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Whether two profiles say the same thing, field by field. */
function sameProfile(a: UserProfile, b: UserProfile): boolean {
  if (a.displayName !== b.displayName) return false;
  if (a.email !== b.email) return false;
  if (a.accent !== b.accent) return false;
  if (a.avatar.kind !== b.avatar.kind) return false;
  if (a.avatar.kind === "image" && b.avatar.kind === "image") {
    return a.avatar.source === b.avatar.source && a.avatar.dataUrl === b.avatar.dataUrl;
  }
  return true;
}

/**
 * What is wrong with the typed name, when something is.
 *
 * Empty is not wrong: the field is optional. Too long is, and saying so here
 * beats letting the contract refuse the settings replacement after the user has
 * moved on from the field that caused it.
 */
export function nameValidationMessage(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length > MAX_USER_DISPLAY_NAME_CHARACTERS) {
    return `That name is ${String(trimmed.length)} characters. Octant stores at most ${String(MAX_USER_DISPLAY_NAME_CHARACTERS)}.`;
  }
  return undefined;
}

/**
 * What is wrong with the typed address, when something is.
 *
 * Empty is not wrong: the field is optional, and an empty profile is a valid
 * profile.
 */
export function emailValidationMessage(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_USER_EMAIL_CHARACTERS) return "That address is too long to store.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "That does not look like an email address yet.";
  }
  return undefined;
}
