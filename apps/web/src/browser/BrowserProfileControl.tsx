import type { BrowserProfileSummary } from "@octant/contracts/browser-profiles";
import { decodeBrowserProfileChoice } from "@octant/contracts/project-browser";
import type { BrowserProfileChoice } from "@octant/contracts/project-browser";
import { EyeOff, FolderOpen, LogOut, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { octantButtonClassName } from "../ui/base/OctantButton";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
import {
  BROWSER_PROFILE_DESCRIPTIONS,
  browserProfileLabel,
  profileChoiceOf,
} from "./browserProfileCopy";

export interface BrowserProfileControlProps {
  readonly profile: BrowserProfileChoice;
  readonly accounts?: ReadonlyArray<BrowserProfileSummary>;
  readonly label?: string;
  /** Without a Project there is no Project profile to offer. */
  readonly projectProfileAvailable: boolean;
  /** Signed-in pages open in the desktop app's own Browser only. */
  readonly signedInPagesAvailable: boolean;
  readonly disabled?: boolean;
  /**
   * An icon button in the Browser's toolbar whose name and tooltip carry the
   * words. A signed-in profile (anything but Private) also shows its name.
   */
  readonly iconOnly?: boolean;
  /** A sentence added to the icon's tooltip, such as what the agent may do with the page. */
  readonly description?: string;
  /**
   * The toolbar has no room for the button: it draws none, and the profile's
   * choices come from `browserProfileMenuItems` in its more menu instead.
   */
  readonly folded?: boolean;
  /** A new number asks for the sign-out confirmation, which the folded menu cannot draw itself. */
  readonly signOutRequest?: number;
  readonly onChange: (choice: BrowserProfileChoice) => void;
  /** Absent where the host cannot clear a profile; the menu then omits the action. */
  readonly onSignOut?: () => Promise<void> | void;
}

const ICONS = {
  private: <EyeOff aria-hidden="true" size={14} />,
  project: <FolderOpen aria-hidden="true" size={14} />,
  personal: <UserRound aria-hidden="true" size={14} />,
} as const;

type MenuInputs = Pick<
  BrowserProfileControlProps,
  "profile" | "accounts" | "projectProfileAvailable" | "signedInPagesAvailable"
>;

const choicesOf = (inputs: MenuInputs): ReadonlyArray<BrowserProfileChoice> => [
  "private",
  "project",
  "personal",
  ...(inputs.accounts ?? [])
    .filter((entry) => entry.profile.kind === "account")
    .map((entry) => profileChoiceOf(entry.profile)),
];

const iconOf = (choice: BrowserProfileChoice) =>
  choice === "private" || choice === "project" || choice === "personal"
    ? ICONS[choice]
    : ICONS.personal;

function unavailableReason(inputs: MenuInputs, choice: BrowserProfileChoice): string | undefined {
  if (choice === "private") return undefined;
  if (!inputs.signedInPagesAvailable) return "Signed-in pages open in the Octant app only.";
  if (choice === "project" && !inputs.projectProfileAvailable) {
    return "Open a Work or Code Project to use its profile.";
  }
  return undefined;
}

/** One item per profile the person may choose, with why a profile is unavailable. */
export function browserProfileMenuItems(inputs: MenuInputs): ReadonlyArray<OctantMenuItem> {
  return choicesOf(inputs).map((choice) => {
    const reason = unavailableReason(inputs, choice);
    return {
      description:
        reason ??
        (choice === "private" || choice === "project" || choice === "personal"
          ? BROWSER_PROFILE_DESCRIPTIONS[choice]
          : `Named account ${choice.slice("account:".length, "account:".length + 8)} · shared only when explicitly selected.`),
      disabled: reason !== undefined,
      icon: iconOf(choice),
      label: browserProfileLabel(choice, inputs.accounts),
      value: choice,
    };
  });
}

/**
 * Where this page keeps its cookies and site data: Private forgets everything when the page closes, Project and
 * Personal keep a sign-in on this Mac.
 */
export function BrowserProfileControl(props: BrowserProfileControlProps) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const label = (choice: BrowserProfileChoice) => browserProfileLabel(choice, props.accounts);
  const stored = props.profile !== "private";
  const handledSignOut = useRef(props.signOutRequest);
  useEffect(() => {
    if (props.signOutRequest === undefined || props.signOutRequest === handledSignOut.current) {
      return;
    }
    handledSignOut.current = props.signOutRequest;
    setConfirmingSignOut(true);
  }, [props.signOutRequest]);
  return (
    <>
      {props.folded === true ? null : (
        <OctantMenu
          actions={
            stored && props.onSignOut !== undefined
              ? [
                  {
                    icon: <LogOut aria-hidden="true" size={14} />,
                    label: "Sign out of this profile…",
                    onSelect: () => setConfirmingSignOut(true),
                  },
                ]
              : []
          }
          items={[...browserProfileMenuItems(props)]}
          onValueChange={(value) => {
            props.onChange(decodeBrowserProfileChoice(value));
          }}
          trigger={
            props.iconOnly === true ? (
              stored ? (
                // A page that runs as the person's own sign-in says so at rest.
                <>
                  {iconOf(props.profile)}
                  <span className="browser-workspace__profile-name">{label(props.profile)}</span>
                </>
              ) : (
                iconOf(props.profile)
              )
            ) : (
              <>
                {iconOf(props.profile)}
                <span>
                  {props.label === undefined ? "" : "Task default: "}
                  {label(props.profile)}
                </span>
              </>
            )
          }
          triggerClassName={
            props.iconOnly === true
              ? `${octantButtonClassName({ variant: "ghost", size: "icon" })} shell-icon-button${stored ? " browser-workspace__profile--named" : ""}`
              : "browser-profile-control"
          }
          triggerDisabled={props.disabled === true}
          triggerLabel={`${props.label ?? "Browser profile"}: ${label(props.profile)}`}
          triggerTitle={`${props.label ?? "Browser profile"}: ${label(props.profile)}${props.description === undefined ? "" : `. ${props.description}`}`}
          value={props.profile}
        />
      )}
      <OctantDialogPresence>
        {confirmingSignOut ? (
          <OctantConfirmDialog
            confirmLabel="Sign out"
            destructive
            onCancel={() => setConfirmingSignOut(false)}
            onConfirm={() => {
              setSigningOut(true);
              void Promise.resolve(props.onSignOut?.()).finally(() => {
                setSigningOut(false);
                setConfirmingSignOut(false);
              });
            }}
            pending={signingOut}
            title={`Sign out of the ${label(props.profile)} profile?`}
          >
            Every page in this profile closes, and its cookies, site storage and cache are removed.
            Sites you were signed in to will ask you to sign in again.
          </OctantConfirmDialog>
        ) : null}
      </OctantDialogPresence>
    </>
  );
}
