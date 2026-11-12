import { Check, Copy, FolderOpen, Pencil, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantCard,
  OctantCardContent,
  OctantCardDescription,
  OctantCardFooter,
  OctantCardHeader,
  OctantCardTitle,
} from "../ui/base/OctantCard";
import {
  OctantCombobox,
  OctantComboboxEmpty,
  OctantComboboxInput,
  OctantComboboxInputGroup,
  OctantComboboxItem,
  OctantComboboxItemIndicator,
  OctantComboboxList,
  OctantComboboxPopup,
  OctantComboboxPortal,
  OctantComboboxPositioner,
  OctantComboboxTrigger,
} from "../ui/base/OctantCombobox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantContextMenu } from "../ui/base/OctantContextMenu";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { OctantMenu } from "../ui/base/OctantMenu";
import { OctantMenuIconSlot } from "../ui/base/OctantMenuIconSlot";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantPreviewCard } from "../ui/base/OctantPreviewCard";
import {
  OctantSelectItem,
  OctantSelectPopup,
  OctantSelectPortal,
  OctantSelectPositioner,
  OctantSelectRoot,
  OctantSelectTrigger,
  OctantSelectValue,
} from "../ui/base/OctantSelect";
import { OctantSheet } from "../ui/base/OctantSheet";
import { OctantToast } from "../ui/base/OctantToast";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { Section, Specimen } from "./Specimen";

/**
 * Reserves the room an open popup needs under its trigger, so a popup held
 * open for the gallery does not cover the specimen below it.
 */
function OpenStage(props: { readonly children: ReactNode; readonly tall?: boolean }) {
  return (
    <div className="gallery-open-stage" data-tall={props.tall === true ? "true" : undefined}>
      {props.children}
    </div>
  );
}

const noop = () => undefined;

