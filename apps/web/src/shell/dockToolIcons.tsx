import {
  Bot,
  FileStack,
  Files,
  FlaskConical,
  GitCompareArrows,
  Globe2,
  ListChecks,
  MessageCircle,
  Smartphone,
  SquareTerminal,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

const ICONS: Readonly<Record<RightUtilityDockSurfaceId, LucideIcon>> = {
  browser: Globe2,
  canvas: FileStack,
  review: GitCompareArrows,
  delivery: Truck,
  agents: Bot,
  files: Files,
  "ios-simulator": Smartphone,
  plan: ListChecks,
  "side-chat": MessageCircle,
  terminal: SquareTerminal,
  tests: FlaskConical,
};

export function DockToolIcon(props: { readonly surface: RightUtilityDockSurfaceId }) {
  const Icon = ICONS[props.surface];
  return <Icon aria-hidden="true" size={14} strokeWidth={1.5} />;
}
