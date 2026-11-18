import { StartSuggestionChip } from "../composer/StartSuggestionChip";
import { Compass, GraduationCap, ListChecks, PenLine } from "../ui/icons";

const starterIdeas = [
  {
    label: "Write",
    prompt: "Draft something clear and concise, then help me refine it.",
    icon: PenLine,
  },
  {
    label: "Learn",
    prompt: "Explain a concept clearly, then check my understanding.",
    icon: GraduationCap,
  },
  {
    label: "Plan",
    prompt: "Turn this goal into a practical plan with clear next steps.",
    icon: ListChecks,
  },
  {
    label: "Explore",
    prompt: "Help me explore the options, tradeoffs, and open questions.",
    icon: Compass,
  },
] as const;

/**
 * Chat's starter ideas, shown before its first thread on Chat home and on a
 * new chat alike. They once stood on home only, so pressing New chat took
 * them away and moved the list under them (seen 2026-11-16). Choosing one
 * fills the composer and sends nothing.
 */
export function ChatStarterIdeas(props: {
  readonly disabled: boolean;
  readonly onChoose: (prompt: string) => void;
}) {
  return (
    <div aria-label="Starter ideas" className="chat-welcome__suggestions" role="group">
      {starterIdeas.map((idea) => {
        const Icon = idea.icon;
        return (
          <StartSuggestionChip
            disabled={props.disabled}
            key={idea.label}
            onClick={() => props.onChoose(idea.prompt)}
          >
            <Icon aria-hidden="true" size={14} />
            {idea.label}
          </StartSuggestionChip>
        );
      })}
    </div>
  );
}
