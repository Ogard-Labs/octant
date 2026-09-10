import {
  BrowserUseMention,
  ComputerUseMention,
  useBrowserUseMention,
  useComputerUseMention,
} from "../../computerUse/ComputerUseMention";
import type { ExtensionProviderFamily, ExtensionSelection } from "@octant/contracts/extensions";
import { ExtensionProviderFamily as ExtensionProviderFamilySchema } from "@octant/contracts/extensions";
import { Schema } from "effect";
import { ComposerAttachButton } from "../../composer/ComposerAttachButton";
import type { ProjectId } from "@octant/contracts/projects";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { useExtensionDraftSelections } from "../../chat/useExtensionDraftSelections";
import { useComposerSlashCommands, ComposerSlashTypeahead } from "../../composer/useComposerSlashCommands";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { CreateHostViewScope, PickerGroup } from "@octant/domain";
import { FolderOpen, AlertTriangle } from "lucide-react";
import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ComposerModelPicker } from "../../providers/ComposerModelPicker";
import { composerPlaceholder, THREAD_HINT } from "../../composer/composerPlaceholder";
import { HostSelector } from "../../shell/HostSelector";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { clipboardHasImage } from "../../chat/composerImagePaste";
import { ThreadComposer } from "../../composer/ThreadComposer";
import { WelcomeHeading } from "../../composer/WelcomeHeading";
import { ComposerVoiceButton } from "../../voice/ComposerVoiceButton";
import { appendTranscript } from "../../voice/appendTranscript";
import { selectedModelReadsImages, useWorkComposerImages } from "./useWorkComposerImages";
import { WorkImageAttachmentChips } from "./WorkImageAttachmentChips";
import {
  ThreadMentionChips,
  ThreadMentionTypeahead,
  useThreadMentionTypeahead,
} from "../../chat/ThreadMentionPicker";
import { useThreadMentions } from "../../chat/useThreadMentions";
import { TrackerReferenceComposerHints } from "../../tracker/TrackerReferenceComposerHints";
import type { MentionableThreadId } from "@octant/contracts";

