import { NewThreadDraft } from "@octant/contracts/thread-draft";
import type { OctantMode } from "@octant/contracts/modes";

/** Mode-specific welcome copy and intent card descriptors. */
export interface DraftThreadModePresentation {
  readonly mode: OctantMode;
  readonly eyebrow: string;
  readonly heading: string;
  readonly description: string;
  readonly composerPlaceholder: string;
  readonly intentCards: ReadonlyArray<DraftIntentCard>;
}

export interface DraftIntentCard {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** Build mode-specific welcome presentation for the draft-thread workspace. */
export function draftThreadModePresentation(
  mode: NewThreadDraft["mode"],
): DraftThreadModePresentation {
  switch (mode) {
    case "chat":
      return {
        mode,
        eyebrow: "Octant Chat",
        heading: "What are you working on?",
        description:
          "Start a calm, focused conversation. Place it in a virtual Project when it becomes a shared workspace.",
        composerPlaceholder: "Ask anything…",
        intentCards: [
          {
            id: "explain",
            label: "Explain a concept",
            description: "Break down a topic into clear, digestible parts.",
          },
          {
            id: "draft",
            label: "Draft text",
            description: "Write emails, summaries, or documents together.",
          },
          {
            id: "brainstorm",
            label: "Brainstorm ideas",
            description: "Explore possibilities and refine your thinking.",
          },
        ],
      };
    case "work":
      return {
        mode,
        eyebrow: "Octant Work",
        heading: "What are we working on?",
        description:
          "Start a work thread inside this confined folder. Documents, presentations, spreadsheets, reports, and artifacts stay local.",
        composerPlaceholder: "Describe the work…",
        intentCards: [
          {
            id: "document",
            label: "Create a document",
            description: "Draft, edit, and review documents in your project folder.",
          },
          {
            id: "analyze",
            label: "Analyze files",
            description: "Review spreadsheets, PDFs, or images in this project.",
          },
          {
            id: "plan",
            label: "Plan and organize",
            description: "Structure work, set milestones, and track progress.",
          },
        ],
      };
    case "code":
      return {
        mode,
        eyebrow: "Octant Code",
        heading: "What should we build?",
        description:
          "Start a Code thread in this repository. The thread inherits the current checkout and approval policy.",
        composerPlaceholder: "What should we build?",
        intentCards: [
          {
            id: "implement",
            label: "Implement a feature",
            description: "Build new functionality with tests and review.",
          },
          {
            id: "fix",
            label: "Fix a bug",
            description: "Diagnose, reproduce, and resolve an issue.",
          },
          {
            id: "refactor",
            label: "Refactor code",
            description: "Improve structure while keeping behavior intact.",
          },
        ],
      };
  }
}

/**
 * The welcome's greeting for the hour, with the person's name when one is
 * known. Morning runs to noon, afternoon to six, and evening is the rest,
 * night included: "Good night" reads as a farewell, not a hello.
 */
export function welcomeGreeting(input: {
  readonly hour: number;
  readonly name?: string | undefined;
}): string {
  const hour = ((Math.trunc(input.hour) % 24) + 24) % 24;
  const time =
    hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
  const name = input.name?.trim();
  return name === undefined || name.length === 0 ? `Good ${time}` : `Good ${time}, ${name}`;
}
