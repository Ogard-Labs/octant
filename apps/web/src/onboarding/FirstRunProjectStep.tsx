import {
  MAX_IMPORTED_PROVIDER_FOLDERS,
  type DiscoveredFolderProvider,
  type DiscoveredProviderFolder,
  type DiscoveredProviderFolderGroup,
  type DiscoveredProviderFolderId,
  type ImportProviderFoldersResult,
  type ImportedProviderFolderOutcome,
  type ProjectId,
  type ProviderFolderScanResult,
  type ProviderFolderScanStopReason,
} from "@octant/contracts";
import { FolderPlus } from "../ui/icons";
import { SettingRow } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantRadioGroup, OctantRadioGroupItem } from "../ui/base/OctantRadioGroup";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FirstRunHandoffProject, FirstRunTaskMode } from "./firstRunHandoffModel";

export interface FirstRunProviderFolderScan {
  readonly strict: boolean;
  readonly scan: (signal?: AbortSignal) => Promise<ProviderFolderScanResult>;
  readonly importFolders: (
    folderIds: readonly [DiscoveredProviderFolderId, ...DiscoveredProviderFolderId[]],
  ) => Promise<ImportProviderFoldersResult>;
}

export interface FirstRunProjectStepProps {
  /** Work can be turned off in Settings; Code is always available. */
  readonly workEnabled: boolean;
  readonly mode: FirstRunTaskMode;
  readonly onSelectMode: (mode: FirstRunTaskMode) => void;
  /** Active Projects of the selected mode. */
  readonly projects: ReadonlyArray<FirstRunHandoffProject>;
  readonly selectedProjectId: ProjectId | undefined;
  readonly onSelectProject: (projectId: ProjectId) => void;
  readonly onChooseFolder: () => void;
  /** Optional host-side read-only scan of folders local providers already used. */
  readonly providerFolderScan?: FirstRunProviderFolderScan | undefined;
  /** Called when a folder import starts or settles so the wizard can hold navigation. */
  readonly onImportingChange?: (importing: boolean) => void;
}

const MODE_COPY: Record<FirstRunTaskMode, { readonly label: string; readonly lead: string }> = {
  work: {
    label: "Work",
    lead: "Work reads and edits the documents, decks, and spreadsheets in the folder. It can’t change anything outside it.",
  },
  code: {
    label: "Code",
    lead: "Code works inside the folder and asks before it changes a file.",
  },
};

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

type ScanState =
  | { readonly status: "idle" }
  | { readonly status: "scanning" }
  | { readonly status: "hidden" }
  | {
      readonly status: "ready";
      readonly result: Extract<ProviderFolderScanResult, { readonly status: "ready" }>;
    }
  | { readonly status: "failed" };

function formatProviders(providers: ReadonlyArray<DiscoveredFolderProvider>): string {
  return providers.map((provider) => PROVIDER_LABELS[provider] ?? provider).join(", ");
}

function formatSessionCount(count: number): string {
  return count === 1 ? "1 session" : `${String(count)} sessions`;
}

