import type { LucideIcon } from "lucide-react";
import ActivityGlyph from "lucide-react/icons/activity";
import BlocksGlyph from "lucide-react/icons/blocks";
import BotGlyph from "lucide-react/icons/bot";
import CalendarClockGlyph from "lucide-react/icons/calendar-clock";
import CircleCheckGlyph from "lucide-react/icons/circle-check";
import CircleDotGlyph from "lucide-react/icons/circle-dot";
import CirclePlayGlyph from "lucide-react/icons/circle-play";
import CodeXmlGlyph from "lucide-react/icons/code-xml";
import EllipsisGlyph from "lucide-react/icons/ellipsis";
import EyeGlyph from "lucide-react/icons/eye";
import FolderOpenGlyph from "lucide-react/icons/folder-open";
import FoldersGlyph from "lucide-react/icons/folders";
import GitPullRequestArrowGlyph from "lucide-react/icons/git-pull-request-arrow";
import HouseGlyph from "lucide-react/icons/house";
import ImagesGlyph from "lucide-react/icons/images";
import InboxGlyph from "lucide-react/icons/inbox";
import LayersGlyph from "lucide-react/icons/layers";
import ListTodoGlyph from "lucide-react/icons/list-todo";
import MessageSquareGlyph from "lucide-react/icons/message-square";
import SearchGlyph from "lucide-react/icons/search";
import SettingsGlyph from "lucide-react/icons/settings";
import SquareCheckGlyph from "lucide-react/icons/square-check";
import SquareKanbanGlyph from "lucide-react/icons/square-kanban";
import SquarePenGlyph from "lucide-react/icons/square-pen";
import {
  Blocks,
  Bot,
  CalendarClock,
  CircleCheck,
  CircleDot,
  CirclePlay,
  CodeXml,
  Ellipsis,
  Eye,
  FolderOpen,
  Folders,
  GitPullRequestArrow,
  House,
  Images,
  Inbox,
  Layers,
  ListTodo,
  MessageSquare,
  ScrollText,
  Search,
  Settings,
  SquareCheck,
  SquareKanban,
  SquarePen,
  type IconComponent,
} from "./index";

export type RailGlyph = LucideIcon;

/**
 * The icon rail draws its places in the stroked family the person chose for it
 * (maintainer decision, 2026-11-17): even lines with round ends read lighter in
 * a column of icons with no words beside them than the filled outlines the
 * rest of the app keeps. Keyed by the app's own icon, so a rail call site keeps
 * naming the icon it means and only the rail's drawing changes. An icon with
 * no entry here is drawn in the app's own family.
 */
const RAIL_GLYPHS: ReadonlyMap<IconComponent, RailGlyph> = new Map<IconComponent, RailGlyph>([
  [House, HouseGlyph],
  [Inbox, InboxGlyph],
  [SquareCheck, SquareCheckGlyph],
  [SquareKanban, SquareKanbanGlyph],
  [GitPullRequestArrow, GitPullRequestArrowGlyph],
  [CircleDot, CircleDotGlyph],
  [ListTodo, ListTodoGlyph],
  [Folders, FoldersGlyph],
  [SquarePen, SquarePenGlyph],
  [Search, SearchGlyph],
  [CalendarClock, CalendarClockGlyph],
  [Bot, BotGlyph],
  [Blocks, BlocksGlyph],
  [Layers, LayersGlyph],
  [Images, ImagesGlyph],
  // The Activity feed's place reads as a pulse line in the rail.
  [ScrollText, ActivityGlyph],
  [Settings, SettingsGlyph],
  [Ellipsis, EllipsisGlyph],
  [MessageSquare, MessageSquareGlyph],
  [FolderOpen, FolderOpenGlyph],
  [CodeXml, CodeXmlGlyph],
  [Eye, EyeGlyph],
  [CirclePlay, CirclePlayGlyph],
  [CircleCheck, CircleCheckGlyph],
]);

export function railGlyph(icon: IconComponent): RailGlyph | undefined {
  return RAIL_GLYPHS.get(icon);
}
