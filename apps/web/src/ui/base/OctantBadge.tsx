import type { ComponentProps } from "react";
import { Badge } from "../shadcn/badge";

export type OctantBadgeProps = ComponentProps<typeof Badge>;

/** Compact status label using the owned shadcn badge recipe. */
export function OctantBadge(props: OctantBadgeProps) {
  return <Badge {...props} />;
}
