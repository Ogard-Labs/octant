import type { IconComponent } from "../ui/icons";
import { forwardRef } from "react";
import { OctantIconButton, type OctantIconButtonProps } from "../ui/base/OctantButton";

export interface IconButtonProps extends Omit<OctantIconButtonProps, "children" | "label"> {
  readonly icon: IconComponent;
  readonly label: string;
}

/** Shell icon control backed by the Octant/shadcn button recipe. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, icon: Icon, label, title = label, ...buttonProps },
  ref,
) {
  return (
    <OctantIconButton {...buttonProps} className={className} label={label} ref={ref} title={title}>
      <Icon aria-hidden="true" size={16} />
    </OctantIconButton>
  );
});
