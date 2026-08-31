import { Aperture, Compass, GraduationCap, ListChecks, PenLine } from "lucide-react";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import type { ChatControllerStatus } from "./useChatController";
import { HostSelector } from "../shell/HostSelector";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import {
  draftThreadModePresentation,
  type CreateHostViewScope,
  type ModelPickerSelection,
  type PickerGroup,
} from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { ThreadComposer } from "../composer/ThreadComposer";
import type { DraftRecentThread } from "../shell/DraftThreadWorkspace";
import { RecentThreadList } from "../shell/RecentThreadList";

export interface ChatWelcomeProps {
  /** The threads this mode already has, shown under the starter ideas. */
  readonly recentThreads?: ReadonlyArray<DraftRecentThread>;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedHostId?: HostId;
  readonly fixedHostId?: HostId;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly viewScope?: CreateHostViewScope;
  readonly onSelectHost?: (hostId: HostId) => void;
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onCreateChat: (prompt: string) => void;
  readonly onSelectProvider?: (selection: ModelPickerSelection) => void;
  readonly onOpenSettings?: () => void;
  readonly onRetry?: () => void;
  readonly status?: ChatControllerStatus;
}

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

export function ChatWelcome(props: ChatWelcomeProps) {
  const ready = props.status === undefined || props.status === "ready";
  const presentation = draftThreadModePresentation("chat");
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && ready && !props.creating;
  const statusMessage =
    props.errorMessage ??
    (props.status === "loading"
      ? "Connecting to Chat…"
      : props.status === "conflict-reload"
        ? "Reloading Chat…"
        : props.status === "disconnected"
          ? "Chat is disconnected."
          : undefined);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    props.onCreateChat(trimmed);
  }, [canSubmit, props, trimmed]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section aria-label="Chat welcome" className="draft-thread chat-welcome">
      <div className="draft-thread__canvas">
        <div className="draft-thread__welcome">
          <Aperture
            aria-hidden="true"
            className="new-thread-welcome__mark"
            size={24}
            strokeWidth={1.4}
          />
          <p className="draft-thread__eyebrow">Octant Chat</p>
          <h1 className="draft-thread__heading">{presentation.heading}</h1>
          <p className="draft-thread__description">{presentation.description}</p>
        </div>

        <div className="draft-thread__composer">
          <ThreadComposer
            input={
              <OctantTextarea
                aria-label="First message"
                autoFocus
                className="composer-input"
                disabled={!ready || props.creating}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={presentation.composerPlaceholder}
                ref={textareaRef}
                rows={3}
                value={prompt}
              />
            }
            row={{
              ariaLabel: "Thread context",
              leading: (
                <>
                  <HostSelector
                    {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
                    {...(props.selectedHostId === undefined
                      ? {}
                      : { selectedHostId: props.selectedHostId })}
                    {...(props.fixedHostId === undefined ? {} : { fixedHostId: props.fixedHostId })}
                    {...(props.lastSelectedHealthyHostId === undefined
                      ? {}
                      : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
                    {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
                    {...(props.onSelectHost === undefined
                      ? {}
                      : { onSelectHost: props.onSelectHost })}
                    requiredCapability="chat"
                  />
                  <ComposerModelPicker
                    ariaLabel="Provider and model"
                    disabled={!ready || props.creating === true}
                    groups={props.providerGroups ?? []}
                    menuSide="bottom"
                    onSelect={props.onSelectProvider ?? (() => undefined)}
                    {...(props.onOpenSettings === undefined
                      ? {}
                      : { onOpenSettings: props.onOpenSettings })}
                    {...(props.selectedModelId === undefined
                      ? {}
                      : { selectedModelId: props.selectedModelId })}
                    {...(props.selectedProviderInstanceId === undefined
                      ? {}
                      : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
                  />
                </>
              ),
              actions: {
                kind: "send",
                send: { ariaLabel: "Start chat", disabled: !canSubmit, onSend: submit },
              },
            }}
          />
          {statusMessage === undefined ? null : (
            <p className="draft-thread__error" role="alert">
              {statusMessage}
            </p>
          )}
          {!ready && props.status === "disconnected" && props.onRetry !== undefined ? (
            <OctantButton
              className="chat-welcome__retry"
              onClick={props.onRetry}
              type="button"
              variant="ghost"
            >
              Retry Chat
            </OctantButton>
          ) : null}
        </div>
        <p className="draft-thread__hint">
          Press Enter to start · Shift+Enter for a new line · Starts unfiled until you add a Project
        </p>
        <div aria-label="Starter ideas" className="chat-welcome__suggestions" role="group">
          {starterIdeas.map((idea) => {
            const Icon = idea.icon;
            return (
              <OctantButton
                disabled={!ready || props.creating}
                key={idea.label}
                onClick={() => {
                  setPrompt(idea.prompt);
                  textareaRef.current?.focus();
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Icon aria-hidden="true" size={14} strokeWidth={1.7} />
                {idea.label}
              </OctantButton>
            );
          })}
        </div>
        <RecentThreadList threads={props.recentThreads ?? []} />
      </div>
    </section>
  );
}