function OpenMenu() {
  return (
    <OctantMenuRoot modal={false} onOpenChange={noop} open>
      <OctantMenuTrigger className="gallery-menu-trigger">Project menu</OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner>
          <OctantMenuPopup>
            <OctantMenuGroup>
              <OctantMenuGroupLabel>Project</OctantMenuGroupLabel>
              <OctantMenuItem>
                <span
                  aria-hidden="true"
                  className="flex size-(--oct-icon-md) shrink-0 items-center justify-center"
                >
                  <Pencil size={16} />
                </span>
                <span className="truncate">Rename</span>
              </OctantMenuItem>
              <OctantMenuItem>
                <span
                  aria-hidden="true"
                  className="flex size-(--oct-icon-md) shrink-0 items-center justify-center"
                >
                  <FolderOpen size={16} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">Open in Finder</span>
                  <span className="truncate oct-menu-detail">Reveal the checkout on disk</span>
                </span>
              </OctantMenuItem>
              <OctantMenuCheckboxItem checked onCheckedChange={noop}>
                <OctantMenuIconSlot />
                <span className="truncate">Pinned</span>
              </OctantMenuCheckboxItem>
              <OctantMenuItem>
                <span
                  aria-hidden="true"
                  className="flex size-(--oct-icon-md) shrink-0 items-center justify-center"
                >
                  <Copy size={16} />
                </span>
                <span className="truncate">Copy path</span>
                <span className="oct-meta ml-auto">⌘⇧C</span>
              </OctantMenuItem>
              <OctantMenuItem disabled>
                <OctantMenuIconSlot />
                <span className="truncate">Archive (disabled)</span>
              </OctantMenuItem>
            </OctantMenuGroup>
            <OctantMenuSeparator />
            <OctantMenuItem>
              <span
                aria-hidden="true"
                className="flex size-(--oct-icon-md) shrink-0 items-center justify-center"
              >
                <Trash2 size={16} />
              </span>
              <span className="truncate">Remove</span>
            </OctantMenuItem>
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

const SELECT_ITEMS = ["System", "Light", "Dark"] as const;

function OpenSelect() {
  return (
    <OctantSelectRoot onOpenChange={noop} open value="System">
      <OctantSelectTrigger aria-label="Theme" className="gallery-field-width">
        <OctantSelectValue />
      </OctantSelectTrigger>
      <OctantSelectPortal>
        <OctantSelectPositioner alignItemWithTrigger={false} sideOffset={4}>
          <OctantSelectPopup>
            {SELECT_ITEMS.map((item) => (
              <OctantSelectItem key={item} value={item}>
                {item}
              </OctantSelectItem>
            ))}
          </OctantSelectPopup>
        </OctantSelectPositioner>
      </OctantSelectPortal>
    </OctantSelectRoot>
  );
}

function OpenCombobox() {
  return (
    <OctantCombobox
      items={["Geist", "Menlo", "Monaco"]}
      onOpenChange={noop}
      open
      defaultValue="Geist"
    >
      <OctantComboboxInputGroup className="gallery-field-width">
        <OctantComboboxInput aria-label="Font" placeholder="Search fonts" />
        <OctantComboboxTrigger aria-label="Open fonts">
          <Check aria-hidden="true" />
        </OctantComboboxTrigger>
      </OctantComboboxInputGroup>
      <OctantComboboxPortal>
        <OctantComboboxPositioner
          collisionAvoidance={{ side: "none" }}
          side="bottom"
          sideOffset={4}
        >
          <OctantComboboxPopup>
            <OctantComboboxEmpty>No matching fonts</OctantComboboxEmpty>
            <OctantComboboxList>
              {(family: string) => (
                <OctantComboboxItem key={family} value={family}>
                  {family}
                  <OctantComboboxItemIndicator>
                    <Check aria-hidden="true" />
                  </OctantComboboxItemIndicator>
                </OctantComboboxItem>
              )}
            </OctantComboboxList>
          </OctantComboboxPopup>
        </OctantComboboxPositioner>
      </OctantComboboxPortal>
    </OctantCombobox>
  );
}

function LiveDialogs() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <div className="gallery-row">
      <OctantButton onClick={() => setDialog(true)} ref={opener} type="button" variant="outline">
        Open the confirm dialog
      </OctantButton>
      <OctantButton onClick={() => setSheet(true)} type="button" variant="outline">
        Open the sheet
      </OctantButton>
      {dialog ? (
        <OctantConfirmDialog
          confirmLabel="Remove"
          destructive
          onCancel={() => setDialog(false)}
          onConfirm={() => setDialog(false)}
          restoreFocus={opener}
          title="Remove this Project?"
        >
          Its threads stay in the archive.
        </OctantConfirmDialog>
      ) : null}
      <OctantSheet label="Sheet specimen" onClose={() => setSheet(false)} open={sheet}>
        <div className="gallery-sheet">
          <p className="oct-page-title">A sheet</p>
          <p className="oct-row-detail">It lays itself out to its edges and closes with Escape.</p>
          <OctantButton onClick={() => setSheet(false)} type="button" variant="outline">
            Close
          </OctantButton>
        </div>
      </OctantSheet>
    </div>
  );
}

