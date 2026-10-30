import { useDraftModelOptions } from "../providers/useDraftModelOptions";
import {
  ComposerSlashTypeahead,
  useComposerSlashCommands,
} from "../composer/useComposerSlashCommands";
import { ComposerAtTypeahead, useComposerAtMenu } from "../composer/useComposerAtMenu";
import { useExtensionDraftSelections } from "./useExtensionDraftSelections";
import { providerFamilyForThread } from "../providers/providerFamily";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import { Compass, GraduationCap, ListChecks, PenLine } from "lucide-react";
import { useNewTaskPrompt } from "../composer/useNewTaskPrompt";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import type { ChatControllerStatus } from "./useChatController";
import { HostSelector } from "../shell/HostSelector";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
} from "@octant/contracts/providers";
import {
  draftThreadModePresentation,
  type CreateHostViewScope,
  type ModelPickerSelection,
  type PickerGroup,
} from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { StartSuggestionChip } from "../composer/StartSuggestionChip";
import { ComposerAttachButton } from "../composer/ComposerAttachButton";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { ThreadComposer } from "../composer/ThreadComposer";
import { WelcomeHeading } from "../composer/WelcomeHeading";
import { ComposerVoiceButton } from "../voice/ComposerVoiceButton";
import { appendTranscript } from "../voice/appendTranscript";
import type { DraftRecentThread } from "../shell/DraftThreadWorkspace";
import {
  unattachedCapabilityMentionCopy,
  unattachedCapabilityMentions,
} from "@octant/plugin-host/capability-mentions";
import { WorkKindSwitch } from "../shell/WorkKindSwitch";

