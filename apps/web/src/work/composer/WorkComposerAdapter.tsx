import type { ProjectId } from "@octant/contracts/projects";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { CreateHostViewScope, PickerGroup } from "@octant/domain";
import { ArrowUp, FolderOpen, AlertTriangle, Paperclip } from "lucide-react";
import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ComposerModelPicker } from "../../providers/ComposerModelPicker";
import { HostSelector } from "../../shell/HostSelector";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { clipboardHasImage } from "../../chat/composerImagePaste";
import { selectedModelReadsImages, useWorkComposerImages } from "./useWorkComposerImages";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../../chat/ThreadMentionPicker";
import { useThreadMentions } from "../../chat/useThreadMentions";
import type { MentionableThreadId } from "@octant/contracts";

export interface WorkComposerAdapterProps {
  readonly projectId?: ProjectId;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedHostId?: HostId;
  readonly fixedHostId?: HostId;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly viewScope?: CreateHostViewScope;
  readonly onSelectHost?: (hostId: HostId) => void;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelectProvider: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
  readonly onCreateThread: (
    prompt: string,
    images?: ReadonlyArray<File>,
    threadMentionIds?: ReadonlyArray<MentionableThreadId>,
  ) => void | Promise<void>;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly onAttachFolder?: () => void;
  readonly folderControl?: ReactNode;
  /** Optional multi-model pool control slot rendered in the composer bar. */
  readonly poolControl?: ReactNode;
  readonly onCancel: () => void;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly onCancelFirstTurn?: () => void;
}

