import type {
  ArtifactSyncedDetail,
  ArtifactSyncedThread,
  ArtifactSyncedVersion,
} from "@octant/contracts/artifact-library";
import { artifactEditedAgo } from "@octant/domain";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface SyncedArtifactDialogProps {
  readonly open: boolean;
  readonly detail: ArtifactSyncedDetail | undefined;
  readonly busy: boolean;
  /** The host's last answer, in its own words: a refusal, or what happened. */
  readonly message?: string;
  readonly observedAt: string;
  readonly onKeep: (versionId: ArtifactSyncedVersion["versionId"]) => void;
  /** `threadId` is needed only when the artifact is not open in a thread here. */
  readonly onMerge: (threadId: string | undefined) => void;
  readonly onRestore: () => void;
  readonly onOpenIn: (threadId: string) => void;
  /** Starts a thread; absent on a host that cannot, which hides the choice. */
  readonly onCreate?: () => void;
  readonly onClose: () => void;
}

const MODE_LABEL = { chat: "Chat", work: "Work", code: "Code" } as const;

/**
 * One synced artifact: which computer wrote each version, and what is left
 * to do with it here.
 *
 * Two versions are shown side by side, each with **Keep this one**, and
 * **Merge** makes a new version from both. A deletion elsewhere offers
 * **Restore**. An artifact that is not open here can be opened in a thread
 * the host found compatible; when there is none, the dialog says so and
 * offers what the person can do instead, never a dead button.
 */
