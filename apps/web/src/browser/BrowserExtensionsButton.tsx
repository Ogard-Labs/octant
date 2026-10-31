import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserExtensionSummary } from "@octant/contracts/browser-extensions";
import type { StoredBrowserProfile } from "@octant/contracts/browser-profiles";
import { browserExtensionsEnabledIn } from "@octant/domain";
import { PuzzleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantMenu } from "../ui/base/OctantMenu";

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
}

const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 480;

/**
 * The puzzle-piece button in the Browser toolbar. It appears only when at least
 * one extension is enabled in the page's profile, lists them, and opens the one
 * chosen as a popover in that profile. While the agent drives the page it carries
 * the count, because those extensions can read and change what the agent sees.
 */
export function BrowserExtensionsButton(props: BrowserExtensionsButtonProps) {
  const [extensions, setExtensions] = useState<ReadonlyArray<BrowserExtensionSummary>>([]);
  const anchor = useRef<HTMLSpanElement>(null);
  const manage = props.client.manageExtensions;
  const { profile, client } = props;

  useEffect(() => {
    if (profile === undefined || manage === undefined) {
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
  }, [client, manage, profile, props.refreshKey]);

  if (profile === undefined || extensions.length === 0) return null;

  const open = (extensionId: string, kind: "popup" | "options") => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect === undefined || props.hostBridge?.openBrowserExtensionPopup === undefined) return;
    void props.hostBridge.openBrowserExtensionPopup({
      profile:
        profile.kind === "personal"
          ? { kind: "personal" }
          : { kind: "project", projectId: String(profile.projectId) },
      extensionId,
      kind,
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      size: { width: POPUP_WIDTH, height: POPUP_HEIGHT },
    });
  };

  const items = extensions.flatMap((extension) => [
    ...(extension.hasPopup
      ? [{ label: extension.name, value: `popup:${extension.id}` }]
      : [{ label: extension.name, value: `popup:${extension.id}`, disabled: true }]),
    ...(extension.hasOptionsPage
      ? [{ label: `${extension.name} options`, value: `options:${extension.id}` }]
      : []),
  ]);

  return (
    <span className="browser-extensions-button" ref={anchor}>
      <OctantMenu
        actions={
          props.onManage === undefined
            ? []
            : [{ label: "Manage extensions…", onSelect: () => props.onManage?.() }]
        }
        items={items}
        onValueChange={(value) => {
          const [kind, id] = value.split(":");
          if (id !== undefined && (kind === "popup" || kind === "options")) open(id, kind);
        }}
        selectionMode="action"
        trigger={
          <>
            <PuzzleIcon aria-hidden="true" size={14} />
            {props.agentDriving ? <span>{extensions.length}</span> : null}
          </>
        }
        triggerClassName="browser-profile-control"
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
