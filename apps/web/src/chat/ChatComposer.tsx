import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Globe2, Paperclip, Slash, SlidersHorizontal, X } from "lucide-react";
import type { ChatAttachmentId } from "@octant/contracts/chat";
import { clipboardHasImage, collectPastedImages } from "./composerImagePaste";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
  type ThreadMentionChip,
  type ThreadMentions,
} from "./ThreadMentionPicker";
import type {
  CanvasContextSelection,
  CanvasContextSelectionId,
} from "@octant/contracts/canvasContext";
import type {
  PreviewContextSelection,
  PreviewContextSelectionId,
} from "@octant/contracts/previews";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { ImageGenerationProfileView, ImageGenerationScopeId } from "@octant/contracts";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { ImageGenerationAction } from "../image/ImageGenerationAction";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { applyComposerCaret } from "../composer/composerThreadDraftStore";
import { markInteraction, markInteractionAfterPaint } from "../polling/interactionTrace";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { useOctantCommands } from "../palette/CommandRegistry";
import {
  applySlashCommandToken,
  filterOctantCommands,
  parseSlashCommandToken,
  type OctantCommand,
  type SlashCommandToken,
} from "../palette/commandModel";

export type ChatComposerResearchRouting = "automatic" | "searxng" | "provider-native";

export interface ChatComposerOption {
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly id: string;
  readonly label: string;
}

export interface ChatComposerSelection {
  readonly options: ReadonlyArray<ChatComposerOption>;
  readonly value: string;
}

export type ChatComposerAttachmentCapability =
  | { readonly kind: "supported" }
  | { readonly kind: "unavailable"; readonly reason: string };

export type ChatComposerResearchBackend =
  | { readonly kind: "disabled" }
  | { readonly kind: "selected"; readonly backend: "searxng" | "provider-native" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ChatComposerResearch {
  readonly backend: ChatComposerResearchBackend;
  readonly enabled: boolean;
  readonly routing: ChatComposerResearchRouting;
}

/**
 * One selectable option the selected model declares (effort, reasoning, speed
 * tier). `value` is the thread's current choice; absent means provider default.
 */
export interface ChatComposerModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly values: ReadonlyArray<string>;
  readonly value?: string;
}

/**
 * Sentinel select id for "use the provider default". Provider option values
 * are trimmed tokens (`low`, `fast`), so a value with spaces never collides.
 */
const MODEL_OPTION_DEFAULT_ID = "(provider default)";