function formatLastActivity(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return "";
  const date = new Date(parsed);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatFolderMeta(folder: DiscoveredProviderFolder, requireGitRepository: boolean): string {
  const parts: string[] = [];
  if (folder.alreadyImported) {
    parts.push("Already added");
  } else if (requireGitRepository && !folder.isGitRepository) {
    parts.push("Not a Git repository — use Choose a folder… to initialize Git");
  }
  parts.push(formatProviders(folder.providers));
  parts.push(formatSessionCount(folder.sessionCount));
  const activity = formatLastActivity(folder.lastActivityAt);
  if (activity !== "") parts.push(activity);
  return parts.join(" · ");
}

/**
 * Give clones inside one remote group unique display labels when multiple
 * clones share the same directory basename, without exposing host paths.
 */
function cloneDisplayLabels(
  folders: ReadonlyArray<DiscoveredProviderFolder>,
): ReadonlyArray<string> {
  const totals = new Map<string, number>();
  for (const folder of folders) {
    totals.set(folder.folderName, (totals.get(folder.folderName) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return folders.map((folder) => {
    const count = totals.get(folder.folderName) ?? 1;
    if (count <= 1) return folder.folderName;
    const ordinal = (seen.get(folder.folderName) ?? 0) + 1;
    seen.set(folder.folderName, ordinal);
    return `${folder.folderName} (${String(ordinal)})`;
  });
}

function stoppedEarlyCopy(reason: ProviderFolderScanStopReason | undefined): string {
  if (reason === "file-limit") {
    return "The scan stopped early after reaching its file limit, so some older folders may not be listed. You can still choose any folder below.";
  }
  if (reason === "entry-limit") {
    return "The scan stopped early after reaching its folder limit, so some folders may not be listed. You can still choose any folder below.";
  }
  if (reason === "time-limit") {
    return "The scan stopped early after reaching its time limit, so some folders may not be listed. You can still choose any folder below.";
  }
  return "The scan stopped early, so some folders may not be listed. You can still choose any folder below.";
}

function markFoldersImported(
  groups: ReadonlyArray<DiscoveredProviderFolderGroup>,
  importedIds: ReadonlySet<string>,
): ReadonlyArray<DiscoveredProviderFolderGroup> {
  return groups.map((group) => {
    const updated = group.folders.map((folder) =>
      importedIds.has(String(folder.id)) ? { ...folder, alreadyImported: true } : folder,
    );
    const [first, ...rest] = updated;
    if (first === undefined) return group;
    return { ...group, folders: [first, ...rest] };
  });
}

function batchFolderIds(
  ids: ReadonlyArray<DiscoveredProviderFolderId>,
): ReadonlyArray<readonly [DiscoveredProviderFolderId, ...DiscoveredProviderFolderId[]]> {
  const batches: Array<readonly [DiscoveredProviderFolderId, ...DiscoveredProviderFolderId[]]> = [];
  for (let offset = 0; offset < ids.length; offset += MAX_IMPORTED_PROVIDER_FOLDERS) {
    const slice = ids.slice(offset, offset + MAX_IMPORTED_PROVIDER_FOLDERS);
    const [first, ...rest] = slice;
    if (first !== undefined) batches.push([first, ...rest]);
  }
  return batches;
}

/**
 * The folder the first task works in.
 *
 * Choosing one opens the same Project create surface as the empty Work and
 * Code pages, so first run grants nothing that surface would not, and making
 * the folder a Git repository stays the explicit choice it is there. That
 * surface conceals first run and returns here when it closes.
 *
 * In Code mode (outside Strict), this step also offers a read-only scan of
 * folders the person's providers already used, importing only ticked opaque
 * IDs as Code Projects through the existing Project create path and receipts.
 */
export function FirstRunProjectStep(props: FirstRunProjectStepProps) {
  const metaPrefix = useId();
  const modes: ReadonlyArray<FirstRunTaskMode> = props.workEnabled ? ["work", "code"] : ["code"];
  const hasProjects = props.projects.length > 0;
  const providerScan = props.providerFolderScan;
  const providerScanRef = useRef(providerScan);
  providerScanRef.current = providerScan;
  const onImportingChangeRef = useRef(props.onImportingChange);
  onImportingChangeRef.current = props.onImportingChange;
  const scanAllowed = props.mode === "code" && providerScan !== undefined && !providerScan.strict;

  const [scanState, setScanState] = useState<ScanState>({ status: "idle" });
  const [tickedIds, setTickedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string>();
  const scanControllerRef = useRef<AbortController | undefined>(undefined);
  const scanSeqRef = useRef(0);

  const cancelActiveScan = useCallback(() => {
    scanSeqRef.current += 1;
    scanControllerRef.current?.abort();
    scanControllerRef.current = undefined;
  }, []);

  const runScan = useCallback(async () => {
    const active = providerScanRef.current;
    if (active === undefined || active.strict) return;
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;
    const seq = scanSeqRef.current + 1;
    scanSeqRef.current = seq;
    setScanState({ status: "scanning" });
    setImportNotice(undefined);
    try {
      const result = await active.scan(controller.signal);
      if (controller.signal.aborted || scanSeqRef.current !== seq) return;
      if (result.status === "hidden") {
        setScanState({ status: "hidden" });
        setTickedIds(new Set());
        return;
      }
      setScanState({ status: "ready", result });
      setTickedIds(new Set());
    } catch {
      if (controller.signal.aborted || scanSeqRef.current !== seq) return;
      setScanState({ status: "failed" });
    } finally {
      if (scanControllerRef.current === controller) {
        scanControllerRef.current = undefined;
      }
    }
  }, []);

  useEffect(() => {
    if (!scanAllowed) {
      cancelActiveScan();
      setScanState({ status: "idle" });
      setTickedIds(new Set());
      return;
    }
    void runScan();
    return () => {
      cancelActiveScan();
    };
  }, [scanAllowed, runScan, cancelActiveScan]);

  useEffect(() => {
    return () => {
      onImportingChangeRef.current?.(false);
    };
  }, []);

  function toggleFolder(id: DiscoveredProviderFolderId, checked: boolean): void {
    setTickedIds((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(String(id));
      } else {
        next.delete(String(id));
      }
      return next;
    });
  }

  async function handleImport(): Promise<void> {
    if (providerScan === undefined || scanState.status !== "ready" || importing) return;
    const requireGit = scanState.result.requireGitRepository;
    const allFolders = scanState.result.groups.flatMap((group) => group.folders);
    const chosen = allFolders
      .filter(
        (folder) =>
          !folder.alreadyImported &&
          (!requireGit || folder.isGitRepository) &&
          tickedIds.has(String(folder.id)),
      )
      .map((folder) => folder.id);
    const batches = batchFolderIds(chosen);
    if (batches.length === 0) return;

    setImporting(true);
    onImportingChangeRef.current?.(true);
    setImportNotice(undefined);
    try {
      const aggregated: ImportedProviderFolderOutcome[] = [];
      let strictRefused = false;
      for (const batch of batches) {
        const outcome = await providerScan.importFolders(batch);
        if (outcome.status === "refused") {
          if (outcome.reason === "strict") {
            strictRefused = true;
            setScanState({ status: "hidden" });
            setTickedIds(new Set());
          } else {
            setImportNotice(outcome.message);
          }
          break;
        }
        aggregated.push(...outcome.results);
        if (outcome.results.some((item) => item.status === "refused" && item.reason === "strict")) {
          strictRefused = true;
          setScanState({ status: "hidden" });
          setTickedIds(new Set());
          break;
        }
      }
      if (strictRefused || aggregated.length === 0) return;

      const importedIds = new Set(
        aggregated
          .filter((item) => item.status === "created" || item.status === "already-imported")
          .map((item) => String(item.folderId)),
      );
      const createdCount = aggregated.filter((item) => item.status === "created").length;
      const refusedCount = aggregated.filter((item) => item.status === "refused").length;

      setScanState((previous) =>
        previous.status === "ready"
          ? {
              status: "ready",
              result: {
                ...previous.result,
                groups: markFoldersImported(previous.result.groups, importedIds),
              },
            }
          : previous,
      );
      setTickedIds((previous) => {
        const next = new Set(previous);
        for (const id of importedIds) next.delete(id);
        return next;
      });
      if (createdCount > 0 && refusedCount === 0) {
        setImportNotice(
          createdCount === 1
            ? "Imported 1 Code Project."
            : `Imported ${String(createdCount)} Code Projects.`,
        );
      } else if (createdCount > 0 && refusedCount > 0) {
        setImportNotice(
          `Imported ${String(createdCount)} Code ${createdCount === 1 ? "Project" : "Projects"}; ${String(refusedCount)} could not be imported.`,
        );
      } else if (refusedCount > 0) {
        const firstRefusal = aggregated.find((item) => item.status === "refused");
        setImportNotice(
          firstRefusal?.status === "refused"
            ? firstRefusal.message
            : "Selected folders could not be imported.",
        );
      }
    } catch {
      setImportNotice("Could not import the selected folders.");
    } finally {
      setImporting(false);
      onImportingChangeRef.current?.(false);
    }
  }

  const readyGroups = scanState.status === "ready" ? scanState.result.groups : [];
  const requireGitRepository =
    scanState.status === "ready" ? scanState.result.requireGitRepository : true;
  const showScanSection =
    scanAllowed &&
    (scanState.status === "scanning" ||
      scanState.status === "failed" ||
      (scanState.status === "ready" && (readyGroups.length > 0 || scanState.result.stoppedEarly)));

  const tickedCount = tickedIds.size;
  const importButtonLabel = importing
    ? "Importing…"
    : tickedCount === 1
      ? "Import 1 Code Project"
      : tickedCount > 1
        ? `Import ${String(tickedCount)} Code Projects`
        : "Import selected";

  return (
    <div className="first-run__step">
      <p className="first-run__intro">
        A thread starts in a Project: one folder you choose. {MODE_COPY[props.mode].lead} Choosing a
        folder does not change access permissions.
      </p>

      {modes.length > 1 || hasProjects ? (
        <section
          aria-label="First thread"
          className="settings-card-section settings-card-section--open"
        >
          <h2>First thread</h2>
          <div className="setgroup">
            {modes.length > 1 ? (
              <SettingRow
                description="The mode your first thread starts in."
                label="Mode"
                scope="app"
                settingId="first-run-task-mode"
              >
                <OctantRadioGroup
                  appearance="segmented"
                  aria-label="First thread mode"
                  disabled={importing}
                  onValueChange={(next) => {
                    if (importing) return;
                    if (next === "work" || next === "code") props.onSelectMode(next);
                  }}
                  value={props.mode}
                >
                  {modes.map((mode) => (
                    <OctantRadioGroupItem appearance="segmented" key={mode} value={mode}>
                      {MODE_COPY[mode].label}
                    </OctantRadioGroupItem>
                  ))}
                </OctantRadioGroup>
              </SettingRow>
            ) : null}
            {hasProjects ? (
              <SettingRow
                description="The Project your first thread starts in."
                label="Folder"
                scope="app"
                settingId="first-run-task-project"
              >
                <OctantRadioGroup
                  appearance="segmented"
                  aria-label="First thread folder"
                  onValueChange={(next) => {
                    const selected = props.projects.find((project) => String(project.id) === next);
                    if (selected !== undefined) props.onSelectProject(selected.id);
                  }}
                  value={
                    props.selectedProjectId === undefined ? "" : String(props.selectedProjectId)
                  }
                >
                  {props.projects.map((project) => (
                    <OctantRadioGroupItem
                      appearance="segmented"
                      key={String(project.id)}
                      value={String(project.id)}
                    >
                      {project.name}
                    </OctantRadioGroupItem>
                  ))}
                </OctantRadioGroup>
              </SettingRow>
            ) : null}
          </div>
        </section>
      ) : null}

      {showScanSection ? (
        <section
          aria-label="Folders from your providers"
          className="settings-card-section settings-card-section--open"
        >
          <h2>Folders from your providers</h2>
          {scanState.status === "scanning" ? (
            <p className="first-run__caveat" role="status">
              Looking for folders your providers already used…
            </p>
          ) : null}
          {scanState.status === "failed" ? (
            <div className="first-run__discovered-footer">
              <p className="first-run__caveat" role="status">
                Could not scan provider folders on this computer.
              </p>
              <OctantButton onClick={() => void runScan()} type="button" variant="ghost">
                Scan again
              </OctantButton>
            </div>
          ) : null}
          {scanState.status === "ready" ? (
            <>
              <p className="first-run__caveat">
                Tick folders to import as Code Projects at your first-run access level. Octant reads
                provider session lists only and never changes another tool’s files.
              </p>
              {readyGroups.length > 0 ? (
                <ul
                  aria-label="Discovered provider folders"
                  className="setgroup first-run__discovered-list"
                >
                  {readyGroups.map((group) => {
                    const single = group.folders.length === 1 ? group.folders[0] : undefined;
                    if (single !== undefined) {
                      const needsGit = requireGitRepository && !single.isGitRepository;
                      const checked = single.alreadyImported || tickedIds.has(String(single.id));
                      const metaId = `${metaPrefix}-${String(single.id)}`;
                      return (
                        <li className="setrow first-run__discovered-row" key={String(single.id)}>
                          <label className="first-run__discovered-choice">
                            <OctantCheckbox
                              aria-describedby={metaId}
                              aria-label={group.label}
                              checked={checked}
                              disabled={single.alreadyImported || needsGit || importing}
                              onChange={(event) => toggleFolder(single.id, event.target.checked)}
                            />
                            <span className="first-run__discovered-text">
                              <span className="first-run__discovered-title">{group.label}</span>
                              <span className="first-run__discovered-meta" id={metaId}>
                                {formatFolderMeta(single, requireGitRepository)}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    }
                    const cloneLabels = cloneDisplayLabels(group.folders);
                    return (
                      <li
                        className="setrow first-run__discovered-group"
                        key={`${group.label}:${String(group.folders[0]?.id)}`}
                      >
                        <div className="first-run__discovered-group-header">
                          <span className="first-run__discovered-title">{group.label}</span>
                          <span className="first-run__discovered-meta">
                            {`${String(group.folders.length)} clones · ${formatProviders(group.providers)} · ${formatSessionCount(group.sessionCount)}`}
                          </span>
                        </div>
                        <ul
                          aria-label={`Clones of ${group.label}`}
                          className="first-run__discovered-clones"
                        >
                          {group.folders.map((clone, index) => {
                            const displayName = cloneLabels[index] ?? clone.folderName;
                            const needsGit = requireGitRepository && !clone.isGitRepository;
                            const checked =
                              clone.alreadyImported || tickedIds.has(String(clone.id));
                            const metaId = `${metaPrefix}-${String(clone.id)}`;
                            return (
                              <li className="first-run__discovered-clone" key={String(clone.id)}>
                                <label className="first-run__discovered-choice">
                                  <OctantCheckbox
                                    aria-describedby={metaId}
                                    aria-label={`${group.label} (${displayName})`}
                                    checked={checked}
                                    disabled={clone.alreadyImported || needsGit || importing}
                                    onChange={(event) =>
                                      toggleFolder(clone.id, event.target.checked)
                                    }
                                  />
                                  <span className="first-run__discovered-text">
                                    <span className="first-run__discovered-clone-name">
                                      {displayName}
                                    </span>
                                    <span className="first-run__discovered-meta" id={metaId}>
                                      {formatFolderMeta(clone, requireGitRepository)}
                                    </span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {scanState.result.stoppedEarly ? (
                <p className="first-run__caveat" role="note">
                  {stoppedEarlyCopy(scanState.result.stoppedEarlyReason)}
                </p>
              ) : null}
              <div className="first-run__discovered-footer">
                {readyGroups.length > 0 ? (
                  <OctantButton
                    disabled={tickedCount === 0 || importing}
                    onClick={() => void handleImport()}
                    type="button"
                  >
                    {importButtonLabel}
                  </OctantButton>
                ) : null}
                <OctantButton
                  disabled={importing}
                  onClick={() => void runScan()}
                  type="button"
                  variant="ghost"
                >
                  Scan again
                </OctantButton>
                {importNotice === undefined ? null : (
                  <p className="first-run__caveat" role="status">
                    {importNotice}
                  </p>
                )}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <div className="first-run__button-row">
        <OctantButton
          disabled={importing}
          onClick={props.onChooseFolder}
          type="button"
          variant={hasProjects ? "ghost" : "outline"}
        >
          <FolderPlus aria-hidden="true" size={16} />
          {hasProjects ? "Add another folder" : "Choose a folder…"}
        </OctantButton>
      </div>

      {hasProjects ? null : (
        <p className="first-run__caveat" role="note">
          No {MODE_COPY[props.mode].label} folder yet. You can skip this and choose one when you
          start a thread.
        </p>
      )}
    </div>
  );
}
