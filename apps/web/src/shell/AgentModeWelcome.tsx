import type { OctantMode } from "@octant/contracts/modes";
import { FolderOpen, FolderPlus, SquarePen } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface AgentModeWelcomeProps {
  readonly mode: Extract<OctantMode, "work" | "code">;
  /** Whether a Project is already bound; the page then leads with a new task. */
  readonly hasProjects?: boolean;
  readonly onAddFolder: () => void;
  readonly onOpenDraft?: () => void;
  readonly providerReady: boolean;
  readonly providerMessage?: string;
}

interface Presentation {
  readonly name: string;
  readonly heading: string;
  readonly lead: string;
  readonly newTask: string;
}

/* The first visit asks for one thing, a folder, and says in plain words what
   choosing it means. The page it replaced opened on "Bind a confined folder"
   and "the harness composer", which named the mechanism instead of the
   outcome. */
const withoutProjects: Record<AgentModeWelcomeProps["mode"], Presentation> = {
  work: {
    name: "Work",
    heading: "Pick a folder to work in",
    lead: "Work reads and edits the documents, decks, and spreadsheets in one folder you choose. It can’t change anything outside it.",
    newTask: "Start without a folder",
  },
  code: {
    name: "Code",
    heading: "Pick a folder to code in",
    lead: "Code works inside one folder you choose and asks before it changes a file.",
    newTask: "Start without a folder",
  },
};

/* Once a folder is bound the page is a starting point, not setup: it leads
   with the task and keeps adding a folder as the second thing to do. */
const withProjects: Record<AgentModeWelcomeProps["mode"], Presentation> = {
  work: {
    name: "Work",
    heading: "Start a task",
    lead: "Pick a Project in the sidebar, or start here and choose one as you go.",
    newTask: "Start a new task",
  },
  code: {
    name: "Code",
    heading: "Start a Code thread",
    lead: "Pick a Project in the sidebar, or start here and choose one as you go.",
    newTask: "Start a new thread",
  },
};

export function AgentModeWelcome(props: AgentModeWelcomeProps) {
  const leadsWithTask = props.hasProjects === true;
  const presentation = (leadsWithTask ? withProjects : withoutProjects)[props.mode];
  const addFolder = (
    <OctantButton
      onClick={props.onAddFolder}
      size="lg"
      type="button"
      variant={leadsWithTask ? "ghost" : "default"}
    >
      <FolderPlus aria-hidden="true" size={16} strokeWidth={1.8} />
      {leadsWithTask ? "Add another folder" : "Choose a folder…"}
    </OctantButton>
  );
  const newTask =
    props.onOpenDraft === undefined ? null : (
      <OctantButton
        disabled={!props.providerReady}
        onClick={props.onOpenDraft}
        size="lg"
        type="button"
        variant={leadsWithTask ? "default" : "ghost"}
      >
        {leadsWithTask ? <SquarePen aria-hidden="true" size={16} strokeWidth={1.8} /> : null}
        {presentation.newTask}
      </OctantButton>
    );
  return (
    <section
      aria-label={`${presentation.name} welcome`}
      className="draft-thread agent-mode-welcome"
    >
      <div className="agent-mode-welcome__panel">
        <span aria-hidden="true" className="agent-mode-welcome__mark">
          <FolderOpen size={20} strokeWidth={1.6} />
        </span>
        <h1 className="oct-title oct-title--hero">{presentation.heading}</h1>
        <p className="agent-mode-welcome__lead">{presentation.lead}</p>
        <div className="agent-mode-welcome__actions">
          {leadsWithTask ? newTask : addFolder}
          {leadsWithTask ? addFolder : newTask}
        </div>
        {props.providerMessage === undefined ? null : (
          <p className="draft-thread__error" role="status">
            {props.providerMessage}
          </p>
        )}
        {props.providerReady ? null : (
          <p className="draft-thread__hint" role="status">
            Looking for AI providers on this computer… If this takes more than a few seconds,
            connect one in Settings.
          </p>
        )}
      </div>
    </section>
  );
}
