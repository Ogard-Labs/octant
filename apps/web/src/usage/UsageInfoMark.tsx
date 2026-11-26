import { useState } from "react";
import { OctantPopover } from "../ui/base/OctantPopover";
import { Info } from "../ui/icons";
import "./usageInfoMark.css";

/**
 * The explanation behind a reading, kept off the page until asked for. A
 * popover rather than a tooltip, so a press opens it on touch and with the
 * keyboard as well as on hover.
 */
export function UsageInfoMark(props: { readonly label: string; readonly children: string }) {
  const [open, setOpen] = useState(false);
  return (
    <OctantPopover
      className="usage-info-mark__popup"
      onOpenChange={setOpen}
      open={open}
      openOnHover
      title={props.label}
      trigger={<Info aria-hidden="true" size={14} />}
      triggerClassName="usage-info-mark"
      triggerLabel={props.label}
      triggerVariant="ghost-icon"
    >
      <p>{props.children}</p>
    </OctantPopover>
  );
}