export interface ChatWelcomeProps {
  /**
   * The threads this mode already has. The start screen lists none of them
   * (the sidebar does); it offers starter ideas only while there are none.
   */
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
  /** Reads the effective skills and servers the `@` list offers. Absent: `@` lists none. */
  readonly extensionClient?: ExtensionClient;
  readonly onCreateChat: (
    prompt: string,
    modelOptionValues?: ProviderModelOptionValues,
    extensionSelections?: ReadonlyArray<ExtensionSelection>,
  ) => void;
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
  const [prompt, setPrompt] = useNewTaskPrompt();
  const [attachmentNotice, setAttachmentNotice] = useState<string>();
  // This composer has no suggestion list, so a capability token typed here can
  // only ever leave as unattached prose; the refusal says where one attaches.
  const [sendNotice, setSendNotice] = useState<string>();
  const slash = useComposerSlashCommands({
    draft: prompt,
    onDraftChange: setPrompt,
    textarea: () => textareaRef.current,
  });
  const family = providerFamilyForThread(props.providerGroups, props.selectedProviderInstanceId);
  const extensionDraft = useExtensionDraftSelections({
    ...(props.extensionClient === undefined ? {} : { client: props.extensionClient }),
    mode: "chat",
    providerCarriesTools: false,
    projectId: null,
    ...(family === undefined ? {} : { providerFamily: family }),
  });
  const atMenu = useComposerAtMenu({
    draft: prompt,
    onDraftChange: setPrompt,
    textarea: () => textareaRef.current,
    ...(props.extensionClient === undefined
      ? {}
      : { onResolveExtensionReference: extensionDraft.resolveReference }),
  });
  const { modelKey, modelOptionValues, setModelChoice } = useDraftModelOptions(
    props.providerGroups ?? [],
    props.selectedProviderInstanceId,
    props.selectedModelId,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && ready && !props.creating && !atMenu.resolving;
  const statusMessage =
    props.errorMessage ??
    (props.status === "loading"
      ? "Connecting to Chat…"
      : props.status === "conflict-reload"
        ? "Reloading Chat…"
        : props.status === "disconnected"
          ? "Chat is disconnected."
          : undefined);
  const visibleStatusMessage = statusMessage ?? sendNotice ?? attachmentNotice;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    const extensionSelections = extensionDraft.receipts.flatMap((receipt) =>
      receipt.selection === undefined ? [] : [receipt.selection],
    );
    const unattachedMentions = unattachedCapabilityMentions(trimmed, extensionSelections);
    if (unattachedMentions.length > 0) {
      setSendNotice(unattachedCapabilityMentionCopy(unattachedMentions, false));
      return;
    }
    setSendNotice(undefined);
    const options = Object.keys(modelOptionValues).length === 0 ? undefined : modelOptionValues;
    if (extensionSelections.length > 0) {
      props.onCreateChat(trimmed, options, extensionSelections);
      extensionDraft.clear();
    } else if (options === undefined) props.onCreateChat(trimmed);
    else props.onCreateChat(trimmed, options);
  }, [canSubmit, extensionDraft, props, trimmed, modelOptionValues]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (atMenu.handleKeyDown(event)) return;
    if (slash.handleKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section aria-label="Chat welcome" className="draft-thread chat-welcome">
      <div className="welcome">
        <div className="welcome__heading">
          <WelcomeHeading />
        </div>
        <div className="composer-stack">
          <ThreadComposer
            planUsage={{
              providerInstanceId:
                props.selectedProviderInstanceId === undefined
                  ? undefined
                  : String(props.selectedProviderInstanceId),
            }}
            startContext={
              <div className="composer-tray composer-tray--inside" aria-label="Thread context">
                <div className="composer-tray__leading">
                  <WorkKindSwitch />
                  <HostSelector
                    presentation="environment"
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
                </div>
              </div>
            }
            input={
              <OctantTextarea
                aria-activedescendant={
                  atMenu.active !== undefined
                    ? `${atMenu.listId}-${atMenu.active.id}`
                    : slash.active === undefined
                      ? undefined
                      : `${slash.listId}-${slash.active.id}`
                }
                aria-autocomplete={slash.commandIds.length === 0 ? undefined : "list"}
                aria-controls={atMenu.open ? atMenu.listId : slash.open ? slash.listId : undefined}
                aria-expanded={
                  slash.commandIds.length === 0 && !atMenu.open
                    ? undefined
                    : atMenu.open || slash.open
                }
                aria-label="First message"
                autoFocus
                className="composer-input"
                disabled={!ready || props.creating}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setAttachmentNotice(undefined);
                  slash.sync(event.target.value, event.currentTarget.selectionStart);
                  atMenu.sync(event.target.value, event.currentTarget.selectionStart);
                }}
                onClick={(event) => {
                  slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                  atMenu.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onKeyDown={handleKeyDown}
                placeholder={presentation.composerPlaceholder}
                ref={textareaRef}
                rows={3}
                value={prompt}
              />
            }
            chips={
              extensionDraft.receipts.length > 0 ? (
                <ul aria-label="Selected extensions" className="composer-chips">
                  {extensionDraft.receipts.map((receipt) => (
                    <li className="chip" key={receipt.reference}>
                      <span>{receipt.label}</span>
                      {receipt.status.kind === "blocked" ? (
                        <span>{`Blocked: ${receipt.status.reason}`}</span>
                      ) : null}
                      <OctantButton
                        aria-label={`Remove ${receipt.label} extension`}
                        className="chip-x window-no-drag"
                        onClick={() => extensionDraft.remove(receipt.reference)}
                        type="button"
                        variant="bare"
                      >
                        ×
                      </OctantButton>
                    </li>
                  ))}
                </ul>
              ) : undefined
            }
            typeahead={
              atMenu.open ? (
                <ComposerAtTypeahead controller={atMenu} />
              ) : slash.open ? (
                <ComposerSlashTypeahead controller={slash} />
              ) : undefined
            }
            row={{
              leading: (
                <>
                  <ComposerAttachButton
                    refusedReason="Attachments can be added once the chat starts."
                    onRefused={setAttachmentNotice}
                    onFileSelected={() => undefined}
                  />
                </>
              ),
              trailing: (
                <>
                  <ComposerModelPicker
                    ariaLabel="Provider and model"
                    disabled={!ready || props.creating === true}
                    groups={props.providerGroups ?? []}
                    menuSide="bottom"
                    modelOptionValues={modelOptionValues}
                    onModelOptionChange={(id, value) => {
                      const rest = Object.fromEntries(
                        Object.entries(modelOptionValues).filter(([key]) => key !== id),
                      );
                      setModelChoice({
                        key: modelKey,
                        values: value === undefined ? rest : { ...rest, [id]: value },
                      });
                    }}
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
                  <ComposerVoiceButton
                    disabled={!ready || props.creating === true}
                    onTranscript={(transcript) =>
                      setPrompt((current) => appendTranscript(current, transcript))
                    }
                  />
                </>
              ),
              actions: {
                kind: "send",
                send: { ariaLabel: "Start chat", disabled: !canSubmit, onSend: submit },
              },
            }}
          />
        </div>
        {visibleStatusMessage === undefined ? null : (
          /* ui-boundary-exception: compact-status */
          <p
            className="draft-thread__error"
            role={props.errorMessage === undefined ? "status" : "alert"}
          >
            {visibleStatusMessage}
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
        {(props.recentThreads?.length ?? 0) === 0 ? (
          <div aria-label="Starter ideas" className="chat-welcome__suggestions" role="group">
            {starterIdeas.map((idea) => {
              const Icon = idea.icon;
              return (
                <StartSuggestionChip
                  disabled={!ready || props.creating}
                  key={idea.label}
                  onClick={() => {
                    setPrompt(idea.prompt);
                    textareaRef.current?.focus();
                  }}
                >
                  <Icon aria-hidden="true" size={14} strokeWidth={1.7} />
                  {idea.label}
                </StartSuggestionChip>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
