import type { ResolvedTheme } from "@octant/theme/fallback";
import type { ApprovalSurfacePalette } from "../shell/hostBridge";

/**
 * The approval view is desktop-owned and cannot read this window's stylesheet,
 * so a window reports the roles it has already resolved. A theme that is
 * missing one of these roles is not the source of this window's paint, and the
 * desktop keeps drawing the system palette on its own.
 */
export function approvalSurfacePalette(
  resolved: ResolvedTheme,
): ApprovalSurfacePalette | undefined {
  const role = (id: string): string | undefined => resolved.tokens[id];
  const surface = role("floating");
  const text = role("text-primary");
  const muted = role("text-secondary");
  const border = role("border");
  const control = role("control");
  const controlHover = role("control-hover");
  const accent = role("accent");
  const accentForeground = role("accent-foreground");
  if (
    surface === undefined ||
    text === undefined ||
    muted === undefined ||
    border === undefined ||
    control === undefined ||
    controlHover === undefined ||
    accent === undefined ||
    accentForeground === undefined
  ) {
    return undefined;
  }
  return {
    mode: resolved.mode,
    accent,
    accentForeground,
    border,
    control,
    controlHover,
    muted,
    surface,
    text,
  };
}
