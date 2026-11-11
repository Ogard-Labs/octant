import type { ProjectClient } from "@octant/client-runtime/project-client";
import type {
  DesignSystemChoice,
  DesignSystemDocument,
  DesignSystemList,
  DesignSystemListing,
  DesignSystemLocation,
  DesignSystemToken,
  DesignSystemWriteResult,
} from "@octant/contracts/design-systems";
import type { ProjectSummary } from "@octant/contracts/projects";
import { designSystemTemplate } from "@octant/domain/design-system-policy";
import { useCallback, useEffect, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface ProjectDesignSystemSectionProps {
  readonly project: ProjectSummary;
  readonly client: Pick<
    ProjectClient,
    "listDesignSystems" | "readDesignSystem" | "saveDesignSystem"
  >;
  readonly disabled?: boolean;
  /**
   * Swap the design system the Project follows: a file, `none`, or `null` for
   * the automatic rule. Absent when this window cannot change the Project.
   */
  readonly onChoose?: (choice: DesignSystemChoice | null) => Promise<boolean>;
}

type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

const REFUSAL_COPY: Readonly<
  Record<Extract<DesignSystemWriteResult, { status: "refused" }>["reason"], string>
> = {
  exists: "A DESIGN.md is already there. Open it from the list instead.",
  stale:
    "The file changed since you opened it, perhaps in an editor or by an agent. Reload it, then make your change again.",
  missing: "The file is gone. Create it again to keep your text.",
  "too-large": "The design system is larger than Octant edits; use your editor.",
  "not-a-file": "That name is not a regular file, so Octant leaves it alone.",
  "folder-unavailable":
    "That folder is not in this Project, or it is a link Octant does not follow.",
  unwritable: "The folder refused the write.",
};

const GROUP_LABEL: Readonly<Record<DesignSystemToken["group"], string>> = {
  color: "Colour",
  font: "Typography",
  radius: "Radius",
  space: "Spacing",
};

function sameLocation(a: DesignSystemLocation, b: DesignSystemLocation): boolean {
  return a.folder === b.folder && a.path === b.path;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** Where a file lives, as a person reads it: relative in the main folder, else under its folder. */
function placeOf(location: DesignSystemLocation, mainFolder: string | undefined): string {
  return location.folder === mainFolder ? location.path : `${location.folder}/${location.path}`;
}

/**
 * The Project's design systems: every `DESIGN.md` in its folders, one drawn
 * as swatches and samples, edited in place, or created from a starter.
 *
 * The file is the source of truth. Octant reads it each time and saves only
 * over the exact text it showed, so an edit made meanwhile in an editor or by
 * an agent is never overwritten unseen.
 */
export function ProjectDesignSystemSection(props: ProjectDesignSystemSectionProps) {
  const projectId = props.project.id;
  const mainFolder =
    props.project.type === "chat" ? undefined : props.project.binding.canonicalRoot;
  const [list, setList] = useState<Loaded<DesignSystemList>>({ status: "loading" });
  const [selected, setSelected] = useState<DesignSystemLocation | undefined>(undefined);
  const [document, setDocument] = useState<Loaded<DesignSystemDocument> | undefined>(undefined);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [newFolder, setNewFolder] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const disabled = props.disabled === true || pending;

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const value = await props.client.listDesignSystems(projectId, signal);
        if (signal?.aborted === true) return;
        setList({ status: "ready", value });
        setSelected((current) => {
          const still =
            current === undefined
              ? undefined
              : value.systems.find((system) => sameLocation(system, current));
          const next = still ?? value.systems.find((system) => system.primary) ?? value.systems[0];
          return next === undefined ? undefined : { folder: next.folder, path: next.path };
        });
      } catch (error) {
        if (signal?.aborted === true) return;
        setList({
          status: "failed",
          message: failureMessage(error, "Design systems could not be read."),
        });
      }
    },
    [props.client, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => controller.abort();
  }, [loadList]);

  const loadDocument = useCallback(
    async (location: DesignSystemLocation, signal?: AbortSignal) => {
      setDocument({ status: "loading" });
      try {
        const value = await props.client.readDesignSystem(projectId, location, signal);
        if (signal?.aborted !== true) setDocument({ status: "ready", value });
      } catch (error) {
        if (signal?.aborted !== true) {
          setDocument({
            status: "failed",
            message: failureMessage(error, "This design system could not be read."),
          });
        }
      }
    },
    [props.client, projectId],
  );

  useEffect(() => {
    setDraft(undefined);
    setNotice(undefined);
    if (selected === undefined) {
      setDocument(undefined);
      return;
    }
    const controller = new AbortController();
    void loadDocument(selected, controller.signal);
    return () => controller.abort();
  }, [selected, loadDocument]);

  async function save(
    location: DesignSystemLocation,
    text: string,
    baseRevision: string | undefined,
  ) {
    setPending(true);
    setNotice(undefined);
    try {
      const result = await props.client.saveDesignSystem({
        projectId: String(projectId),
        folder: location.folder,
        path: location.path,
        text,
        ...(baseRevision === undefined ? {} : { baseRevision }),
      });
      if (result.status === "refused") {
        setNotice(REFUSAL_COPY[result.reason]);
        return;
      }
      setDraft(undefined);
      setDocument({ status: "ready", value: result.document });
      setSelected({ folder: location.folder, path: location.path });
      await loadList();
    } catch (error) {
      setNotice(failureMessage(error, "The design system could not be saved."));
    } finally {
      setPending(false);
    }
  }

  async function choose(choice: DesignSystemChoice | null) {
    if (props.onChoose === undefined) return;
    setPending(true);
    setNotice(undefined);
    try {
      if (!(await props.onChoose(choice))) {
        setNotice("The Project's design system was not changed.");
        return;
      }
      await loadList();
    } finally {
      setPending(false);
    }
  }

  function create() {
    if (mainFolder === undefined) return;
    const folder = folderName;
    void save(
      { folder: mainFolder, path: folder === "" ? "DESIGN.md" : `${folder}/DESIGN.md` },
      designSystemTemplate(
        folder === "" ? props.project.name : (folder.split("/").at(-1) ?? props.project.name),
      ),
      undefined,
    );
  }

  const folderName = newFolder.trim().replace(/^\/+|\/+$/g, "");
  const newFolderRefusal =
    folderName === "" ||
    (!folderName.includes("\\") &&
      folderName.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
      ? undefined
      : "Name a folder inside this Project, such as apps/web.";
  const systems = list.status === "ready" ? list.value.systems : [];
  const hasTop = systems.some(
    (system) => system.folder === mainFolder && system.path === "DESIGN.md",
  );

  return (
    <section
      aria-labelledby={`design-system-${String(projectId)}`}
      className="project-provider-policy project-design-system"
    >
      <div className="project-provider-policy__header">
        <div>
          <h2 id={`design-system-${String(projectId)}`}>Design system</h2>
          <p>
            Each DESIGN.md in this Project&apos;s folder is a design system. Every Work and Code
            turn follows it, and Canvas documents, decks, and designs draw with its tokens. The
            nearest DESIGN.md above a file governs it.
          </p>
        </div>
      </div>

      {list.status === "loading" ? (
        <p className="project-provider-policy__hint">Reading the folder…</p>
      ) : null}
      {list.status === "failed" ? <OctantAlert tone="warning">{list.message}</OctantAlert> : null}

      {systems.length > 0 ? (
        <ul aria-label="Design systems" className="project-design-system__list">
          {systems.map((system: DesignSystemListing) => {
            const current = selected !== undefined && sameLocation(system, selected);
            return (
              <li key={`${system.folder}\u0000${system.path}`}>
                <OctantButton
                  aria-current={current ? "true" : undefined}
                  onClick={() => setSelected({ folder: system.folder, path: system.path })}
                  size="sm"
                  type="button"
                  variant={current ? "secondary" : "ghost"}
                >
                  {system.name}
                </OctantButton>
                <span className="project-provider-policy__hint">{placeOf(system, mainFolder)}</span>
                {system.primary ? <OctantBadge variant="outline">Project</OctantBadge> : null}
              </li>
            );
          })}
        </ul>
      ) : list.status === "ready" ? (
        <p className="project-provider-policy__hint">
          No DESIGN.md yet. Create one to give this Project&apos;s code and documents one look.
        </p>
      ) : null}
      {list.status === "ready" && list.value.truncated ? (
        <p className="project-provider-policy__hint">
          The search stopped early; deeper files are not listed.
        </p>
      ) : null}

      {list.status === "ready" ? (
        <FollowsLine
          disabled={disabled}
          list={list.value}
          mainFolder={mainFolder}
          {...(props.onChoose === undefined ? {} : { onChoose: (choice) => void choose(choice) })}
        />
      ) : null}

      {notice === undefined ? null : <OctantAlert tone="warning">{notice}</OctantAlert>}

      {document?.status === "loading" ? (
        <p className="project-provider-policy__hint">Opening…</p>
      ) : null}
      {document?.status === "failed" ? (
        <OctantAlert tone="warning">{document.message}</OctantAlert>
      ) : null}
      {document?.status === "ready" ? (
        draft === undefined ? (
          <DesignSystemView
            disabled={disabled}
            document={document.value}
            onEdit={() => setDraft(document.value.text)}
            onReload={() => void loadDocument(document.value)}
            {...(props.onChoose === undefined ||
            systems.find((system) => sameLocation(system, document.value))?.primary === true
              ? {}
              : {
                  onUse: () =>
                    void choose({
                      kind: "file",
                      folder: document.value.folder,
                      path: document.value.path,
                    }),
                })}
          />
        ) : (
          <div className="project-design-system__editor">
            <OctantTextarea
              aria-label={`Edit ${document.value.path}`}
              disabled={disabled}
              onChange={(event) => setDraft(event.currentTarget.value)}
              rows={18}
              spellCheck={false}
              value={draft}
            />
            <div>
              <OctantButton
                disabled={disabled || draft === document.value.text}
                onClick={() => void save(document.value, draft, document.value.revision)}
                size="sm"
                type="button"
              >
                Save
              </OctantButton>
              <OctantButton
                disabled={pending}
                onClick={() => {
                  setDraft(undefined);
                  setNotice(undefined);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </OctantButton>
              <OctantButton
                disabled={pending}
                onClick={() => {
                  // The draft was written against the old text; keeping it under
                  // the new revision would let Save overwrite the change it was
                  // refused for. Reload replaces it, as the stale notice says.
                  setDraft(undefined);
                  setNotice(undefined);
                  void loadDocument(document.value);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Reload from disk
              </OctantButton>
            </div>
          </div>
        )
      ) : null}

      {mainFolder === undefined || list.status !== "ready" ? null : (
        <div className="project-design-system__create">
          <label className="project-provider-policy__mode">
            <span>New in folder</span>
            <OctantInput
              aria-invalid={newFolderRefusal === undefined ? undefined : true}
              aria-label="Folder for a new design system"
              disabled={disabled}
              onChange={(event) => setNewFolder(event.currentTarget.value)}
              placeholder={hasTop ? "apps/web" : "Top of the Project"}
              value={newFolder}
            />
            {newFolderRefusal === undefined ? null : (
              <OctantFieldError>{newFolderRefusal}</OctantFieldError>
            )}
          </label>
          <div>
            <OctantButton
              disabled={disabled || newFolderRefusal !== undefined || (folderName === "" && hasTop)}
              onClick={create}
              size="sm"
              type="button"
            >
              Create DESIGN.md
            </OctantButton>
          </div>
        </div>
      )}
    </section>
  );
}

function DesignSystemView(props: {
  readonly document: DesignSystemDocument;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onReload: () => void;
  /** Make this the Project's design system; absent when it already is, or no change is offered. */
  readonly onUse?: () => void;
}) {
  const reading = props.document.reading;
  const drawn = reading.tokens.filter((token) => token.status !== "refused");
  const refused = reading.tokens.filter((token) => token.status === "refused");
  const groups = (["color", "font", "radius", "space"] as const)
    .map((group) => ({ group, tokens: drawn.filter((token) => token.group === group) }))
    .filter((entry) => entry.tokens.length > 0);
  return (
    <div className="project-design-system__view">
      <div className="project-design-system__title">
        <h3>{reading.name}</h3>
        {reading.description === undefined ? null : (
          <p className="project-provider-policy__hint">{reading.description}</p>
        )}
      </div>
      {reading.frontMatter === "invalid" ? (
        <OctantAlert tone="warning">
          The front matter between the --- lines could not be read, so no tokens reach Canvas.
        </OctantAlert>
      ) : null}
      {reading.frontMatter === "absent" ? (
        <p className="project-provider-policy__hint">
          This file has no tokens. Turns still follow its text; add colours, typography, radius, and
          spacing in front matter for Canvas to draw with them.
        </p>
      ) : null}
      {groups.map(({ group, tokens }) => (
        <div className="project-design-system__group" key={group}>
          <h4>{GROUP_LABEL[group]}</h4>
          <ul
            aria-label={GROUP_LABEL[group]}
            className={`project-design-system__tokens project-design-system__tokens--${group}`}
          >
            {tokens.map((token) => (
              <li key={token.token}>
                <TokenSample token={token} />
                <span className="project-design-system__token-name">{token.key}</span>
                <code>{token.carriedValue ?? token.value}</code>
                {token.note === undefined ? null : (
                  <span className="project-provider-policy__hint">{token.note}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {refused.length === 0 ? null : (
        <div className="project-design-system__group">
          <h4>Not used by Canvas</h4>
          <ul aria-label="Not used by Canvas" className="project-design-system__refused">
            {refused.map((token, index) => (
              <li key={`${token.token}-${String(index)}`}>
                <code>{token.key}</code>{" "}
                <span className="project-provider-policy__hint">{token.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {reading.ignoredKeys.length === 0 ? null : (
        <p className="project-provider-policy__hint">
          Also in the front matter, for people and agents to read: {reading.ignoredKeys.join(", ")}.
        </p>
      )}
      {reading.sections.length === 0 ? null : (
        <div className="project-design-system__group">
          <h4>Sections</h4>
          <p className="project-provider-policy__hint">{reading.sections.join(" · ")}</p>
        </div>
      )}
      <div>
        <OctantButton disabled={props.disabled} onClick={props.onEdit} size="sm" type="button">
          Edit
        </OctantButton>
        <OctantButton
          disabled={props.disabled}
          onClick={props.onReload}
          size="sm"
          type="button"
          variant="ghost"
        >
          Reload
        </OctantButton>
        {props.onUse === undefined ? null : (
          <OctantButton
            disabled={props.disabled}
            onClick={props.onUse}
            size="sm"
            type="button"
            variant="ghost"
          >
            Use for this Project
          </OctantButton>
        )}
      </div>
    </div>
  );
}

/**
 * Which design system the Project follows, and the two ways to change that
 * besides choosing a file: back to the automatic rule, or off.
 */
function FollowsLine(props: {
  readonly list: DesignSystemList;
  readonly mainFolder: string | undefined;
  readonly disabled: boolean;
  readonly onChoose?: (choice: DesignSystemChoice | null) => void;
}) {
  const primary = props.list.systems.find((system) => system.primary);
  const choice = props.list.choice;
  const follows =
    choice?.kind === "none"
      ? "Design systems are off for this Project: turns get no design system and Canvas uses the brand kit or the workspace colours."
      : props.list.choiceMissing === true && choice?.kind === "file"
        ? `The chosen ${placeOf(choice, props.mainFolder)} is missing, so this Project follows no design system until it is back or another is chosen.`
        : primary === undefined
          ? props.list.systems.length === 0
            ? undefined
            : "No design system speaks for the whole Project. Choose one, or add a DESIGN.md at the top."
          : `This Project follows ${primary.name} (${placeOf(primary, props.mainFolder)})${choice === undefined ? ", the top-level file" : ""}.`;
  if (follows === undefined && choice === undefined) return null;
  return (
    <div className="project-design-system__follows">
      {follows === undefined ? null : <p className="project-provider-policy__hint">{follows}</p>}
      {props.onChoose === undefined ? null : (
        <div>
          {choice === undefined ? null : (
            <OctantButton
              disabled={props.disabled}
              onClick={() => props.onChoose?.(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Follow the top-level file
            </OctantButton>
          )}
          {choice?.kind === "none" || props.list.systems.length === 0 ? null : (
            <OctantButton
              disabled={props.disabled}
              onClick={() => props.onChoose?.({ kind: "none" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              Turn off design systems
            </OctantButton>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A token drawn as what it is. The value already passed the brand rule on the
 * host, which refuses anything that could leave its declaration.
 */
function TokenSample(props: { readonly token: DesignSystemToken }) {
  const value = props.token.carriedValue ?? props.token.value;
  switch (props.token.group) {
    case "color":
      return (
        <span
          aria-hidden="true"
          className="project-design-system__swatch"
          style={{ background: value }}
        />
      );
    case "font":
      return (
        <span
          aria-hidden="true"
          className="project-design-system__type"
          style={{ fontFamily: value }}
        >
          Aa
        </span>
      );
    case "radius":
      return (
        <span
          aria-hidden="true"
          className="project-design-system__radius"
          style={{ borderRadius: value }}
        />
      );
    case "space":
      return (
        <span
          aria-hidden="true"
          className="project-design-system__space"
          style={{ width: `min(${value}, 160px)` }}
        />
      );
  }
}