export interface WorkComposerAdapterProps {
  /** The person's name from their profile, for the greeting on the hero. */
  readonly greetingName?: string | undefined;
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
    computerUseSelection?: ExtensionSelection,
    extensionSelections?: ReadonlyArray<ExtensionSelection>,
  ) => boolean | void | Promise<boolean | void>;
  readonly extensionClient?: ExtensionClient;
  readonly browserAvailable?: boolean;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly onAttachFolder?: () => void;
  readonly folderControl?: ReactNode;
  readonly createFromControl?: ReactNode;
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
  const computer = useComputerUseMention({
    textarea: () => textareaRef.current,
    draft: prompt,
    onDraftChange: setPrompt,
    scopeKey: "work-draft",
  });
  const selectedFamily = selectedProviderFamily(props.providerGroups, props.selectedProviderInstanceId);
  const extensionDraft = useExtensionDraftSelections({
    ...(props.extensionClient === undefined ? {} : { client: props.extensionClient }),
    mode: "work",
    projectId: props.projectId ?? null,
    ...(selectedFamily === undefined ? {} : { providerFamily: selectedFamily }),
  });
  const browser = useBrowserUseMention({
    textarea: () => textareaRef.current,
    draft: prompt,
    onDraftChange: setPrompt,
    scopeKey: "work-draft",
    ...(props.browserAvailable === undefined ? {} : { available: props.browserAvailable }),
    onChoose: () => void extensionDraft.resolveReference("@browser"),
  });
  const slash = useComposerSlashCommands({
    draft: prompt,
    onDraftChange: setPrompt,
    onResolveExtensionReference: extensionDraft.resolveReference,
  });
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
  const [submitting, setSubmitting] = useState(false);
  const canSubmit =
    trimmed.length > 0 && !props.creating && !submitting && !slash.resolving && hasFolder;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    setSubmitting(true);
    const staged = images.filesForSend();
    const computerUseSelection = computer.selection;
    const extensionSelections = extensionDraft.receipts.flatMap((receipt) =>
      receipt.selection === undefined ? [] : [receipt.selection],
    );
    void threadMentions
      .resolveForSend()
      .then(async (threadMentionIds) => {
        const created = await props.onCreateThread(
          trimmed,
          staged,
          threadMentionIds,
          ...(computerUseSelection === undefined
            ? ([] as const)
            : ([computerUseSelection] as const)),
          ...(extensionSelections.length === 0 ? ([] as const) : ([extensionSelections] as const)),
        );
        if (created !== false) {
          images.clearAfterAccepted();
          computer.consume(computerUseSelection);
        }
        return created;
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [canSubmit, computer, extensionDraft, images, props, threadMentions, trimmed]);

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
    if (computer.handleKeyDown(event)) return;
    if (browser.handleKeyDown(event)) return;
    if (slash.handleKeyDown(event)) return;
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

  const projectControl =
    props.folderControl !== undefined ? (
      props.folderControl
    ) : hasFolder && props.projectName !== undefined ? (
      <span className="composer-tray__item" title={props.projectRoot}>
        <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
        <span>{props.projectName}</span>
      </span>
    ) : (
      <span className="composer-tray__item">
        <AlertTriangle aria-hidden="true" size={12} strokeWidth={1.8} />
        <span>No folder</span>
        {props.onAttachFolder !== undefined ? (
          <OctantButton
            className="work-composer-adapter__attach-btn"
            onClick={props.onAttachFolder}
            type="button"
            variant="link"
          >
            Attach folder
          </OctantButton>
        ) : null}
      </span>
    );
  const environmentControl = (
    <HostSelector
      presentation="environment"
      {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
      {...(props.selectedHostId === undefined ? {} : { selectedHostId: props.selectedHostId })}
      {...(props.fixedHostId === undefined ? {} : { fixedHostId: props.fixedHostId })}
      {...(props.lastSelectedHealthyHostId === undefined
        ? {}
        : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
      {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
      {...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost })}
      requiredCapability="work"
    />
  );

  return (
    <section aria-label="New task" className="work-composer-adapter">
      <div className="welcome">
        <div className="welcome__heading">
          <WelcomeHeading greetingName={props.greetingName} question="What are we working on?" />
        </div>

        <div className="composer-stack">
          <ThreadComposer
            chips={
              <>
                <ComputerUseMention controller={computer} surface="chips" />
                <BrowserUseMention controller={browser} surface="chips" />
                {extensionDraft.receipts.length > 0 ? (
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
                          variant="ghost"
                        >
                          ×
                        </OctantButton>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <ThreadMentionChips
                  chips={threadMentions.chips}
                  onRemove={(threadId) => threadMentions.composer?.onRemoveChip(threadId)}
                />
                <TrackerReferenceComposerHints draft={prompt} />
                <WorkImageAttachmentChips images={images} />
              </>
            }
            input={
              <OctantTextarea
                aria-label="First message"
                aria-autocomplete="list"
                aria-expanded={computer.open || browser.open || slash.open}
                aria-controls={computer.open ? computer.listId : browser.open ? browser.listId : slash.open ? slash.listId : undefined}
                aria-activedescendant={computer.open ? `${computer.listId}-computer` : browser.open ? `${browser.listId}-browser` : slash.active === undefined ? undefined : `${slash.listId}-${slash.active.id}`}
                autoFocus
                className="composer-input"
                disabled={props.creating}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  computer.sync(event.target.value, event.currentTarget.selectionStart);
                  browser.sync(event.target.value, event.currentTarget.selectionStart);
                  slash.sync(event.target.value, event.currentTarget.selectionStart);
                  mention.sync(event.target.value, event.currentTarget.selectionStart);
                }}
                onClick={(event) => {
                  mention.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                  browser.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                  slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                ref={textareaRef}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  if (attachFromTransfer(event.dataTransfer)) event.preventDefault();
                }}
                onKeyDown={handleKeyDown}
                onPaste={onDraftPaste}
                placeholder={composerPlaceholder("Describe the work", [
                  threadMentions.composer === undefined ? undefined : THREAD_HINT,
                ])}
                rows={3}
                value={prompt}
              />
            }
            typeahead={
              computer.open ? (
                <ComputerUseMention controller={computer} surface="typeahead" />
              ) : browser.open ? (
                <BrowserUseMention controller={browser} surface="typeahead" />
              ) : slash.open ? (
                <ComposerSlashTypeahead controller={slash} />
              ) : mention.open ? (
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
              ) : null
            }
            row={{
              className: "work-composer-adapter__composer-bar",
              leading: (
                <>
                  <ComposerAttachButton
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    busy={props.creating === true}
                    refusedReason={
                      imageSupport === false
                        ? "The selected model does not accept images. Choose an image-capable model."
                        : undefined
                    }
                    onRefused={images.refuse}
                    onFileSelected={(file) => images.attach([file])}
                  />
                  <ComposerVoiceButton
                    disabled={props.creating === true}
                    onTranscript={(transcript) =>
                      setPrompt((current) => appendTranscript(current, transcript))
                    }
                  />

                  <span aria-hidden="true" className="composer-gap" />
                  <ComposerModelPicker
                    ariaLabel="Provider and model"
                    groups={props.providerGroups}
                    menuSide="bottom"
                    onSelect={props.onSelectProvider}
                    {...(props.selectedModelId === undefined
                      ? {}
                      : { selectedModelId: props.selectedModelId })}
                    {...(props.selectedProviderInstanceId === undefined
                      ? {}
                      : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
                  />
                  {props.poolControl}
                </>
              ),
              actions: {
                kind: "send",
                send: {
                  ariaLabel:
                    props.errorMessage === undefined ? "Create thread" : "Retry creating thread",
                  disabled: !canSubmit,
                  onSend: submit,
                },
              },
            }}
            footer={
              <div className="composer-tray" aria-label="Thread context">
                <div className="composer-tray__leading">
                  {projectControl}
                  {environmentControl}
                </div>
                {props.createFromControl === undefined ? null : (
                  <div className="composer-tray__trailing">{props.createFromControl}</div>
                )}
              </div>
            }
          />
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
      </div>
    </section>
  );
}

function selectedProviderFamily(
  groups: ReadonlyArray<PickerGroup>,
  selectedProviderInstanceId: ProviderInstanceId | undefined,
): ExtensionProviderFamily | undefined {
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(selectedProviderInstanceId),
  );
  return group !== undefined && Schema.is(ExtensionProviderFamilySchema)(group.instance.driverKind)
    ? group.instance.driverKind
    : undefined;
}