export interface ChatComposerProps {
  /** Caller-owned pending text. The component never persists or clears this value itself. */
  readonly draft: string;
  /** Restored caret for this thread. Applied when `caretRestoreKey` changes. */
  readonly caretIndex?: number;
  /** Identity of the thread whose caret should be restored, typically its id. */
  readonly caretRestoreKey?: string;
  readonly onCaretIndexChange?: (caretIndex: number) => void;
  readonly isSending: boolean;
  readonly model: ChatComposerSelection;
  readonly onDraftChange: (draft: string, caretIndex?: number) => void;
  /** Receives the browser-selected File only; file paths are not accepted or exposed. */
  readonly onFileSelected: (file: File) => void;
  readonly onModelChange: (modelId: string) => void;
  readonly onProviderChange: (providerId: string) => void;
  readonly onResearchEnabledChange: (enabled: boolean) => void;
  readonly onResearchRoutingChange: (routing: ChatComposerResearchRouting) => void;
  /** Returns true only when the caller's authoritative send operation succeeded. */
  readonly onSend: (draft: string) => Promise<boolean> | boolean;
  readonly onStop?: () => void;
  /**
   * A follow-up parked in this composer while a turn is running. The draft
   * stays here so it can be edited or discarded; the caller sends it through
   * the ordinary path when the turn completes.
   */
  readonly queueStatus?: "idle" | "queued" | "held";
  readonly onDiscardQueued?: () => void;
  readonly provider: ChatComposerSelection;
  readonly research: ChatComposerResearch;
  /**
   * When picker groups are provided (with `onSelectModel`), the composer
   * renders the shared searchable provider/model picker instead of the
   * fallback native selects.
   */
  readonly providerGroups?: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelectModel?: (selection: ModelPickerSelection) => void;
  /** Lets the model picker's "no provider ready" state open Settings. */
  readonly onOpenSettings?: () => void;
  readonly attachment?: ChatComposerAttachmentCapability;
  /**
   * Image-specific capability. Pasting an image is offered only while
   * this is `supported`; an unavailable provider/model keeps the clipboard
   * bytes unread and surfaces the host's reason instead.
   */
  readonly imageAttachment?: ChatComposerAttachmentCapability;
  /** Called with a user-facing reason when a pasted image was not attached. */
  readonly onImagePasteRejected?: (reason: string) => void;
  readonly attachmentBusy?: boolean;
  readonly pendingAttachments?: ReadonlyArray<{
    readonly id: ChatAttachmentId;
    readonly displayName: string;
  }>;
  readonly onRemoveAttachment?: (attachmentId: ChatAttachmentId) => void;
  /**
   * Explicit, source-versioned preview selections attached as agent context.
   * Each is separately removable before send; the host reauthorizes the
   * opaque target and rechecks the source version at send time.
   */
  readonly pendingPreviewSelections?: ReadonlyArray<PreviewContextSelection>;
  readonly onRemovePreviewSelection?: (selectionId: PreviewContextSelectionId) => void;
  readonly pendingCanvasSelections?: ReadonlyArray<CanvasContextSelection>;
  readonly onRemoveCanvasSelection?: (selectionId: CanvasContextSelectionId) => void;
  readonly pendingExtensionSelections?: ReadonlyArray<ChatComposerExtensionSelection>;
  readonly onRemoveExtensionSelection?: (reference: string) => void;
  readonly threadMentions?: ChatComposerThreadMentions;
  /** Compact opt-in multi-model pool control, rendered by the caller. */
  readonly poolControl?: ReactNode;
  /** Model options declared by the selected model, rendered beside the picker. */
  readonly modelOptions?: ReadonlyArray<ChatComposerModelOption>;
  /** `undefined` clears the option back to the provider default. */
  readonly onModelOptionChange?: (optionId: string, value: string | undefined) => void;
  readonly onResolveExtensionReference?: (draft: string) => Promise<boolean>;
  readonly sendDisabledReason?: string;
  readonly statusMessage?: string;
  readonly stopDisabledReason?: string;
  readonly imageGeneration?: {
    readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
    readonly client?: ImageGenerationClient;
    readonly scopeId?: ImageGenerationScopeId;
    readonly onOpenSettings?: () => void;
  };
}

/**
 * The `#thread` mention surface is shared with the Code composer, so its chip
 * and wiring shapes live beside the picker itself. These aliases keep the
 * composer's published prop names stable for existing callers.
 */
export type ChatComposerThreadMentionChip = ThreadMentionChip;
export type ChatComposerThreadMentions = ThreadMentions;

export interface ChatComposerExtensionSelection {
  readonly label: string;
  readonly reference: string;
  readonly selection?: ExtensionSelection;
  readonly status:
    | { readonly kind: "selected" }
    | { readonly kind: "blocked"; readonly reason: string };
}

