import { BookOpen, Puzzle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  ExtensionCatalogEntry,
  ExtensionCommand,
  ExtensionCommandFailure,
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
  SkillMarketplaceEntry,
  SkillPackagePreview,
} from "@octant/contracts/extension-rpc";
import type {
  ExtensionActivationScope,
  ExtensionBlockReason,
  ExtensionEffectiveState,
  ExtensionSource,
  StandaloneSkillRecord,
} from "@octant/contracts/extensions";
import type { ExtensionPackagePreview } from "@octant/contracts/extension-rpc";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTabs, OctantTabsList, OctantTabsPanel, OctantTabsTab } from "../ui/base/OctantTabs";

/**
 * Human-readable labels for the deterministic {@link ExtensionBlockReason}
 * values. Kept provider-neutral and free of host/private detail so the Settings
 * surface stays actionable across every mode and provider family.
 */
const BLOCK_REASON_LABELS: Readonly<Record<ExtensionBlockReason, string>> = {
  "host-prohibited": "Host prohibited",
  "mode-prohibited": "Mode prohibited",
  "project-prohibited": "Project prohibited",
  "thread-prohibited": "Thread prohibited",
  "stale-catalog-epoch": "Catalog changed",
  "not-installed": "Not installed",
  untrusted: "Untrusted",
  "plugin-disabled": "Plugin disabled",
  "component-disabled": "Component disabled",
  incompatible: "Incompatible",
  quarantined: "Quarantined",
  draining: "Draining",
  broken: "Broken",
  unavailable: "Unavailable",
  interrupted: "Interrupted",
  waiting: "Waiting",
};

/** Runtime states that block enablement while cleanup is unresolved. */
const ENABLE_BLOCKING_STATES: ReadonlySet<ExtensionBlockReason> = new Set([
  "quarantined",
  "draining",
  "broken",
  "unavailable",
  "interrupted",
  "waiting",
]);

function effectiveLabel(state: ExtensionEffectiveState): string {
  return state.kind === "effective"
    ? "Effective"
    : `Blocked — ${BLOCK_REASON_LABELS[state.reason]}`;
}

function sourceLabel(source: ExtensionSnapshot["packages"][number]["source"]): string {
  switch (source.kind) {
    case "bundled":
      return "Bundled";
    case "catalog":
      if (source.catalogId === "skills-sh") return "skills.sh";
      if (source.catalogId === "npm") return "npm";
      return "Catalog";
    case "local-folder":
      return "Local folder";
    case "agents-skills-directory":
      return "Agents skills directory";
    case "plugin-package":
      return "Plugin package";
    case "provider-native":
      return "Provider native";
  }
}

function standaloneSkillSourceLabel(skill: StandaloneSkillRecord): string {
  if (skill.source.kind !== "agents-skills-directory") return sourceLabel(skill.source);
  const sourceRef = String(skill.source.sourceRef);
  if (sourceRef === "user-global") return "User-global · ~/.agents/skills";
  const projectSource = /^project:[^:]+:(working|parent-(\d+))$/.exec(sourceRef);
  if (projectSource?.[1] === "working") return "Project skills · working directory";
  if (projectSource?.[2] !== undefined) return `Project skills · parent ${projectSource[2]}`;
  return "Agents skills directory";
}

function licenseLabel(license: ExtensionPackagePreview["review"]["license"]): string {
  switch (license.kind) {
    case "spdx":
      return license.identifier;
    case "custom":
      return license.label;
    case "unreported":
      return "Unreported";
  }
}

type LoadStatus = "loading" | "ready" | "unavailable";

type FailureBanner = {
  readonly category: ExtensionCommandFailure["category"];
  readonly message: string;
};

/**
 * Exact identity comparison for catalog entries. The preview must only render
 * under a search result whose source provenance, version, and digest all match
 * the inspected entry. Production search returns `source.kind = "catalog"`;
 * inspection normalizes that into `source.kind = "plugin-package"` with a
 * canonical reference of `catalog:<catalogId>:<entryId>`. Only that exact
 * same-kind or catalog → plugin-package transition is allowed. A local-folder
 * or arbitrary plugin-package sourceRef must never alias a catalog entry, and
 * no other cross-kind identity is accepted. Matching on extensionId/packageId
 * alone is unsafe because a changed catalog can return a different
 * version/digest/source for the same IDs.
 */
function sameEntryIdentity(a: ExtensionCatalogEntry, b: ExtensionCatalogEntry): boolean {
  return (
    a.extensionId === b.extensionId &&
    a.packageId === b.packageId &&
    a.version === b.version &&
    a.digest === b.digest &&
    sameEntrySource(a.source, b.source)
  );
}

function catalogReference(source: Extract<ExtensionSource, { kind: "catalog" }>): string {
  return `catalog:${source.catalogId}:${source.entryId}`;
}

function sameEntrySource(a: ExtensionSource, b: ExtensionSource): boolean {
  if (a.kind === "catalog" && b.kind === "catalog") {
    return a.catalogId === b.catalogId && a.entryId === b.entryId;
  }
  // Allow the intended catalog search → canonical plugin-package inspection.
  if (a.kind === "catalog" && b.kind === "plugin-package") {
    return b.sourceRef === catalogReference(a);
  }
  if (a.kind === "plugin-package" && b.kind === "catalog") {
    return a.sourceRef === catalogReference(b);
  }
  // Same non-catalog kinds compare their exact source references.
  if (a.kind === b.kind && "sourceRef" in a && "sourceRef" in b) {
    return a.sourceRef === b.sourceRef;
  }
  return false;
}

