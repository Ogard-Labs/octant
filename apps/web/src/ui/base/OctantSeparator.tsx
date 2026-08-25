import type { ComponentProps } from "react";
import { Separator, SeparatorWithLabel } from "../shadcn/separator";

export function OctantSeparator(props: ComponentProps<typeof Separator>) {
  return <Separator {...props} />;
}

export function OctantSeparatorWithLabel(props: ComponentProps<typeof SeparatorWithLabel>) {
  return <SeparatorWithLabel {...props} />;
}