export function ChatComposer(props: ChatComposerProps) {
  const statusId = useId();
  const providerId = useId();
  const modelId = useId();
  const researchRoutingId = useId();
  const mentionListId = useId();
  const commandListId = useId();
  const attachment = props.attachment ?? { kind: "supported" as const };
  const imageAttachment = props.imageAttachment ?? attachment;
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const mentionCandidates = props.threadMentions?.candidates ?? [];
  const mention = useThreadMentionTypeahead({
    mentions: props.threadMentions,
    draft: props.draft,
    onDraftChange: props.onDraftChange,
    textarea: () => messageRef.current,
    disabled: false,
  });
  const mentionOpen = mention.open;
  const activeMention = mention.activeCandidate;
  // `/` commands come from the host command registry mounted by the shell. A
  // skill only appears when this composer actually has the host's draft
  // resolution path, because that path — not this list — decides whether the
  // reference is allowed.
  const offeredCommands = useOctantCommands().filter(
    (command) => command.action.kind === "run" || props.onResolveExtensionReference !== undefined,
  );
  const [commandToken, setCommandToken] = useState<SlashCommandToken | undefined>(undefined);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const commandMatches =
    commandToken === undefined ? [] : filterOctantCommands(offeredCommands, commandToken.query);
  const commandOpen = offeredCommands.length > 0 && commandToken !== undefined;
  const activeCommand = commandOpen ? commandMatches[activeCommandIndex] : undefined;
  const trimmedDraft = props.draft.trim();
  const queueStatus = props.queueStatus ?? "idle";
  const queued = queueStatus === "queued" || queueStatus === "held";
  const baseSendDisabledReason =
    props.sendDisabledReason ??
    (trimmedDraft.length === 0 && !queued ? "Enter a message before sending." : undefined);
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  const sendDisabledReason = sendPending ? "Sending message…" : baseSendDisabledReason;
  const stopDisabledReason =
    props.stopDisabledReason ??
    (props.isSending && props.onStop === undefined
      ? "Stopping is unavailable for this response."
      : undefined);
  // Settings belong to the running turn; the draft, attachments, and mentions
  // belong to the next message and stay editable so they can be queued.
  const settingsLocked = props.isSending;
  const [modelOptionsOpen, setModelOptionsOpen] = useState(false);
  const declaredModelOptions = props.modelOptions ?? [];
  const hasModelOptionControls = declaredModelOptions.length > 0 || props.poolControl !== undefined;
  // "Set" mirrors the select's own fallback: a stored value the model no
  // longer declares renders as the provider default, so it must not light the
  // trigger either.
  const anyModelOptionSet = declaredModelOptions.some(
    (option) => option.value !== undefined && option.values.includes(option.value),
  );
  const status = composeStatus({
    attachment,
    imageAttachment,
    research: props.research.backend,
    sendDisabledReason,
    sendError,
    sendPending,
    statusMessage: props.statusMessage,
    stopDisabledReason,
    isSending: props.isSending,
    queueStatus,
    ...(props.threadMentions?.statusMessage === undefined
      ? {}
      : { mentionMessage: props.threadMentions.statusMessage }),
  });
  // Persistent capability notices stay available to assistive technology but
  // are visually hidden; only actionable state (errors, streaming) is loud.
  const quietStatus = !status.loud;

  // `.composer-input` sizes itself through `field-sizing: content` with the
  // system's 60–240px bounds; an inline height would override the stylesheet
  // and reintroduce the legacy clamp. The measurement runs only for engines
  // without field-sizing (remote clients in Safari/Firefox), mirroring the
  // same bounds so both paths render the same composer.
  useLayoutEffect(() => {
    const message = messageRef.current;
    if (message === null) return;
    if (typeof CSS?.supports === "function" && CSS.supports("field-sizing", "content")) return;
    message.style.height = "0px";
    message.style.height = `${Math.min(Math.max(message.scrollHeight, 60), 240)}px`;
  }, [props.draft]);

  useLayoutEffect(() => {
    if (props.caretRestoreKey === undefined || props.caretIndex === undefined) return;
    applyComposerCaret(messageRef.current, props.caretIndex, props.draft.length);
  }, [props.caretRestoreKey]);

  function rememberCaret(caretIndex: number | null) {
    if (caretIndex === null) return;
    props.onCaretIndexChange?.(caretIndex);
  }

  function send() {
    if (sendDisabledReason !== undefined) return;
    if (queueStatus === "queued") return;
    markInteraction("renderer", "send-requested");
    setSendPending(true);
    setSendError(undefined);
    void (async () => {
      try {
        const sent = await props.onSend(props.draft);
        if (!sent) {
          setSendError("Message could not be sent. Your draft is still here; try again.");
        } else {
          markInteraction("renderer", "send-acknowledged");
          markInteractionAfterPaint("send");
        }
      } catch {
        setSendError("Message could not be sent. Your draft is still here; try again.");
      } finally {
        setSendPending(false);
      }
    })();
  }

  /**
   * Recompute the `/` token after every edit or caret move, for the same reason
   * the `#` token is derived rather than stored: the draft is caller-owned, so
   * the composer can never believe a typeahead is open over text that changed
   * underneath it.
   */
  function syncCommandToken(draft: string, caretIndex: number | null) {
    if (offeredCommands.length === 0) return;
    setCommandToken(parseSlashCommandToken(draft, caretIndex));
    setActiveCommandIndex(0);
  }

  function syncTokens(draft: string, caretIndex: number | null) {
    mention.sync(draft, caretIndex);
    syncCommandToken(draft, caretIndex);
  }

  /**
   * Run a chosen command.
   *
   * The `/` token is removed first so the draft keeps only the user's prose. A
   * `run` command invokes the callback the ordinary control already uses; an
   * `address` command hands its reference to the host's draft resolution path,
   * which resolves, authorizes, and reports the outcome as an ordinary composer
   * receipt. Neither branch performs the action itself.
   */
  function chooseCommand(command: OctantCommand) {
    if (commandToken === undefined) return;
    const applied = applySlashCommandToken(props.draft, commandToken);
    props.onDraftChange(applied.draft, applied.caretIndex);
    rememberCaret(applied.caretIndex);
    setCommandToken(undefined);
    setActiveCommandIndex(0);
    queueMicrotask(() => {
      const message = messageRef.current;
      if (message === null) return;
      message.focus();
      message.setSelectionRange(applied.caretIndex, applied.caretIndex);
      rememberCaret(applied.caretIndex);
    });
    if (command.action.kind === "run") {
      command.action.run();
      return;
    }
    void props.onResolveExtensionReference?.(command.action.reference);
  }

  function onDraftKeyUp(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") return;
    rememberCaret(event.currentTarget.selectionStart);
    syncTokens(event.currentTarget.value, event.currentTarget.selectionStart);
  }

  async function onDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (commandOpen && commandMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommandIndex((current) => (current + 1) % commandMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommandIndex(
          (current) => (current - 1 + commandMatches.length) % commandMatches.length,
        );
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && activeCommand) {
        event.preventDefault();
        chooseCommand(activeCommand);
        return;
      }
    }
    if (event.key === "Escape" && commandOpen) {
      event.preventDefault();
      setCommandToken(undefined);
      return;
    }
    if (mention.handleKeyDown(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (await props.onResolveExtensionReference?.(props.draft)) return;
    send();
  }

  /**
   * Paste images as ordinary attachments. The clipboard is read only
   * when the selected provider and model honestly accept images; otherwise the
   * bytes stay unread and the caller is told why. Non-image clipboard content
   * is never consumed, so ordinary text paste keeps working.
   */
  function onDraftPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (props.attachmentBusy === true) return;
    if (!clipboardHasImage(event.clipboardData)) return;
    if (imageAttachment.kind === "unavailable") {
      event.preventDefault();
      props.onImagePasteRejected?.(imageAttachment.reason);
      return;
    }
    const selection = collectPastedImages(event.clipboardData);
    if (selection.files.length === 0 && selection.rejected.length === 0) return;
    event.preventDefault();
    for (const rejection of selection.rejected) {
      props.onImagePasteRejected?.(`${rejection.displayName}: ${rejection.reason}`);
    }
    for (const file of selection.files) props.onFileSelected(file);
  }

  const chips = (
    <>
      <ThreadMentionChips
        chips={props.threadMentions?.chips ?? []}
        {...(props.threadMentions?.dialogueEnabled === undefined
          ? {}
          : { dialogueEnabled: props.threadMentions.dialogueEnabled })}
        onRemove={(threadId) => props.threadMentions?.onRemoveChip(threadId)}
        {...(props.threadMentions?.onOpenSideChat === undefined
          ? {}
          : { onOpenSideChat: props.threadMentions.onOpenSideChat })}
      />
      {(props.pendingAttachments ?? []).length > 0 ? (
        <ul aria-label="Attached files" className="composer-chips chat-composer__selections">
          {(props.pendingAttachments ?? []).map((attachmentSelection) => (
            <li key={String(attachmentSelection.id)} className="chip chat-composer__selection">
              <span>{attachmentSelection.displayName}</span>
              {props.onRemoveAttachment === undefined ? null : (
                <OctantButton
                  aria-label={`Remove ${attachmentSelection.displayName} attachment`}
                  className="chip-x window-no-drag"
                  onClick={() => props.onRemoveAttachment?.(attachmentSelection.id)}
                  type="button"
                >
                  <X aria-hidden="true" size={12} strokeWidth={1.8} />
                </OctantButton>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {(props.pendingPreviewSelections ?? []).length > 0 ? (
        <ul
          aria-label="Attached preview selections"
          className="composer-chips chat-composer__selections"
        >
          {(props.pendingPreviewSelections ?? []).map((selection) => (
            <li key={String(selection.id)} className="chip chat-composer__selection">
              <span>{selection.displayName}</span>
              {props.onRemovePreviewSelection === undefined ? null : (
                <OctantButton
                  aria-label={`Remove ${selection.displayName} selection`}
                  onClick={() => props.onRemovePreviewSelection?.(selection.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </OctantButton>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {(props.pendingCanvasSelections ?? []).length > 0 ? (
        <ul
          aria-label="Attached canvas selections"
          className="composer-chips chat-composer__selections"
        >
          {(props.pendingCanvasSelections ?? []).map((selection) => (
            <li key={String(selection.id)} className="chip chat-composer__selection">
              <span>{selection.displayName}</span>
              {props.onRemoveCanvasSelection === undefined ? null : (
                <OctantButton
                  aria-label={`Remove ${selection.displayName} canvas selection`}
                  onClick={() => props.onRemoveCanvasSelection?.(selection.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </OctantButton>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {(props.pendingExtensionSelections ?? []).length > 0 ? (
        <ul aria-label="Selected extensions" className="composer-chips chat-composer__selections">
          {(props.pendingExtensionSelections ?? []).map((item) => (
            <li key={item.reference} className="chip chat-composer__selection">
              <span>{item.label}</span>
              <span className="chat-composer__selection-receipt">
                {item.status.kind === "selected"
                  ? "Selection verified"
                  : `Blocked: ${item.status.reason}`}
              </span>
              {props.onRemoveExtensionSelection === undefined ? null : (
                <OctantButton
                  aria-label={`Remove ${item.label} extension`}
                  onClick={() => props.onRemoveExtensionSelection?.(item.reference)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </OctantButton>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );

  const input = (
    <OctantTextarea
      aria-activedescendant={
        activeCommand !== undefined
          ? `${commandListId}-${activeCommand.id}`
          : activeMention === undefined
            ? undefined
            : `${mentionListId}-${String(activeMention.threadId)}`
      }
      aria-autocomplete={
        props.threadMentions === undefined && offeredCommands.length === 0 ? undefined : "list"
      }
      aria-controls={commandOpen ? commandListId : mentionOpen ? mentionListId : undefined}
      aria-describedby={statusId}
      aria-expanded={
        props.threadMentions === undefined && offeredCommands.length === 0
          ? undefined
          : commandOpen || mentionOpen
      }
      className="composer-input window-no-drag"
      onChange={(event) => {
        setSendError(undefined);
        props.onDraftChange(event.currentTarget.value);
        rememberCaret(event.currentTarget.selectionStart);
        syncTokens(event.currentTarget.value, event.currentTarget.selectionStart);
      }}
      onClick={(event) => {
        rememberCaret(event.currentTarget.selectionStart);
        syncTokens(event.currentTarget.value, event.currentTarget.selectionStart);
      }}
      onKeyDown={onDraftKeyDown}
      onKeyUp={onDraftKeyUp}
      onPaste={onDraftPaste}
      placeholder={props.isSending ? "Queue the next message…" : "Message Octant"}
      ref={messageRef}
      rows={1}
      value={props.draft}
    />
  );

  const typeahead = (
    <>
      {commandOpen ? (
        <div className="chat-composer__command-typeahead">
          {commandMatches.length === 0 ? (
            <p className="chat-composer__command-empty" role="status">
              No matching command. Leaving this as ordinary text.
            </p>
          ) : (
            <ul
              aria-label="Commands you can run"
              className="chat-composer__command-list"
              id={commandListId}
              role="listbox"
            >
              {commandMatches.map((command, index) => (
                <li className="chat-composer__command-option" key={command.id} role="presentation">
                  <OctantButton
                    aria-selected={index === activeCommandIndex}
                    id={`${commandListId}-${command.id}`}
                    onClick={() => chooseCommand(command)}
                    onMouseEnter={() => setActiveCommandIndex(index)}
                    role="option"
                    size="sm"
                    type="button"
                    variant={index === activeCommandIndex ? "secondary" : "ghost"}
                  >
                    <Slash aria-hidden="true" size={12} strokeWidth={1.8} />
                    <span>{command.title}</span>
                    <span className="chat-composer__command-meta">
                      {command.detail === undefined
                        ? command.group
                        : `${command.group} · ${command.detail}`}
                    </span>
                  </OctantButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {mentionOpen ? (
        <ThreadMentionTypeahead
          activeIndex={mention.activeIndex}
          {...(props.threadMentions?.busy === undefined ? {} : { busy: props.threadMentions.busy })}
          candidates={mentionCandidates}
          listId={mentionListId}
          onChoose={mention.choose}
          onHover={mention.setActiveIndex}
        />
      ) : null}
    </>
  );

  const rowLeading = (
    <>
      <div className="chat-composer__leading">
        <label>
          <span className="chat-composer__visually-hidden">Add attachment</span>
          {/* ui-boundary-exception: native-file-input */}
          <input
            aria-label="Choose attachment file"
            disabled={attachment.kind === "unavailable" || props.attachmentBusy === true}
            onChange={(event) => {
              const file = event.currentTarget.files?.item(0);
              if (file !== null && file !== undefined) props.onFileSelected(file);
              event.currentTarget.value = "";
            }}
            type="file"
          />
        </label>
        <OctantButton
          aria-label="Add attachment"
          disabled={attachment.kind === "unavailable" || props.attachmentBusy === true}
          onClick={(event) => {
            const input =
              event.currentTarget.parentElement?.querySelector<HTMLInputElement>(
                'input[type="file"]',
              );
            input?.click();
          }}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Paperclip aria-hidden="true" size={16} strokeWidth={1.8} />
        </OctantButton>
        {props.imageGeneration === undefined ? null : (
          <ImageGenerationAction
            {...(props.imageGeneration.client === undefined
              ? {}
              : { client: props.imageGeneration.client })}
            {...(props.imageGeneration.scopeId === undefined
              ? {}
              : { scopeId: props.imageGeneration.scopeId })}
            {...(props.imageGeneration.onOpenSettings === undefined
              ? {}
              : { onOpenSettings: props.imageGeneration.onOpenSettings })}
            disabled={settingsLocked}
            profiles={props.imageGeneration.profiles}
            threadKind="chat-thread"
          />
        )}
      </div>
      <div className="chat-composer__selectors">
        {props.providerGroups !== undefined && props.onSelectModel !== undefined ? (
          <ComposerModelPicker
            ariaLabel="Provider and model"
            disabled={settingsLocked}
            groups={props.providerGroups}
            onSelect={props.onSelectModel}
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
        ) : (
          <>
            {props.provider.options.length > 1 ? (
              <label htmlFor={providerId}>
                <span className="chat-composer__visually-hidden">Provider</span>
                <OctantSelectField
                  disabled={settingsLocked}
                  id={providerId}
                  onValueChange={props.onProviderChange}
                  options={props.provider.options}
                  value={props.provider.value}
                />
              </label>
            ) : null}
            <label htmlFor={modelId}>
              <span className="chat-composer__visually-hidden">Model</span>
              <OctantSelectField
                disabled={settingsLocked}
                id={modelId}
                onValueChange={props.onModelChange}
                options={props.model.options}
                value={props.model.value}
              />
            </label>
          </>
        )}
        {hasModelOptionControls ? (
          <div className="chat-composer__model-options">
            <OctantPopover
              align="start"
              className="chat-composer__model-options-panel"
              onOpenChange={setModelOptionsOpen}
              open={modelOptionsOpen}
              side="top"
              title="Model options"
              trigger={
                <>
                  <SlidersHorizontal aria-hidden="true" size={16} strokeWidth={1.8} />
                  {anyModelOptionSet ? (
                    <span aria-hidden="true" className="chat-composer__model-options-dot" />
                  ) : null}
                </>
              }
              {...(anyModelOptionSet ? { triggerDataAttributes: { "data-customized": true } } : {})}
              triggerDisabled={settingsLocked}
              triggerLabel="Model options"
              triggerVariant="ghost-icon"
            >
              {declaredModelOptions.map((option) => (
                <label key={option.id}>
                  <span className="chat-composer__visually-hidden">{option.displayName}</span>
                  <OctantSelectField
                    disabled={settingsLocked}
                    onValueChange={(value) =>
                      props.onModelOptionChange?.(
                        option.id,
                        value === MODEL_OPTION_DEFAULT_ID ? undefined : value,
                      )
                    }
                    options={[
                      { id: MODEL_OPTION_DEFAULT_ID, label: `${option.displayName}: Default` },
                      ...option.values.map((value) => ({
                        id: value,
                        label: `${option.displayName}: ${value}`,
                      })),
                    ]}
                    value={
                      option.value !== undefined && option.values.includes(option.value)
                        ? option.value
                        : MODEL_OPTION_DEFAULT_ID
                    }
                  />
                </label>
              ))}
              {props.poolControl}
            </OctantPopover>
          </div>
        ) : null}
      </div>
      <div className="chat-composer__research">
        <OctantButton
          aria-label={props.research.enabled ? "Disable web research" : "Enable web research"}
          aria-pressed={props.research.enabled}
          disabled={settingsLocked}
          onClick={() => props.onResearchEnabledChange(!props.research.enabled)}
          size="sm"
          type="button"
          variant={props.research.enabled ? "secondary" : "ghost"}
        >
          <Globe2 aria-hidden="true" size={14} strokeWidth={1.7} />
          <span>Web</span>
        </OctantButton>
        {props.research.enabled ? (
          <label htmlFor={researchRoutingId}>
            <span className="chat-composer__visually-hidden">Research routing</span>
            <OctantSelectField
              disabled={settingsLocked}
              id={researchRoutingId}
              onValueChange={(value) =>
                props.onResearchRoutingChange(value as ChatComposerResearchRouting)
              }
              options={[
                { id: "automatic", label: "Automatic" },
                { id: "searxng", label: "SearXNG" },
                { id: "provider-native", label: "Provider-native" },
              ]}
              value={props.research.routing}
            />
          </label>
        ) : null}
      </div>
    </>
  );

  return (
    <ThreadComposer
      ariaLabel="Chat composer"
      chips={chips}
      className={`chat-composer thread-column${
        queueStatus === "idle" ? "" : ` chat-composer--${queueStatus}`
      }`}
      footer={
        <div
          aria-live="polite"
          className={`chat-composer__status${quietStatus ? " chat-composer__status--quiet" : ""}`}
          id={statusId}
          role="status"
        >
          {status.text}
        </div>
      }
      input={input}
      label={{
        className: "chat-composer__message-field",
        text: "Message",
        textClassName: "chat-composer__visually-hidden",
      }}
      row={{
        ariaLabel: "Composer controls",
        className: "chat-composer__bar",
        toolbar: true,
        leading: rowLeading,
        actions: {
          kind: "send-or-stop",
          cellClassName: "chat-composer__actions",
          sending: props.isSending,
          send: {
            ariaLabel: props.isSending ? "Queue message" : "Send message",
            disabledReason: sendDisabledReason,
            onSend: send,
          },
          stop: {
            ariaLabel: "Stop response",
            disabledReason: stopDisabledReason,
            onStop: () => props.onStop?.(),
          },
          ...(queued && props.onDiscardQueued !== undefined
            ? {
                discard: {
                  ariaLabel: "Discard queued message",
                  onDiscard: props.onDiscardQueued,
                },
              }
            : {}),
          sendHidden: queueStatus === "queued",
        },
      }}
      typeahead={typeahead}
    />
  );
}

function composeStatus(input: {
  readonly attachment: ChatComposerAttachmentCapability;
  readonly imageAttachment?: ChatComposerAttachmentCapability;
  readonly isSending: boolean;
  readonly mentionMessage?: string | undefined;
  readonly queueStatus: "idle" | "queued" | "held";
  readonly research: ChatComposerResearchBackend;
  readonly sendDisabledReason?: string | undefined;
  readonly sendError?: string | undefined;
  readonly sendPending: boolean;
  readonly statusMessage?: string | undefined;
  readonly stopDisabledReason?: string | undefined;
}): { readonly text: string; readonly loud: boolean } {
  // Quiet messages inform assistive technology without persistent visual
  // noise; loud messages (failures, streaming state) must be visible.
  const quiet: string[] = [];
  const loud: string[] = [];
  if (input.attachment.kind === "unavailable") quiet.push(input.attachment.reason);
  // The image notice is only worth saying when attachments are otherwise
  // available; a provider that takes no attachments at all already said so.
  if (input.attachment.kind === "supported" && input.imageAttachment?.kind === "unavailable") {
    quiet.push(input.imageAttachment.reason);
  }
  if (input.mentionMessage !== undefined) loud.push(input.mentionMessage);
  if (input.research.kind === "unavailable") {
    loud.push(`Research unavailable: ${input.research.reason}`);
  } else if (input.research.kind === "selected") {
    quiet.push(
      `Research uses ${input.research.backend === "searxng" ? "SearXNG" : "provider-native research"}.`,
    );
  }
  if (input.statusMessage !== undefined) loud.push(input.statusMessage);
  if (input.sendError !== undefined) loud.push(input.sendError);
  if (input.queueStatus === "queued") {
    loud.push("This message is queued and will send when the response finishes.");
  } else if (input.queueStatus === "held" && input.statusMessage === undefined) {
    loud.push("The queued message was not sent.");
  }
  if (input.sendPending) {
    loud.push("Sending message…");
  } else if (input.isSending && input.stopDisabledReason !== undefined) {
    loud.push(input.stopDisabledReason);
  } else if (input.isSending && input.queueStatus === "idle") {
    loud.push("Response is streaming. You can type the next message.");
  } else if (input.sendDisabledReason !== undefined && input.queueStatus === "idle") {
    quiet.push(input.sendDisabledReason);
  }
  const messages = [...quiet, ...loud];
  return {
    text: messages.length > 0 ? messages.join(" ") : "Ready to send.",
    loud: loud.length > 0,
  };
}
