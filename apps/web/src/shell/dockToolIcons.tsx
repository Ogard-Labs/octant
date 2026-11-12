import {
  Activity,
  Bug,
  Bot,
  CircleDashed,
  FileStack,
  FileText,
  Files,
  FlaskConical,
  GitCompareArrows,
  GitPullRequest,
  Globe2,
  ListChecks,
  MessageCircle,
  Monitor,
  Smartphone,
  Tablet,
  SlidersHorizontal,
  SquareTerminal,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

const ICONS: Readonly<Record<RightUtilityDockSurfaceId, LucideIcon>> = {
  environment: SlidersHorizontal,
  browser: Globe2,
  canvas: FileStack,
  review: GitCompareArrows,
  "pull-requests": GitPullRequest,
  delivery: Truck,
  agents: Bot,
  files: Files,
  document: FileText,
  "ios-simulator": Smartphone,
  "android-emulator": Tablet,
  desktop: Monitor,
  debug: Bug,
  plan: ListChecks,
  "side-chat": MessageCircle,
  terminal: SquareTerminal,
  tests: FlaskConical,
  vitals: Activity,
};

export function dockToolIcon(surface: RightUtilityDockSurfaceId): LucideIcon {
  return ICONS[surface] ?? CircleDashed;
}

export function DockToolIcon(props: { readonly surface: RightUtilityDockSurfaceId }) {
  const Icon = dockToolIcon(props.surface);
  return <Icon aria-hidden="true" size={14} />;
}