export function SyncedArtifactDialog(props: SyncedArtifactDialogProps) {
  const { detail } = props;
  const [chosenThread, setChosenThread] = useState<string>("");
  const threads = detail?.threads ?? [];
  const threadId =
    threads.find((thread) => thread.threadId === chosenThread)?.threadId ?? threads[0]?.threadId;
  const candidates = detail?.versions.filter((version) => version.candidate) ?? [];

  return (
    <OctantDialog
      className="synced-artifact"
      describedBy="synced-artifact-detail"
      label="Synced artifact"
      labelledBy="synced-artifact-title"
      onClose={props.onClose}
      open={props.open}
    >
      {detail === undefined ? (
        <>
          <h2 className="oct-row-label" id="synced-artifact-title">
            Synced artifact
          </h2>
          <p className="oct-row-detail" id="synced-artifact-detail" role="status">
            {props.message ?? "Reading where its versions came from…"}
          </p>
        </>
      ) : (
        <>
          <h2 className="synced-artifact__title" id="synced-artifact-title">
            {detail.title}
          </h2>
          <p className="oct-row-detail synced-artifact__detail" id="synced-artifact-detail">
            {detail.projectName} · {MODE_LABEL[detail.mode]} ·{" "}
            {detail.openHere ? "Open in a thread here" : "Not open on this computer"}
          </p>
          {props.message === undefined ? null : (
            <p className="oct-row-detail synced-artifact__message" role="status">
              {props.message}
            </p>
          )}

          {detail.status === "two-versions" ? (
            <section aria-labelledby="synced-artifact-two" className="synced-artifact__section">
              <h3 className="oct-section-label" id="synced-artifact-two">
                Two versions
              </h3>
              <p className="oct-row-detail">
                Two computers changed it from the same version. Keep one, or merge them into a new
                version.
              </p>
              <ul className="synced-artifact__choices">
                {candidates.map((version) => (
                  <li className="synced-artifact__choice" key={String(version.versionId)}>
                    <span aria-hidden="true" className="synced-artifact__preview">
                      {version.preview === undefined ? (
                        <span className="artifact-card__preview-fallback">{version.title}</span>
                      ) : (
                        // The host's own drawing; the contract refuses script before it travels.
                        <span
                          className="artifact-card__preview-svg"
                          dangerouslySetInnerHTML={{ __html: version.preview.markup }}
                        />
                      )}
                    </span>
                    <span className="oct-row-label">{version.title}</span>
                    <span className="oct-meta">
                      Written on {version.computerName}
                      {version.thisComputer ? " (this computer)" : ""} ·{" "}
                      {artifactEditedAgo(String(version.createdAt), props.observedAt)}
                    </span>
                    <OctantButton
                      aria-label={`Keep the version from ${version.computerName}`}
                      disabled={props.busy}
                      onClick={() => props.onKeep(version.versionId)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Keep this one
                    </OctantButton>
                  </li>
                ))}
              </ul>
              {detail.openHere ? (
                <div className="synced-artifact__row">
                  <OctantButton
                    disabled={props.busy}
                    onClick={() => props.onMerge(undefined)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Merge
                  </OctantButton>
                  <span className="oct-meta">Opens a new version made from both.</span>
                </div>
              ) : (
                <ThreadChoice
                  action="Merge"
                  actionDetail="Opens a new version made from both in this thread."
                  busy={props.busy}
                  onAct={(id) => props.onMerge(id)}
                  onChange={setChosenThread}
                  mode={detail.mode}
                  {...(props.onCreate === undefined || detail.mode !== "chat"
                    ? {}
                    : { onCreate: props.onCreate })}
                  onClose={props.onClose}
                  threadId={threadId}
                  threads={threads}
                />
              )}
            </section>
          ) : null}

          {detail.status === "deleted" ? (
            <section aria-labelledby="synced-artifact-deleted" className="synced-artifact__section">
              <h3 className="oct-section-label" id="synced-artifact-deleted">
                Deleted on {detail.deletedOn ?? "another computer"}
              </h3>
              <p className="oct-row-detail">
                Restore brings back the last version as a new one on all your computers.
              </p>
              <div className="synced-artifact__row">
                <OctantButton
                  disabled={props.busy}
                  onClick={props.onRestore}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Restore
                </OctantButton>
              </div>
            </section>
          ) : null}

          {detail.status === "current" && !detail.openHere ? (
            <section aria-labelledby="synced-artifact-open" className="synced-artifact__section">
              <h3 className="oct-section-label" id="synced-artifact-open">
                Open on this computer
              </h3>
              <ThreadChoice
                action="Open"
                actionDetail="It joins this thread as content from another computer."
                busy={props.busy}
                onAct={props.onOpenIn}
                onChange={setChosenThread}
                mode={detail.mode}
                {...(props.onCreate === undefined || detail.mode !== "chat"
                  ? {}
                  : { onCreate: props.onCreate })}
                onClose={props.onClose}
                threadId={threadId}
                threads={threads}
              />
            </section>
          ) : null}

          <section aria-labelledby="synced-artifact-versions" className="synced-artifact__section">
            <h3 className="oct-section-label" id="synced-artifact-versions">
              Versions
            </h3>
            <ol className="synced-artifact__versions">
              {detail.versions.map((version) => (
                <li className="synced-artifact__version" key={String(version.versionId)}>
                  <span className="oct-row-label">{version.title}</span>
                  <span className="oct-meta">
                    Written on {version.computerName}
                    {version.thisComputer ? " (this computer)" : ""} ·{" "}
                    {artifactEditedAgo(String(version.createdAt), props.observedAt)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
      <div className="synced-artifact__footer">
        <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
          Close
        </OctantButton>
      </div>
    </OctantDialog>
  );
}

function ThreadChoice(props: {
  readonly action: "Open" | "Merge";
  readonly actionDetail: string;
  readonly threads: ReadonlyArray<ArtifactSyncedThread>;
  readonly threadId: string | undefined;
  readonly busy: boolean;
  readonly onChange: (threadId: string) => void;
  readonly onAct: (threadId: string) => void;
  readonly mode: ArtifactSyncedDetail["mode"];
  /** Offered only for Chat: the library starts a Chat thread. */
  readonly onCreate?: () => void;
  readonly onClose: () => void;
}) {
  const id = `synced-artifact-thread-${props.action.toLowerCase()}`;
  if (props.threads.length === 0) {
    return (
      <div className="synced-artifact__none">
        <p className="oct-row-detail">
          No thread on this computer can take it. Start a {MODE_LABEL[props.mode]} thread, then open
          it here, or keep it in the library.
        </p>
        <div className="synced-artifact__row">
          {props.onCreate === undefined ? null : (
            <OctantButton onClick={props.onCreate} size="sm" type="button" variant="secondary">
              Start a thread
            </OctantButton>
          )}
          <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
            Keep it in the library
          </OctantButton>
        </div>
      </div>
    );
  }
  return (
    <div className="synced-artifact__open">
      <label className="oct-row-label" htmlFor={id}>
        Thread
      </label>
      <OctantSelectField
        className="select"
        id={id}
        onValueChange={props.onChange}
        options={props.threads.map((thread) => ({
          id: thread.threadId,
          label: `${thread.title} · ${thread.projectName}`,
        }))}
        value={props.threadId ?? ""}
      />
      <div className="synced-artifact__row">
        <OctantButton
          disabled={props.busy || props.threadId === undefined}
          onClick={() => {
            if (props.threadId !== undefined) props.onAct(props.threadId);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          {props.action}
        </OctantButton>
        <span className="oct-meta">{props.actionDetail}</span>
      </div>
    </div>
  );
}
