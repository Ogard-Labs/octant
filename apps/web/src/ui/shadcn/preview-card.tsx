import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import type { ComponentProps } from "react";

export function PreviewCard(props: ComponentProps<typeof PreviewCardPrimitive.Root>) {
  return <PreviewCardPrimitive.Root {...props} />;
}

export function PreviewCardTrigger(props: ComponentProps<typeof PreviewCardPrimitive.Trigger>) {
  return <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />;
}

export function PreviewCardPortal(props: ComponentProps<typeof PreviewCardPrimitive.Portal>) {
  return <PreviewCardPrimitive.Portal {...props} />;
}

export function PreviewCardPositioner(
  props: ComponentProps<typeof PreviewCardPrimitive.Positioner>,
) {
  return <PreviewCardPrimitive.Positioner data-slot="preview-card-positioner" {...props} />;
}

export function PreviewCardPopup(props: ComponentProps<typeof PreviewCardPrimitive.Popup>) {
  return <PreviewCardPrimitive.Popup data-slot="preview-card-content" {...props} />;
}
