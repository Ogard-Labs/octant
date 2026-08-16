import type { ProjectId } from "@octant/contracts/projects";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { CreateHostViewScope, PickerGroup } from "@octant/domain";
import { ArrowUp, FolderOpen, AlertTriangle } from "lucide-react";
import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { ComposerModelPicker } from "../../providers/ComposerModelPicker";
import { HostSelector } from "../../shell/HostSelector";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantTextarea } from "../../ui/base/OctantTextarea";

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
  readonly onCreateThread: (prompt: string) => void | Promise<void>;
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
  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && !props.creating;
  const hasFolder = props.projectId !== undefined;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    void props.onCreateThread(trimmed);
  }, [canSubmit, props, trimmed]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
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
              : "Start a work thread without a folder. You can attach a folder later for file access."}
          </p>
        </div>

        <div className="work-composer-adapter__composer">
          <div className="work-composer-adapter__input-row">
            <OctantTextarea
              aria-label="First message"
              autoFocus
              className="work-composer-adapter__textarea"
              disabled={props.creating}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe the work…"
              rows={3}
              value={prompt}
            />
            <div className="work-composer-adapter__composer-bar">
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
              <OctantButton
                aria-label={
                  props.errorMessage === undefined ? "Create thread" : "Retry creating thread"
                }
                className="work-composer-adapter__send"
                disabled={!canSubmit}
                onClick={submit}
                size="icon"
                type="button"
                variant="default"
              >
                <ArrowUp aria-hidden="true" size={16} strokeWidth={2} />
              </OctantButton>
            </div>
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
              <span className="work-composer-adapter__context-item work-composer-adapter__context-item--rootless">
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