type SkillPackageAction = "install" | "update" | "current";

function skillPackageAction(
  snapshot: ExtensionSnapshot | undefined,
  preview: SkillPackagePreview,
): SkillPackageAction {
  const installed = snapshot?.packages.find(
    (pkg) =>
      pkg.activation.installed &&
      pkg.extensionId === preview.extensionId &&
      pkg.packageId === preview.packageId,
  );
  if (installed === undefined) return "install";
  return installed.version === preview.entry.version &&
    installed.digest === preview.entry.skill.digest
    ? "current"
    : "update";
}

export interface ExtensionsSettingsViewProps {
  readonly client: ExtensionClient;
  readonly showHeading?: boolean;
  /**
   * Scope used to project the authoritative effective state. Settings is a
   * host-scoped surface with no active thread, so a neutral Project-less scope
   * is used by default; callers may override it when a mode/provider context is
   * known.
   */
  readonly scope?: ExtensionActivationScope;
  /**
   * Optional desktop/native directory picker. Browser-only Settings omits local
   * import because it cannot mint a native, window-bound filesystem receipt.
   */
  readonly pickLocalPluginFolder?: () => Promise<
    Readonly<{ receiptId: string; displayName: string }> | undefined
  >;
}

const DEFAULT_EXTENSION_SETTINGS_SCOPE: ExtensionActivationScope = {
  hostId: LOCAL_HOST_ID,
  mode: "code",
  projectId: null,
  threadId: null,
  providerFamily: "openai-compatible" as never,
};

/** Command version shared by every desired-state mutation. */
const COMMAND_VERSION = 1 as never;

