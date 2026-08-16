/**
 * Legacy token path — re-exports the mobile design system.
 * Prefer importing from `apps/mobile/design-system` for new code.
 * `mobileColors` is the static light palette; runtime UI should use `useTheme()`.
 */
export {
  colors as mobileColors,
  lightColors,
  darkColors,
  space as mobileSpacing,
  radii as mobileRadii,
  typography as mobileTypography,
} from "../../design-system";