export function WorkComposerAdapter(props: WorkComposerAdapterProps) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionListId = "work-new-thread-mentions";
  const images = useWorkComposerImages();
  const threadMentions = useThreadMentions({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    draft: prompt,
  });
  const mention = useThreadMentionTypeahead({
    mentions: threadMentions.composer,
    draft: prompt,
    onDraftChange: setPrompt,
    textarea: () => textareaRef.current,
    ...(props.creating === true ? { disabled: true } : {}),
  });
  const trimmed = prompt.trim();
  const hasFolder = props.projectId !== undefined;
  const imageSupport = selectedModelReadsImages(props.providerGroups, {
    ...(props.selectedProviderInstanceId === undefined
      ? {}
      : { providerInstanceId: props.selectedProviderInstanceId }),
    ...(props.selectedModelId === undefined ? {} : { modelId: props.selectedModelId }),
  });
  // A Work thread belongs to a Project (decision 0037), so the first turn
  // cannot start until one is chosen. Blocking here is what makes the
  // Project control a requirement rather than a suggestion.
  const canSubmit = trimmed.length > 0 && !props.creating && hasFolder;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    const staged = images.takeForSend();
    void threadMentions.resolveForSend().then((threadMentionIds) => {
      void props.onCreateThread(trimmed, staged, threadMentionIds);
    });
  }, [canSubmit, images, props, threadMentions, trimmed]);

  function attachFromTransfer(items: DataTransfer | null): boolean {
    if (items === null) return false;
    if (!clipboardHasImage(items)) return false;
    if (imageSupport === false) {
      images.refuse("The selected model does not accept images. Choose an image-capable model.");
      return true;
    }
    return images.consumePaste(items);
  }

  function onDraftPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (props.creating === true) return;
    if (attachFromTransfer(event.clipboardData)) event.preventDefault();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.handleKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (props.creating && props.onCancelFirstTurn !== undefined) {
        props.onCancelFirstTurn();
      } else {
        props.onCancel();
      }
    }
  }

  return (
    <section aria-label="New Work thread" className="work-composer-adapter">
      <div className="work-composer-adapter__canvas">
        <div className="work-composer-adapter__welcome">
          <p className="work-composer-adapter__eyebrow">Octant Work</p>
          <h1 className="work-composer-adapter__heading">What are we working on?</h1>
          <p className="work-composer-adapter__description">
            {hasFolder
              ? "Start a work thread inside this confined folder. Documents, presentations, spreadsheets, reports, and artifacts stay local."
              : "Choose a Project to work in. Its folder is the only place this thread can read or write."}
          </p>
        </div>

        <div className="work-composer-adapter__composer">
          {/* One card holds the prompt and everything the thread will be bound
              to. The strip used to sit outside it, which read as loose chrome
              under the composer rather than as part of what is being started. */}
          <div className="composer work-composer-adapter__card">
            {mention.open ? (
              <ThreadMentionTypeahead
                activeIndex={mention.activeIndex}
                {...(threadMentions.composer?.busy === undefined
                  ? {}
                  : { busy: threadMentions.composer.busy })}
                candidates={threadMentions.composer?.candidates ?? []}
                listId={mentionListId}
                onChoose={mention.choose}
                onHover={mention.setActiveIndex}
              />
            ) : null}
            <ThreadMentionChips
              chips={threadMentions.chips}
              onRemove={(threadId) => threadMentions.composer?.onRemoveChip(threadId)}
            />
            {images.staged.length === 0 && images.message === undefined ? null : (
              <div
                className="composer-chips work-composer-adapter__attachments"
                aria-label="Attached images"
              >
                {images.staged.map((attachment) => (
                  <span className="chip work-composer-adapter__attachment" key={attachment.id}>
                    <img
                      alt={attachment.displayName}
                      className="work-composer-adapter__attachment-thumb"
                      src={attachment.previewUrl}
                    />
                    <span className="work-composer-adapter__attachment-name">
                      {attachment.displayName}
                    </span>
                    <button
                      aria-label={`Remove ${attachment.displayName}`}
                      className="chip-x window-no-drag"
                      onClick={() => images.remove(attachment.id)}
                      type="button"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {images.message === undefined ? null : (
                  <span className="work-composer-adapter__hint" role="status">
                    {images.message}
                  </span>
                )}
              </div>
            )}
            <OctantTextarea
              aria-label="First message"
              autoFocus
              className="composer-input"
              disabled={props.creating}
              onChange={(event) => {
                setPrompt(event.target.value);
                mention.sync(event.target.value, event.currentTarget.selectionStart);
              }}
              onClick={(event) =>
                mention.sync(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              ref={textareaRef}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                if (attachFromTransfer(event.dataTransfer)) event.preventDefault();
              }}
              onKeyDown={handleKeyDown}
              onPaste={onDraftPaste}
              placeholder="Describe the work…"
              rows={3}
              value={prompt}
            />
            <div className="composer-row work-composer-adapter__composer-bar">
              <label>
                <span className="work-composer-adapter__visually-hidden">Add attachment</span>
                <input
                  aria-label="Choose attachment file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="work-composer-adapter__file-input"
                  disabled={props.creating === true || imageSupport === false}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.item(0);
                    if (file !== null && file !== undefined) {
                      if (imageSupport === false) {
                        images.refuse(
                          "The selected model does not accept images. Choose an image-capable model.",
                        );
                      } else {
                        images.attach([file]);
                      }
                    }
                    event.currentTarget.value = "";
                  }}
                  type="file"
                />
              </label>
              <OctantButton
                aria-label="Add attachment"
                disabled={props.creating === true || imageSupport === false}
                onClick={(event) => {
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLInputElement>('input[type="file"]')
                    ?.click();
                }}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Paperclip aria-hidden="true" size={15} strokeWidth={1.8} />
              </OctantButton>
              <span className="work-composer-adapter__context-picker">
                <ComposerModelPicker
                  ariaLabel="Provider and model"
                  groups={props.providerGroups}
                  onSelect={props.onSelectProvider}
                  {...(props.selectedModelId === undefined
                    ? {}
                    : { selectedModelId: props.selectedModelId })}
                  {...(props.selectedProviderInstanceId === undefined
                    ? {}
                    : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
                />
              </span>
              {props.poolControl}
              <span className="composer-gap" />
              <OctantButton
                aria-label={
                  props.errorMessage === undefined ? "Create thread" : "Retry creating thread"
                }
                disabled={!canSubmit}
                onClick={submit}
                size="icon"
                type="button"
                variant="default"
              >
                <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
              </OctantButton>
            </div>

            <div className="work-composer-adapter__context-strip" aria-label="Thread context">
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
                {...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost })}
                requiredCapability="work"
              />
              {props.folderControl}
              {props.folderControl !== undefined ? null : hasFolder &&
                props.projectName !== undefined ? (
                <span className="work-composer-adapter__context-item" title={props.projectRoot}>
                  <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
                  <span>{props.projectName}</span>
                </span>
              ) : (
                <span className="work-composer-adapter__context-item">
                  <AlertTriangle aria-hidden="true" size={12} strokeWidth={1.8} />
                  <span>No folder</span>
                  {props.onAttachFolder !== undefined ? (
                    <OctantButton
                      className="work-composer-adapter__attach-btn"
                      onClick={props.onAttachFolder}
                      type="button"
                      variant="ghost"
                    >
                      Attach folder
                    </OctantButton>
                  ) : null}
                </span>
              )}
            </div>
          </div>

          {props.errorMessage !== undefined ? (
            <p className="work-composer-adapter__error" role="alert">
              {props.errorMessage}
            </p>
          ) : null}
          {props.creating ? (
            <div>
              <p aria-label="First-turn status" role="status">
                {props.pendingMessage ?? "Starting the first turn…"}
              </p>
              {props.onCancelFirstTurn === undefined ? null : (
                <OctantButton
                  onClick={props.onCancelFirstTurn}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel first turn
                </OctantButton>
              )}
            </div>
          ) : null}
          <p className="work-composer-adapter__hint">
            Press Enter to start · Shift+Enter for a new line · Escape to close
          </p>
        </div>
      </div>
    </section>
  );
}