export function ExtensionsSettingsView(props: ExtensionsSettingsViewProps) {
  const scope = props.scope ?? DEFAULT_EXTENSION_SETTINGS_SCOPE;
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot | undefined>();
  const [effective, setEffective] = useState<ExtensionEffectiveSnapshot | undefined>();
  const [failure, setFailure] = useState<FailureBanner | undefined>();
  const [marketplaceQuery, setMarketplaceQuery] = useState("");
  const [marketplaceEntries, setMarketplaceEntries] = useState<
    ReadonlyArray<ExtensionCatalogEntry>
  >([]);
  const [marketplaceStatus, setMarketplaceStatus] = useState<
    "idle" | "searching" | "empty" | "offline" | "failed"
  >("idle");
  const [busyPackageId, setBusyPackageId] = useState<string | undefined>();
  const [inspectingEntryId, setInspectingEntryId] = useState<string | undefined>();
  const [preview, setPreview] = useState<ExtensionPackagePreview | undefined>();
  const [localPreview, setLocalPreview] = useState<ExtensionPackagePreview | undefined>();
  const [installing, setInstalling] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillEntries, setSkillEntries] = useState<ReadonlyArray<SkillMarketplaceEntry>>([]);
  const [skillStatus, setSkillStatus] = useState<"idle" | "searching" | "empty" | "failed">("idle");
  const [skillPreview, setSkillPreview] = useState<SkillPackagePreview | undefined>();
  const [inspectingSkillId, setInspectingSkillId] = useState<string | undefined>();
  const [installingSkill, setInstallingSkill] = useState(false);
  const [importingLocal, setImportingLocal] = useState(false);

  const importLocalPlugin = useCallback(
    async (selection: Readonly<{ receiptId: string; displayName: string }>) => {
      setImportingLocal(true);
      setFailure(undefined);
      try {
        const result = await props.client.importLocalPluginReceipt(selection.receiptId);
        if (result.kind === "extension-command-failed") {
          setFailure(result.failure);
          return;
        }
        if (result.kind === "package-inspected") {
          setLocalPreview(result.preview);
          setPreview(undefined);
        }
      } catch (error) {
        setFailure({
          category: "unavailable",
          message: error instanceof Error ? error.message : "Local plugin import failed.",
        });
      } finally {
        setImportingLocal(false);
      }
    },
    [props.client],
  );

  const reload = useCallback(async () => {
    setStatus("loading");
    setFailure(undefined);
    try {
      let next = await props.client.snapshot();
      try {
        const reconciled = await props.client.execute({ kind: "reconcile-skills" });
        if (reconciled.kind === "extension-state-updated") {
          next = reconciled.snapshot;
        } else if (reconciled.kind === "extension-command-failed") {
          setFailure({
            category: reconciled.failure.category,
            message: reconciled.failure.message,
          });
        }
      } catch {
        setFailure({
          category: "unavailable" as never,
          message: "Standalone skill discovery could not be refreshed.",
        });
      }
      const scoped = await props.client.effectiveState({ scope });
      if (scoped.catalogStatus === "offline") {
        setMarketplaceEntries([]);
        setPreview(undefined);
        setLocalPreview(undefined);
        setMarketplaceStatus("offline");
      }
      setSnapshot(next);
      setEffective(scoped);
      setStatus("ready");
    } catch {
      setStatus("unavailable");
    }
  }, [props.client, scope]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runLifecycle = useCallback(
    async (command: ExtensionCommand, packageId?: string): Promise<boolean> => {
      if (packageId !== undefined) setBusyPackageId(packageId);
      setFailure(undefined);
      try {
        const result = await props.client.execute(command);
        if (result.kind === "extension-command-failed") {
          setFailure({ category: result.failure.category, message: result.failure.message });
          return false;
        }
        await reload();
        return true;
      } catch {
        setFailure({
          category: "unavailable" as never,
          message: "Extension service is unavailable.",
        });
        return false;
      } finally {
        if (packageId !== undefined) setBusyPackageId(undefined);
      }
    },
    [props.client, reload],
  );

  const runSearch = useCallback(async () => {
    setMarketplaceEntries([]);
    if (effective?.catalogStatus === "offline") {
      setMarketplaceStatus("offline");
      return;
    }
    setMarketplaceStatus("searching");
    setFailure(undefined);
    // Clear any stale preview from a previous inspection so a changed catalog
    // result cannot render old inspected metadata under new search results.
    setPreview(undefined);
    setLocalPreview(undefined);
    try {
      const result = await props.client.execute({
        kind: "search-catalog",
        query: marketplaceQuery.trim(),
      });
      if (result.kind === "extension-command-failed") {
        setFailure({ category: result.failure.category, message: result.failure.message });
        setMarketplaceStatus("failed");
        return;
      }
      if (result.kind === "catalog-search-results") {
        setMarketplaceEntries(result.entries);
        setMarketplaceStatus(result.entries.length === 0 ? "empty" : "idle");
      }
    } catch {
      setMarketplaceStatus("failed");
    }
  }, [props.client, effective, marketplaceQuery]);

  const inspectEntry = useCallback(
    async (entry: ExtensionCatalogEntry) => {
      const entryKey = `${entry.extensionId}:${entry.packageId}`;
      setInspectingEntryId(entryKey);
      setPreview(undefined);
      setLocalPreview(undefined);
      setFailure(undefined);
      try {
        const inspection = await props.client.execute({
          kind: "inspect-package",
          source: entry.source,
          ...(entry.digest === undefined ? {} : { expectedDigest: entry.digest }),
        });
        if (inspection.kind === "extension-command-failed") {
          setFailure({
            category: inspection.failure.category,
            message: inspection.failure.message,
          });
          return;
        }
        if (inspection.kind === "package-inspected") {
          setPreview(inspection.preview);
        }
      } catch {
        setFailure({
          category: "unavailable" as never,
          message: "Extension service is unavailable.",
        });
      } finally {
        setInspectingEntryId(undefined);
      }
    },
    [props.client],
  );

  const confirmInstall = useCallback(
    async (entry: ExtensionCatalogEntry) => {
      if (installing) return;
      setInstalling(true);
      setFailure(undefined);
      try {
        const installed = await props.client.execute({
          kind: "install-package",
          extensionId: entry.extensionId,
          packageId: entry.packageId,
          version: entry.version,
          digest: entry.digest,
        });
        if (installed.kind === "extension-command-failed") {
          setFailure({
            category: installed.failure.category,
            message: installed.failure.message,
          });
          return;
        }
        setPreview(undefined);
        setLocalPreview(undefined);
        await reload();
      } catch {
        setFailure({
          category: "unavailable" as never,
          message: "Extension service is unavailable.",
        });
      } finally {
        setInstalling(false);
      }
    },
    [props.client, reload, installing],
  );

  const runSkillSearch = useCallback(async () => {
    setSkillStatus("searching");
    setFailure(undefined);
    setSkillEntries([]);
    setSkillPreview(undefined);
    try {
      const result = await props.client.execute({
        kind: "search-skills",
        query: skillQuery.trim(),
      });
      if (result.kind === "extension-command-failed") {
        setFailure({ category: result.failure.category, message: result.failure.message });
        setSkillStatus("failed");
        return;
      }
      if (result.kind === "skill-search-results") {
        setSkillEntries(result.entries);
        setSkillStatus(result.entries.length === 0 ? "empty" : "idle");
      }
    } catch {
      setSkillStatus("failed");
    }
  }, [props.client, skillQuery]);

  const previewSkillEntry = useCallback(
    async (entry: SkillMarketplaceEntry) => {
      const entryKey = String(entry.skill.qualifiedId);
      setInspectingSkillId(entryKey);
      setSkillPreview(undefined);
      setFailure(undefined);
      try {
        const result = await props.client.execute({
          kind: "preview-skill",
          source: entry.source,
        });
        if (result.kind === "extension-command-failed") {
          setFailure({
            category: result.failure.category,
            message: result.failure.message,
          });
          return;
        }
        if (result.kind === "skill-package-preview") {
          setSkillPreview(result.preview);
        }
      } catch {
        setFailure({
          category: "unavailable" as never,
          message: "Skill marketplace is unavailable.",
        });
      } finally {
        setInspectingSkillId(undefined);
      }
    },
    [props.client],
  );

  const confirmSkillInstall = useCallback(
    async (preview: SkillPackagePreview) => {
      if (installingSkill) return;
      const action = skillPackageAction(snapshot, preview);
      if (action === "current") return;
      setInstallingSkill(true);
      setFailure(undefined);
      try {
        const installed = await props.client.execute({
          kind: action === "update" ? "update-skill" : "install-skill",
          extensionId: preview.extensionId,
          packageId: preview.packageId,
          version: preview.entry.version,
          digest: preview.entry.skill.digest,
        });
        if (installed.kind === "extension-command-failed") {
          setFailure({
            category: installed.failure.category,
            message: installed.failure.message,
          });
          return;
        }
        setSkillPreview(undefined);
        await reload();
      } catch {
        setFailure({
          category: "unavailable" as never,
          message: "Skill marketplace is unavailable.",
        });
      } finally {
        setInstallingSkill(false);
      }
    },
    [props.client, reload, installingSkill, snapshot],
  );

  if (status === "unavailable") {
    return (
      <section
        aria-label={props.showHeading === false ? "Skills & Extensions" : undefined}
        aria-labelledby={props.showHeading === false ? undefined : "extensions-settings-heading"}
        className="extensions-settings"
        id="settings-skills"
      >
        {props.showHeading === false ? null : (
          <h2 id="extensions-settings-heading">Skills &amp; Extensions</h2>
        )}
        <p className="extensions-settings__state" role="status" aria-label="Extensions unavailable">
          Extensions are unavailable.
        </p>
      </section>
    );
  }

  if (status === "loading" || snapshot === undefined) {
    return (
      <section
        aria-label={props.showHeading === false ? "Skills & Extensions" : undefined}
        aria-labelledby={props.showHeading === false ? undefined : "extensions-settings-heading"}
        className="extensions-settings"
        id="settings-skills"
      >
        {props.showHeading === false ? null : (
          <h2 id="extensions-settings-heading">Skills &amp; Extensions</h2>
        )}
        <p className="extensions-settings__state" role="status">
          Loading extensions…
        </p>
      </section>
    );
  }

  const catalogOffline = effective?.catalogStatus === "offline";
  const installedPackages = snapshot.packages.filter((pkg) => pkg.activation.installed);
  const standaloneSkills = snapshot.skills ?? [];
  const skillPreviewAction =
    skillPreview === undefined ? undefined : skillPackageAction(snapshot, skillPreview);

  return (
    <section
      aria-label={props.showHeading === false ? "Skills & Extensions" : undefined}
      aria-labelledby={props.showHeading === false ? undefined : "extensions-settings-heading"}
      className="extensions-settings"
      id="settings-skills"
    >
      {props.showHeading === false ? null : (
        <h2 id="extensions-settings-heading">Skills &amp; Extensions</h2>
      )}
      <p className="extensions-settings__description">
        Installed plugins and skills contribute context or executable components only after explicit
        trust, enablement, compatibility, and host/mode/Project/thread policy all resolve effective.
      </p>
      <OctantTabs defaultValue="installed">
        <OctantTabsList>
          <OctantTabsTab value="installed">Installed</OctantTabsTab>
          <OctantTabsTab value="marketplace">Marketplace</OctantTabsTab>
        </OctantTabsList>

        <OctantTabsPanel value="installed">
          <section aria-labelledby="installed-extension-packages-heading" className="setgroup">
            <h3 className="setgroup-head" id="installed-extension-packages-heading">
              Extension packages
            </h3>
            <div className="extensions-settings__body">
              {installedPackages.length === 0 ? (
                <p className="extensions-settings__state" role="status">
                  No extension packages are installed.
                </p>
              ) : (
                <ul className="extensions-settings__cards">
                  {installedPackages.map((pkg) => (
                    <InstalledPackageCard
                      key={`${pkg.extensionId}:${pkg.packageId}`}
                      packageState={pkg}
                      busy={busyPackageId === `${pkg.extensionId}:${pkg.packageId}`}
                      onTrust={(trusted) =>
                        runLifecycle(
                          {
                            kind: "set-source-trust",
                            commandVersion: COMMAND_VERSION,
                            extensionId: pkg.extensionId,
                            expectedStateVersion: pkg.stateVersion,
                            trusted,
                          },
                          `${pkg.extensionId}:${pkg.packageId}`,
                        )
                      }
                      onPluginDesired={(desired) =>
                        runLifecycle(
                          {
                            kind: "set-plugin-desired",
                            commandVersion: COMMAND_VERSION,
                            extensionId: pkg.extensionId,
                            expectedStateVersion: pkg.stateVersion,
                            desired,
                          },
                          `${pkg.extensionId}:${pkg.packageId}`,
                        )
                      }
                      onComponentDesired={(componentId, desired) =>
                        runLifecycle(
                          {
                            kind: "set-component-desired",
                            commandVersion: COMMAND_VERSION,
                            extensionId: pkg.extensionId,
                            expectedStateVersion: pkg.stateVersion,
                            componentId,
                            desired,
                          },
                          `${pkg.extensionId}:${pkg.packageId}`,
                        )
                      }
                      onUninstall={() =>
                        runLifecycle(
                          {
                            kind: "uninstall-package",
                            extensionId: pkg.extensionId,
                            packageId: pkg.packageId,
                          },
                          `${pkg.extensionId}:${pkg.packageId}`,
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section aria-labelledby="standalone-skill-registry-heading" className="setgroup">
            <h3 className="setgroup-head" id="standalone-skill-registry-heading">
              Standalone skills
            </h3>
            <div className="extensions-settings__body">
              {standaloneSkills.length === 0 ? (
                <p className="extensions-settings__state" role="status">
                  No standalone skills were discovered.
                </p>
              ) : (
                <ul className="extensions-settings__cards">
                  {standaloneSkills.map((skill) => (
                    <StandaloneSkillCard key={String(skill.skill.qualifiedId)} skill={skill} />
                  ))}
                </ul>
              )}
            </div>
          </section>

          {snapshot.collisions.length > 0 ? (
            <section aria-labelledby="standalone-skill-collisions-heading" className="setgroup">
              <h3 className="setgroup-head" id="standalone-skill-collisions-heading">
                Name collisions
              </h3>
              <div className="extensions-settings__body">
                <ul className="extensions-settings__diagnostics">
                  {snapshot.collisions.map((collision) => (
                    <li
                      aria-label={`Skill name collision: ${collision.name}`}
                      key={`${collision.name}:${collision.candidates.join(":")}`}
                      role="status"
                    >
                      <strong>{collision.name}</strong> has {collision.candidates.length}{" "}
                      source-qualified candidates. Choose the exact source before use.
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}
        </OctantTabsPanel>

        <OctantTabsPanel value="marketplace">
          <section aria-labelledby="extension-catalog-heading" className="setgroup">
            <h3 className="setgroup-head" id="extension-catalog-heading">
              Extension catalog
            </h3>
            <div className="extensions-settings__body">
              <div className="extensions-settings__search">
                <OctantInput
                  aria-label="Search marketplace"
                  className="extensions-settings__search-input"
                  onChange={(event) => setMarketplaceQuery(event.currentTarget.value)}
                  placeholder="Search the extension catalog"
                  type="search"
                  value={marketplaceQuery}
                />
                <OctantButton
                  className="btn btn-secondary"
                  disabled={catalogOffline || marketplaceQuery.trim() === ""}
                  onClick={() => void runSearch()}
                  type="button"
                >
                  Run search
                </OctantButton>
              </div>
              {props.pickLocalPluginFolder !== undefined ? (
                <div className="extensions-settings__local-import">
                  <OctantButton
                    className="btn btn-secondary"
                    disabled={importingLocal || installing}
                    onClick={() => {
                      void (async () => {
                        setFailure(undefined);
                        try {
                          const selection = await props.pickLocalPluginFolder?.();
                          if (selection === undefined) return;
                          await importLocalPlugin(selection);
                        } catch (error) {
                          setFailure({
                            category: "unavailable",
                            message:
                              error instanceof Error
                                ? error.message
                                : "Local plugin folder picker failed.",
                          });
                        }
                      })();
                    }}
                    type="button"
                  >
                    Import local Agent Plugin…
                  </OctantButton>
                </div>
              ) : null}
              {catalogOffline ? (
                <p
                  className="extensions-settings__state"
                  role="status"
                  aria-label="Catalog unavailable"
                >
                  The extension catalog is unavailable. Connect a catalog source to search.
                </p>
              ) : null}
              {marketplaceStatus === "empty" ? (
                <p className="extensions-settings__state" role="status">
                  No catalog entries matched the search.
                </p>
              ) : null}
              {marketplaceStatus === "failed" ? (
                <p className="extensions-settings__state" role="status">
                  The catalog search failed. Retry or inspect the source directly.
                </p>
              ) : null}
              {marketplaceEntries.length > 0 ? (
                <ul className="extensions-settings__cards">
                  {marketplaceEntries.map((entry) => {
                    const entryKey = `${entry.extensionId}:${entry.packageId}`;
                    const isPreviewing =
                      preview !== undefined && sameEntryIdentity(preview.entry, entry);
                    return (
                      <li className="extcard" key={entryKey}>
                        <span aria-hidden="true" className="icon-mark">
                          <Puzzle aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
                        </span>
                        <span className="extcard-name">{entry.displayName}</span>
                        <span className="extcard-right">
                          <OctantButton
                            aria-label={`Inspect ${entry.displayName}`}
                            className="btn btn-secondary btn-sm"
                            disabled={inspectingEntryId === entryKey || installing}
                            onClick={() => void inspectEntry(entry)}
                            type="button"
                          >
                            Inspect
                          </OctantButton>
                        </span>
                        <span className="extcard-src">
                          {sourceLabel(entry.source)} · v<span>{entry.version}</span>
                        </span>
                        {isPreviewing && preview !== undefined ? (
                          <div
                            className="extensions-settings__preview"
                            aria-label="Package inspection preview"
                          >
                            <p className="extensions-settings__preview-heading">
                              Review before installing
                            </p>
                            {preview.review.description !== undefined ? (
                              <p className="extensions-settings__description">
                                {preview.review.description}
                              </p>
                            ) : null}
                            <dl className="extensions-settings__compatibility">
                              {preview.review.provenance.publisher !== undefined ? (
                                <div>
                                  <dt>Publisher</dt>
                                  <dd>{preview.review.provenance.publisher}</dd>
                                </div>
                              ) : null}
                              {preview.review.provenance.canonicalUrl !== undefined ? (
                                <div>
                                  <dt>Source</dt>
                                  <dd>{preview.review.provenance.canonicalUrl}</dd>
                                </div>
                              ) : null}
                              {preview.review.provenance.sourceCommit !== undefined ? (
                                <div>
                                  <dt>Upstream commit</dt>
                                  <dd>{preview.review.provenance.sourceCommit}</dd>
                                </div>
                              ) : null}
                              <div>
                                <dt>Source review</dt>
                                <dd>
                                  {preview.review.provenance.reviewed ? "Reviewed" : "Not reviewed"}
                                </dd>
                              </div>
                              <div>
                                <dt>License</dt>
                                <dd>{licenseLabel(preview.review.license)}</dd>
                              </div>
                              <div>
                                <dt>Digest</dt>
                                <dd>{preview.entry.digest}</dd>
                              </div>
                              <div>
                                <dt>Platforms</dt>
                                <dd>{preview.review.compatibility.platforms.join(", ")}</dd>
                              </div>
                              <div>
                                <dt>Modes</dt>
                                <dd>{preview.review.compatibility.modes.join(", ")}</dd>
                              </div>
                              <div>
                                <dt>Providers</dt>
                                <dd>
                                  {preview.review.compatibility.providerFamilies.length === 0
                                    ? "All providers"
                                    : preview.review.compatibility.providerFamilies.join(", ")}
                                </dd>
                              </div>
                              <div>
                                <dt>Capabilities</dt>
                                <dd>{preview.review.declaredCapabilities.join(", ")}</dd>
                              </div>
                            </dl>
                            <ul className="extensions-settings__components">
                              {preview.review.components.map((component) => (
                                <li className="extensions-settings__component" key={component.id}>
                                  <p className="extensions-settings__component-name">
                                    {component.displayName}
                                  </p>
                                  <p className="extensions-settings__effective">
                                    {component.kind}
                                    {component.declaredCapabilities.length === 0
                                      ? ""
                                      : ` — ${component.declaredCapabilities.join(", ")}`}
                                  </p>
                                  {component.instructions === undefined ? null : (
                                    <div className="extensions-settings__instruction-review">
                                      <p className="extensions-settings__preview-heading">
                                        Bundled skill instructions
                                      </p>
                                      <pre>{component.instructions}</pre>
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                            {preview.diagnostics.length > 0 ? (
                              <ul className="extensions-settings__diagnostics">
                                {preview.diagnostics.map((diagnostic) => (
                                  <li key={diagnostic.code}>{diagnostic.message}</li>
                                ))}
                              </ul>
                            ) : null}
                            <OctantButton
                              aria-label="Confirm install"
                              className="btn btn-primary"
                              disabled={installing}
                              onClick={() => void confirmInstall(preview.entry)}
                              type="button"
                            >
                              Confirm install
                            </OctantButton>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {localPreview !== undefined ? (
                <div className="extcard">
                  <span aria-hidden="true" className="icon-mark">
                    <Puzzle aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
                  </span>
                  <span className="extcard-name">{localPreview.entry.displayName}</span>
                  <span className="extcard-src">
                    {sourceLabel(localPreview.entry.source)} · v
                    <span>{localPreview.entry.version}</span>
                  </span>
                  <div
                    className="extensions-settings__preview"
                    aria-label="Package inspection preview"
                  >
                    <p className="extensions-settings__preview-heading">Review before installing</p>
                    {localPreview.review.description !== undefined ? (
                      <p className="extensions-settings__description">
                        {localPreview.review.description}
                      </p>
                    ) : null}
                    <dl className="extensions-settings__compatibility">
                      {localPreview.review.provenance.publisher !== undefined ? (
                        <div>
                          <dt>Publisher</dt>
                          <dd>{localPreview.review.provenance.publisher}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Source</dt>
                        <dd>{sourceLabel(localPreview.entry.source)}</dd>
                      </div>
                      <div>
                        <dt>License</dt>
                        <dd>{licenseLabel(localPreview.review.license)}</dd>
                      </div>
                      <div>
                        <dt>Digest</dt>
                        <dd>{localPreview.entry.digest}</dd>
                      </div>
                      <div>
                        <dt>Capabilities</dt>
                        <dd>{localPreview.review.declaredCapabilities.join(", ")}</dd>
                      </div>
                    </dl>
                    <ul className="extensions-settings__components">
                      {localPreview.review.components.map((component) => (
                        <li className="extensions-settings__component" key={component.id}>
                          <p className="extensions-settings__component-name">
                            {component.displayName}
                          </p>
                          <p className="extensions-settings__effective">
                            {component.kind}
                            {component.declaredCapabilities.length === 0
                              ? ""
                              : ` — ${component.declaredCapabilities.join(", ")}`}
                          </p>
                          {component.instructions === undefined ? null : (
                            <div className="extensions-settings__instruction-review">
                              <p className="extensions-settings__preview-heading">
                                Bundled skill instructions
                              </p>
                              <pre>{component.instructions}</pre>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {localPreview.diagnostics.length > 0 ? (
                      <ul className="extensions-settings__diagnostics">
                        {localPreview.diagnostics.map((diagnostic) => (
                          <li key={`${diagnostic.code}:${diagnostic.message}`}>
                            {diagnostic.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <OctantButton
                      aria-label="Confirm install"
                      className="btn btn-primary"
                      disabled={installing}
                      onClick={() => void confirmInstall(localPreview.entry)}
                      type="button"
                    >
                      Confirm install
                    </OctantButton>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section aria-labelledby="skill-marketplace-heading" className="setgroup">
            <h3 className="setgroup-head" id="skill-marketplace-heading">
              Standalone skills
            </h3>
            <div className="extensions-settings__body">
              <p className="extensions-settings__description">
                Search skills.sh and npm packages that ship SKILL.md, preview, then install.
                Installs start disabled — trust and enable them from Installed.
              </p>
              <div className="extensions-settings__search">
                <OctantInput
                  aria-label="Search skills.sh and npm"
                  className="extensions-settings__search-input"
                  onChange={(event) => setSkillQuery(event.currentTarget.value)}
                  placeholder="Search skills.sh and npm"
                  type="search"
                  value={skillQuery}
                />
                <OctantButton
                  className="btn btn-secondary"
                  disabled={skillQuery.trim() === "" || skillStatus === "searching"}
                  onClick={() => void runSkillSearch()}
                  type="button"
                >
                  Search skills
                </OctantButton>
              </div>
              {skillStatus === "empty" ? (
                <p className="extensions-settings__state" role="status">
                  No skills matched the search on skills.sh or npm.
                </p>
              ) : null}
              {skillStatus === "failed" ? (
                <p className="extensions-settings__state" role="status">
                  Skill search failed. Retry when the registry is available.
                </p>
              ) : null}
              {skillEntries.length > 0 ? (
                <ul className="extensions-settings__cards">
                  {skillEntries.map((entry) => {
                    const entryKey = String(entry.skill.qualifiedId);
                    const isPreviewing =
                      skillPreview !== undefined &&
                      sameEntrySource(skillPreview.entry.source, entry.source);
                    return (
                      <li className="extcard" key={entryKey}>
                        <span aria-hidden="true" className="icon-mark">
                          <BookOpen
                            aria-hidden="true"
                            className="icon"
                            size={16}
                            strokeWidth={1.5}
                          />
                        </span>
                        <span className="extcard-name">{entry.displayName}</span>
                        <span className="extcard-right">
                          <OctantButton
                            aria-label={`Preview ${entry.displayName}`}
                            className="btn btn-secondary btn-sm"
                            disabled={inspectingSkillId === entryKey || installingSkill}
                            onClick={() => void previewSkillEntry(entry)}
                            type="button"
                          >
                            Preview
                          </OctantButton>
                        </span>
                        <span className="extcard-src">
                          {sourceLabel(entry.source)} · v<span>{entry.version}</span>
                        </span>
                        {entry.description !== undefined ? (
                          <p className="extcard-desc">{entry.description}</p>
                        ) : null}
                        {isPreviewing && skillPreview !== undefined ? (
                          <div
                            className="extensions-settings__preview"
                            aria-label="Skill package preview"
                          >
                            <p className="extensions-settings__preview-heading">
                              Review before installing
                            </p>
                            {skillPreview.entry.description !== undefined ? (
                              <p className="extensions-settings__description">
                                {skillPreview.entry.description}
                              </p>
                            ) : null}
                            {skillPreview.instructions !== undefined ? (
                              <section
                                aria-label="Skill instructions"
                                className="extensions-settings__instruction-review"
                              >
                                <p className="extensions-settings__preview-heading">
                                  Skill instructions
                                </p>
                                <pre>{skillPreview.instructions}</pre>
                              </section>
                            ) : null}
                            <dl className="extensions-settings__compatibility">
                              {skillPreview.entry.provenance.publisher !== undefined ? (
                                <div>
                                  <dt>Publisher</dt>
                                  <dd>{skillPreview.entry.provenance.publisher}</dd>
                                </div>
                              ) : null}
                              {skillPreview.entry.provenance.canonicalUrl !== undefined ? (
                                <div>
                                  <dt>Source</dt>
                                  <dd>{skillPreview.entry.provenance.canonicalUrl}</dd>
                                </div>
                              ) : null}
                              <div>
                                <dt>Digest</dt>
                                <dd>{skillPreview.entry.skill.digest}</dd>
                              </div>
                              <div>
                                <dt>License</dt>
                                <dd>{licenseLabel(skillPreview.license)}</dd>
                              </div>
                            </dl>
                            <OctantButton
                              aria-label={
                                skillPreviewAction === "current"
                                  ? "Skill already installed"
                                  : skillPreviewAction === "update"
                                    ? "Confirm skill update"
                                    : "Confirm skill install"
                              }
                              className="btn btn-primary"
                              disabled={installingSkill || skillPreviewAction === "current"}
                              onClick={() => void confirmSkillInstall(skillPreview)}
                              type="button"
                            >
                              {skillPreviewAction === "current"
                                ? "Already installed"
                                : skillPreviewAction === "update"
                                  ? "Confirm update"
                                  : "Confirm install"}
                            </OctantButton>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          </section>
        </OctantTabsPanel>
      </OctantTabs>

      {failure !== undefined ? (
        <p className="extensions-settings__failure" role="status">
          <span>{failure.category}</span>
          <span>{failure.message}</span>
        </p>
      ) : null}
    </section>
  );
}

function StandaloneSkillCard(props: { readonly skill: StandaloneSkillRecord }) {
  const skill = props.skill;
  return (
    <li className="extcard">
      <span aria-hidden="true" className="icon-mark">
        <BookOpen aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
      </span>
      <span className="extcard-name">{skill.displayName}</span>
      <span className="extcard-right">
        <span className={skill.skill.available ? "badge" : "badge badge-warn"}>
          {skill.skill.available ? "Available" : "Unavailable"}
        </span>
      </span>
      <span className="extcard-src">{standaloneSkillSourceLabel(skill)}</span>
      <code className="extensions-settings__skill-id">{skill.skill.qualifiedId}</code>
      {skill.description === undefined ? null : <p className="extcard-desc">{skill.description}</p>}
      <dl className="extensions-settings__compatibility">
        <div>
          <dt>Review</dt>
          <dd>{skill.reviewed ? "Reviewed" : "Review required"}</dd>
        </div>
        <div>
          <dt>Desired</dt>
          <dd>{skill.desiredEnabled ? "Enabled" : "Disabled"}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd data-blocked={skill.effectiveState.kind === "blocked" ? "true" : "false"}>
            {effectiveLabel(skill.effectiveState)}
          </dd>
        </div>
        <div>
          <dt>Content</dt>
          <dd>{skill.contentBytes.toLocaleString()} bytes</dd>
        </div>
      </dl>
      {skill.skill.diagnostic === undefined ? null : (
        <p className="extensions-settings__failure" role="status">
          <span>{skill.skill.diagnostic.code}</span>
          <span>{skill.skill.diagnostic.message}</span>
        </p>
      )}
    </li>
  );
}

interface InstalledPackageCardProps {
  readonly packageState: ExtensionSnapshot["packages"][number];
  readonly busy: boolean;
  readonly onTrust: (trusted: boolean) => Promise<boolean>;
  readonly onPluginDesired: (desired: boolean) => Promise<boolean>;
  readonly onComponentDesired: (
    componentId: ExtensionSnapshot["packages"][number]["components"][number]["component"]["id"],
    desired: boolean,
  ) => Promise<boolean>;
  readonly onUninstall: () => Promise<boolean>;
}

function InstalledPackageCard(props: InstalledPackageCardProps) {
  const pkg = props.packageState;
  const pluginRuntimeBlocked = pkg.components.some(
    (component) =>
      component.effectiveState.kind === "blocked" &&
      ENABLE_BLOCKING_STATES.has(component.effectiveState.reason),
  );
  // Only block turning the plugin ON while runtime cleanup is unresolved.
  // When the plugin is already desired-on, the user must always be able to
  // disable/revoke it so the supervisor can drain and the package can recover.
  const pluginEnableDisabled =
    (pluginRuntimeBlocked && !pkg.activation.pluginDesired) || props.busy;

  return (
    <li className="extcard">
      <span aria-hidden="true" className="icon-mark">
        <Puzzle aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
      </span>
      <span className="extcard-name">{pkg.displayName ?? pkg.slug ?? pkg.extensionId}</span>
      <span className="extcard-right">
        <OctantButton
          aria-label={pkg.activation.trusted ? "Revoke trust" : "Trust source"}
          className="btn btn-secondary btn-sm"
          disabled={props.busy}
          onClick={() => void props.onTrust(!pkg.activation.trusted)}
          type="button"
        >
          {pkg.activation.trusted ? "Revoke trust" : "Trust source"}
        </OctantButton>
        {/* Disabling revokes what the plugin was granted, so the control is a
            button that names the action, not a preference switch. */}
        <OctantButton
          aria-label={pkg.activation.pluginDesired ? "Disable plugin" : "Enable plugin"}
          className="btn btn-secondary btn-sm"
          disabled={pluginEnableDisabled}
          onClick={() => void props.onPluginDesired(!pkg.activation.pluginDesired)}
          type="button"
        >
          {pkg.activation.pluginDesired ? "Disable plugin" : "Enable plugin"}
        </OctantButton>
        <OctantButton
          aria-label="Uninstall"
          className="btn btn-secondary btn-sm"
          disabled={props.busy}
          onClick={() => void props.onUninstall()}
          type="button"
        >
          Uninstall
        </OctantButton>
      </span>
      <span className="extcard-src">
        {sourceLabel(pkg.source)} · v<span>{pkg.version}</span>
      </span>
      <div className="extcard-scopes">
        {pkg.compatibility.platforms.map((platform) => (
          <span className="tag" key={`platform:${platform}`}>
            {platform}
          </span>
        ))}
        {pkg.compatibility.modes.map((mode) => (
          <span className="tag" key={`mode:${mode}`}>
            {mode}
          </span>
        ))}
        {pkg.compatibility.providerFamilies.map((family) => (
          <span className="tag" key={`provider:${family}`}>
            {family}
          </span>
        ))}
      </div>
      {pkg.components.length > 0 ? (
        <div className="extensions-settings__components">
          {pkg.components.map((componentState) => {
            const componentRuntimeBlocked =
              componentState.effectiveState.kind === "blocked" &&
              ENABLE_BLOCKING_STATES.has(componentState.effectiveState.reason);
            // Same direction rule as the plugin control: only block enabling,
            // never block disabling a desired-on component.
            const componentEnableDisabled =
              (componentRuntimeBlocked && !componentState.activation.componentDesired) ||
              props.busy;
            return (
              <div className="extensions-settings__component" key={componentState.component.id}>
                <p className="extensions-settings__component-name">
                  {componentState.component.displayName}
                </p>
                <p
                  className="extensions-settings__effective"
                  data-blocked={componentState.effectiveState.kind === "blocked" ? "true" : "false"}
                  role="status"
                  aria-label={effectiveLabel(componentState.effectiveState)}
                >
                  {effectiveLabel(componentState.effectiveState)}
                </p>
                <OctantButton
                  aria-label={
                    componentState.activation.componentDesired
                      ? "Disable component"
                      : "Enable component"
                  }
                  className="btn btn-secondary btn-sm"
                  disabled={componentEnableDisabled}
                  onClick={() =>
                    void props.onComponentDesired(
                      componentState.component.id,
                      !componentState.activation.componentDesired,
                    )
                  }
                  type="button"
                >
                  {componentState.activation.componentDesired
                    ? "Disable component"
                    : "Enable component"}
                </OctantButton>
              </div>
            );
          })}
        </div>
      ) : null}
      {pkg.diagnostics.length > 0 ? (
        <ul className="extensions-settings__diagnostics">
          {pkg.diagnostics.map((diagnostic) => (
            <li key={diagnostic.code}>{diagnostic.message}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
