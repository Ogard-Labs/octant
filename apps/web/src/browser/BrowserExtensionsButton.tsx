import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserExtensionSummary } from "@octant/contracts/browser-extensions";
import type { StoredBrowserProfile } from "@octant/contracts/browser-profiles";
import { browserExtensionsEnabledIn } from "@octant/domain";
import { PuzzleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { octantButtonClassName } from "../ui/base/OctantButton";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";

export interface BrowserExtensionsButtonProps {
  readonly client: Pick<BrowserAutomationClient, "manageExtensions">;
  readonly hostBridge?: OctantHostBridge | undefined;
  /** The profile the page lives in; Private pages have no extensions and no button. */
  readonly profile: StoredBrowserProfile | undefined;
  /** The page's address changed or a context started: ask again which extensions are on. */
  readonly refreshKey: string | undefined;
  /** True while the agent drives the page; the button then carries a count. */
  readonly agentDriving: boolean;
  /** Opens Settings where extensions are managed; the menu omits the action without it. */
  readonly onManage?: () => void;
  /** The toolbar already asked which extensions are on; the button then asks nothing itself. */
  readonly extensions?: ReadonlyArray<BrowserExtensionSummary>;
}

const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 480;

/** The extensions enabled in the page's profile, asked again when the page or context changes. */
export function useBrowserExtensions(options: {
  readonly client: Pick<BrowserAutomationClient, "manageExtensions">;
  readonly profile: StoredBrowserProfile | undefined;
  readonly refreshKey: string | undefined;
  readonly enabled?: boolean;
}): ReadonlyArray<BrowserExtensionSummary> {
  const [extensions, setExtensions] = useState<ReadonlyArray<BrowserExtensionSummary>>([]);
  const manage = options.client.manageExtensions;
  const { profile, client, enabled = true } = options;

  useEffect(() => {
    if (!enabled || profile === undefined || manage === undefined) {
      setExtensions([]);
      return undefined;
    }
    let current = true;
    manage
      .call(client, { kind: "list" })
      .then((result) => {
        if (current && result.kind === "browser-extensions") {
          setExtensions(browserExtensionsEnabledIn(result.extensions, profile));
        }
      })
      .catch(() => {
        if (current) setExtensions([]);
      });
    return () => {
      current = false;
    };
  }, [client, enabled, manage, profile, options.refreshKey]);
  return extensions;
}

/** One menu item per extension (and per options page), named by the extension. */
export function extensionMenuItems(
  extensions: ReadonlyArray<BrowserExtensionSummary>,
): ReadonlyArray<OctantMenuItem> {
  return extensions.flatMap((extension) => [
    // An extension with no popup page is chosen too: its click is the extension's
    // own `action.onClicked`, which the desktop app fires when the manifest has an
    // action. An extension with neither opens nothing.
    { label: extension.name, value: `popup:${extension.id}` },
    ...(extension.hasOptionsPage
      ? [{ label: `${extension.name} options`, value: `options:${extension.id}` }]
      : []),
  ]);
}

/** Opens the extension an item of `extensionMenuItems` names, anchored at `anchor`. */
export function openBrowserExtension(options: {
  readonly value: string;
  readonly profile: StoredBrowserProfile | undefined;
  readonly hostBridge?: OctantHostBridge | undefined;
  readonly anchor: HTMLElement | null;
}): void {
  const [kind, extensionId] = options.value.split(":");
  const rect = options.anchor?.getBoundingClientRect();
  const { profile } = options;
  if (
    extensionId === undefined ||
    (kind !== "popup" && kind !== "options") ||
    profile === undefined ||
    rect === undefined ||
    options.hostBridge?.openBrowserExtensionPopup === undefined
  ) {
    return;
  }
  void options.hostBridge.openBrowserExtensionPopup({
    profile:
      profile.kind === "personal"
        ? { kind: "personal" }
        : profile.kind === "account"
          ? { kind: "account", profileId: String(profile.profileId) }
          : { kind: "project", projectId: String(profile.projectId) },
    extensionId,
    kind,
    anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    size: { width: POPUP_WIDTH, height: POPUP_HEIGHT },
  });
}

/**
 * The puzzle-piece button in the Browser toolbar. It appears only when at least
 * one extension is enabled in the page's profile, lists them, and opens the one
 * chosen as a popover in that profile. While the agent drives the page it carries
 * the count, because those extensions can read and change what the agent sees.
 */
export function BrowserExtensionsButton(props: BrowserExtensionsButtonProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const asked = useBrowserExtensions({
    client: props.client,
    profile: props.profile,
    refreshKey: props.refreshKey,
    enabled: props.extensions === undefined,
  });
  const extensions = props.extensions ?? asked;
  const { profile } = props;

  if (profile === undefined || extensions.length === 0) return null;

  return (
    <span className="browser-extensions-button" ref={anchor}>
      <OctantMenu
        actions={
          props.onManage === undefined
            ? []
            : [{ label: "Manage extensions…", onSelect: () => props.onManage?.() }]
        }
        items={[...extensionMenuItems(extensions)]}
        onValueChange={(value) =>
          openBrowserExtension({
            value,
            profile,
            hostBridge: props.hostBridge,
            anchor: anchor.current,
          })
        }
        selectionMode="action"
        trigger={
          <>
            <PuzzleIcon aria-hidden="true" size={14} />
            {props.agentDriving ? <span>{extensions.length}</span> : null}
          </>
        }
        triggerClassName={`${octantButtonClassName({ variant: "ghost", size: "icon" })} shell-icon-button`}
        triggerLabel={
          props.agentDriving
            ? `Extensions: ${String(extensions.length)} on in this profile and visible to the agent`
            : "Extensions"
        }
        value=""
      />
    </span>
  );
}
