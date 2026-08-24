import type { OpenInApplicationId } from "@octant/contracts/shell";
import { ChevronDown, Code2, Folder, Hammer, SquareTerminal, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { OctantHostBridge, OpenInApplicationDescriptor } from "../shell/hostBridge";
import { OctantMenu } from "../ui/base/OctantMenu";

export interface OpenInMenuProps {
  readonly active?: boolean;
  readonly applications: ReadonlyArray<OpenInApplicationId>;
  readonly hostBridge?: OctantHostBridge;
  readonly threadId: string;
}

const APPLICATION_ICONS: Readonly<Record<OpenInApplicationId, LucideIcon>> = {
  vscode: Code2,
  cursor: Code2,
  zed: Code2,
  finder: Folder,
  terminal: SquareTerminal,
  ghostty: SquareTerminal,
  xcode: Hammer,
};

/** Native-only Open in application menu for the active Code checkout. */
export function OpenInMenu(props: OpenInMenuProps) {
  const [catalogue, setCatalogue] = useState<ReadonlyArray<OpenInApplicationDescriptor>>([]);
  const [error, setError] = useState<string>();
  const [toolbarHost, setToolbarHost] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.querySelector("[data-octant-open-in-action]"),
  );
  const active = props.active !== false;
  const listApplications = props.hostBridge?.listOpenInApplications;

  useEffect(() => {
    setToolbarHost(document.querySelector("[data-octant-open-in-action]"));
  }, []);

  useEffect(() => {
    if (!active || listApplications === undefined) return;
    let cancelled = false;
    void listApplications().then(
      (next) => {
        if (!cancelled) setCatalogue(next);
      },
      () => {
        if (!cancelled) setError("Open in applications are unavailable.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, listApplications]);

  const visible = useMemo(() => {
    const byId = new Map(catalogue.map((entry) => [entry.id, entry]));
    return props.applications.flatMap((id) => {
      const entry = byId.get(id);
      return entry?.available === true ? [entry] : [];
    });
  }, [catalogue, props.applications]);

  const open = props.hostBridge?.openCodeCheckoutInApplication;
  if (!active || open === undefined || visible.length === 0) return null;
  const first = visible[0];
  if (first === undefined) return null;
  const FirstIcon = APPLICATION_ICONS[first.id];
  const menu = (
    <div className="open-in-menu window-no-drag">
      <OctantMenu
        items={visible.map((entry) => {
          const Icon = APPLICATION_ICONS[entry.id];
          return {
            icon: <Icon aria-hidden="true" size={15} strokeWidth={1.7} />,
            label: entry.label,
            value: entry.id,
          };
        })}
        onValueChange={(value) => {
          const selected = visible.find((entry) => entry.id === value);
          if (selected === undefined) return;
          setError(undefined);
          void open({ threadId: props.threadId, applicationId: selected.id }).catch(() => {
            setError(`Octant could not open ${selected.label}.`);
          });
        }}
        selectionMode="action"
        trigger={
          <>
            <FirstIcon aria-hidden="true" size={15} strokeWidth={1.7} />
            <ChevronDown aria-hidden="true" size={13} strokeWidth={1.7} />
          </>
        }
        triggerClassName="open-in-menu__trigger"
        triggerLabel={`Open checkout in an application. Default ${first.label}`}
        value={first.id}
      />
      {error === undefined ? null : (
        <span className="sr-only" role="alert">
          {error}
        </span>
      )}
    </div>
  );
  return toolbarHost === null ? menu : createPortal(menu, toolbarHost);
}
