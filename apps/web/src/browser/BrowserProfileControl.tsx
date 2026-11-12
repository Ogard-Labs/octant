import type { BrowserProfileSummary } from "@octant/contracts/browser-profiles";
import { decodeBrowserProfileChoice } from "@octant/contracts/project-browser";
import type { BrowserProfileChoice } from "@octant/contracts/project-browser";
import { EyeOff, FolderOpen, LogOut, UserRound } from "lucide-react";
import { useState } from "react";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantMenu } from "../ui/base/OctantMenu";
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
  readonly onChange: (choice: BrowserProfileChoice) => void;
  /** Absent where the host cannot clear a profile; the menu then omits the action. */
  readonly onSignOut?: () => Promise<void> | void;
}

const ICONS = {
  private: <EyeOff aria-hidden="true" size={14} />,
  project: <FolderOpen aria-hidden="true" size={14} />,
  personal: <UserRound aria-hidden="true" size={14} />,
} as const;

/**
 * Where this page keeps its cookies and site data. It sits at the left of the
 * address field: Private forgets everything when the page closes, Project and
 * Personal keep a sign-in on this Mac.
 */
export function BrowserProfileControl(props: BrowserProfileControlProps) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const choices: ReadonlyArray<BrowserProfileChoice> = [
    "private",
    "project",
    "personal",
    ...(props.accounts ?? [])
      .filter((entry) => entry.profile.kind === "account")
      .map((entry) => profileChoiceOf(entry.profile)),
  ];
  const label = (choice: BrowserProfileChoice) => browserProfileLabel(choice, props.accounts);
  const icon = (choice: BrowserProfileChoice) =>
    choice === "private" || choice === "project" || choice === "personal"
      ? ICONS[choice]
      : ICONS.personal;
  const stored = props.profile !== "private";
  const unavailable = (choice: BrowserProfileChoice): string | undefined => {
    if (choice === "private") return undefined;
    if (!props.signedInPagesAvailable) return "Signed-in pages open in the Octant app only.";
    if (choice === "project" && !props.projectProfileAvailable) {
      return "Open a Work or Code Project to use its profile.";
    }
    return undefined;
  };
  return (
    <>
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
        items={choices.map((choice) => {
          const reason = unavailable(choice);
          return {
            description:
              reason ??
              (choice === "private" || choice === "project" || choice === "personal"
                ? BROWSER_PROFILE_DESCRIPTIONS[choice]
                : `Named account ${choice.slice("account:".length, "account:".length + 8)} · shared only when explicitly selected.`),
            disabled: reason !== undefined,
            icon: icon(choice),
            label: label(choice),
            value: choice,
          };
        })}
        onValueChange={(value) => {
          props.onChange(decodeBrowserProfileChoice(value));
        }}
        trigger={
          <>
            {icon(props.profile)}
            <span>
              {props.label === undefined ? "" : "Task default: "}
              {label(props.profile)}
            </span>
          </>
        }
        triggerClassName="browser-profile-control"
        triggerDisabled={props.disabled === true}
        triggerLabel={`${props.label ?? "Browser profile"}: ${label(props.profile)}`}
        triggerTitle={`${props.label ?? "Browser profile"}: ${label(props.profile)}`}
        value={props.profile}
      />
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