export function OverlaySections() {
  return (
    <>
      <Section
        caption="Menus and pick-lists held open under their triggers, so the rows, groups and separators can be read."
        id="menus"
        title="Menu, select and combobox"
      >
        <Specimen
          adapters={[
            "OctantMenuRoot",
            "OctantMenuTrigger",
            "OctantMenuPortal",
            "OctantMenuPositioner",
            "OctantMenuPopup",
            "OctantMenuGroup",
            "OctantMenuGroupLabel",
            "OctantMenuItem",
            "OctantMenuCheckboxItem",
            "OctantMenuSeparator",
            "OctantMenuIconSlot",
          ]}
          props={`open; group label, item with icon, item with a second line, checked item, item with an .oct-meta shortcut, disabled item (checked and disabled rows reserve the icon column with OctantMenuIconSlot), separator`}
          note="no shortcut component exists, so the shortcut is a plain .oct-meta span"
        >
          <OpenStage tall>
            <OpenMenu />
          </OpenStage>
        </Specimen>
        <Specimen
          adapters={[
            "OctantSelectRoot",
            "OctantSelectTrigger",
            "OctantSelectValue",
            "OctantSelectPortal",
            "OctantSelectPositioner",
            "OctantSelectPopup",
            "OctantSelectItem",
          ]}
          props={`open value="System"`}
          note="OctantSelectField has no open prop; this is its compound parts"
        >
          <OpenStage>
            <OpenSelect />
          </OpenStage>
        </Specimen>
        <Specimen
          adapters={[
            "OctantCombobox",
            "OctantComboboxInputGroup",
            "OctantComboboxInput",
            "OctantComboboxTrigger",
            "OctantComboboxPortal",
            "OctantComboboxPositioner",
            "OctantComboboxPopup",
            "OctantComboboxEmpty",
            "OctantComboboxList",
            "OctantComboboxItem",
            "OctantComboboxItemIndicator",
          ]}
          props={`open defaultValue="Geist"`}
        >
          <OpenStage>
            <OpenCombobox />
          </OpenStage>
        </Specimen>
        <Specimen
          adapters={["OctantMenu"]}
          props={`<OctantMenu selectionMode="action" items=[Rename (icon), Open (second line)] triggerLabel="Project actions" />`}
          note="the closed trigger; click it to open the menu above's real adapter"
        >
          <OctantMenu
            items={[
              { icon: <Pencil size={16} />, label: "Rename", value: "rename" },
              {
                description: "Reveal the checkout on disk",
                icon: <FolderOpen size={16} />,
                label: "Open in Finder",
                value: "open",
              },
            ]}
            onValueChange={noop}
            selectionMode="action"
            trigger="Project actions"
            triggerLabel="Project actions"
            value=""
          />
        </Specimen>
        <Specimen
          adapters={["OctantContextMenu"]}
          props={`items=[Rename (icon), Open (second line), Remove (disabled)]`}
          note="opens at the pointer, so right-click the box; it shares the menu's row recipe"
        >
          <OctantContextMenu
            items={[
              { icon: <Pencil size={16} />, label: "Rename", value: "rename" },
              {
                description: "Reveal the checkout on disk",
                icon: <FolderOpen size={16} />,
                label: "Open in Finder",
                value: "open",
              },
              { disabled: true, label: "Remove", value: "remove" },
            ]}
            onValueChange={noop}
            triggerClassName="gallery-context-target"
          >
            Right-click here
          </OctantContextMenu>
        </Specimen>
      </Section>
      <Section
        caption="Popovers, tooltips and preview cards. The popover is held open; the tooltip and preview card open on hover or focus."
        id="popups"
        title="Popover, tooltip and preview card"
      >
        <Specimen
          adapters={["OctantPopover"]}
          props={`open={true} side="bottom" title="Details" triggerLabel="Details"`}
        >
          <OpenStage tall>
            <OctantPopover
              onOpenChange={noop}
              open
              title="Details"
              trigger="Details"
              triggerLabel="Details"
              triggerVariant="outline"
            >
              <div className="gallery-popover">
                <p className="oct-row-label">Popover content</p>
                <p className="oct-row-detail">Anchored under its trigger.</p>
              </div>
            </OctantPopover>
          </OpenStage>
        </Specimen>
        <Specimen
          adapters={["OctantTooltip"]}
          props={`label="Copy path" side="bottom" surface="inverted"`}
          note="opens on hover or focus; the adapter has no open prop"
        >
          <OctantTooltip label="Copy path">
            <OctantButton type="button" variant="outline">
              Hover or focus me
            </OctantButton>
          </OctantTooltip>
        </Specimen>
        <Specimen
          adapters={["OctantTooltip"]}
          props={`surface="card"`}
          note="opens on hover or focus"
        >
          <OctantTooltip
            label={<span className="oct-row-detail">Structured content on the card surface</span>}
            surface="card"
          >
            <OctantButton type="button" variant="outline">
              Hover or focus me (card)
            </OctantButton>
          </OctantTooltip>
        </Specimen>
        <Specimen
          adapters={["OctantPreviewCard"]}
          props={`label="Project preview" side="bottom"`}
          note="opens on hover or focus after 350ms; the adapter has no open prop"
        >
          <OctantPreviewCard
            content={
              <div className="gallery-popover">
                <p className="oct-row-label">Octant</p>
                <p className="oct-row-detail">A card you can move into and click.</p>
              </div>
            }
            label="Project preview"
          >
            <OctantButton type="button" variant="outline">
              Hover or focus me (preview card)
            </OctantButton>
          </OctantPreviewCard>
        </Specimen>
      </Section>
      <Section
        caption="Dialogs, notices and toasts. The dialog is drawn inline with the shipped popup classes; the live ones open from the buttons."
        id="dialogs"
        title="Dialog, sheet, notice and toast"
      >
        <Specimen
          props={`.octant-dialog__popup, h2.octant-confirmation__title, p.octant-confirmation__description, .octant-dialog__actions`}
          note="the popup's own classes inline, not the component: the live OctantDialog is modal and portalled"
          wide
        >
          <div className="octant-dialog__popup gallery-dialog-inline">
            <h2 className="octant-confirmation__title">Remove this Project?</h2>
            <p className="octant-confirmation__description">Its threads stay in the archive.</p>
            <div className="octant-dialog__actions">
              <OctantButton type="button" variant="outline">
                Cancel
              </OctantButton>
              <OctantButton type="button" variant="destructive">
                Remove
              </OctantButton>
            </div>
          </div>
        </Specimen>
        <Specimen
          props={`<OctantConfirmDialog destructive />, <OctantSheet open />`}
          note="live and modal: opens over the page, Escape closes"
        >
          <LiveDialogs />
        </Specimen>
        {(["neutral", "accent", "success", "warning", "danger"] as const).map((tone) => (
          <Specimen
            adapters={["OctantAlert"]}
            key={tone}
            props={`tone="${tone}" title="Notice title" action={<OctantButton size="sm" />}`}
            wide
          >
            <OctantAlert
              action={
                <OctantButton size="sm" type="button" variant="outline">
                  Review
                </OctantButton>
              }
              tone={tone}
              title="Notice title"
            >
              The notice text, which can run to a second line when it needs to.
            </OctantAlert>
          </Specimen>
        ))}
        {(["neutral", "success", "warning", "danger"] as const).map((tone) => (
          <Specimen
            adapters={["OctantToast"]}
            key={tone}
            props={`tone="${tone}" action={{ label: "Open" }}`}
          >
            <OctantToast
              action={{ label: "Open", onSelect: noop }}
              detail="The toast's detail line."
              onDismiss={noop}
              title="Toast title"
              tone={tone}
            />
          </Specimen>
        ))}
        <Specimen adapters={["OctantApprovalCard"]} props={`label summary detail actions`} wide>
          <OctantApprovalCard
            actions={
              <>
                <OctantButton size="sm" type="button" variant="outline">
                  Deny
                </OctantButton>
                <OctantButton size="sm" type="button">
                  Allow
                </OctantButton>
              </>
            }
            detail="git push origin feature/gallery"
            label="Approval request"
            summary="Run a command"
          />
        </Specimen>
        <Specimen
          adapters={[
            "OctantCard",
            "OctantCardHeader",
            "OctantCardTitle",
            "OctantCardDescription",
            "OctantCardContent",
            "OctantCardFooter",
          ]}
          props={`variant="default" | "glass"`}
          wide
        >
          <div className="gallery-row gallery-row--top">
            {(["default", "glass"] as const).map((variant) => (
              <OctantCard className="gallery-card" key={variant} variant={variant}>
                <OctantCardHeader>
                  <OctantCardTitle>Card title</OctantCardTitle>
                  <OctantCardDescription>variant="{variant}"</OctantCardDescription>
                </OctantCardHeader>
                <OctantCardContent>
                  <p className="oct-row-detail">Body copy inside the card.</p>
                </OctantCardContent>
                <OctantCardFooter>
                  <OctantButton size="sm" type="button" variant="outline">
                    Action
                  </OctantButton>
                </OctantCardFooter>
              </OctantCard>
            ))}
          </div>
        </Specimen>
      </Section>
    </>
  );
}
