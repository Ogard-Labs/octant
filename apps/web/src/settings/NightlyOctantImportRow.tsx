import type {
  NightlyOctantImportOutcome,
  NightlyOctantImportPreview,
} from "@octant/contracts/app-updates";
import { useEffect, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { SettingRow } from "./primitives";

const REFUSAL_MESSAGES: Readonly<
  Record<Extract<NightlyOctantImportOutcome, { kind: "refused" }>["reason"], string>
> = {
  "octant-missing": "Octant's data was not found, so nothing was imported.",
  "octant-newer":
    "Octant's data is newer than this Octant Nightly. Update Octant Nightly, then import again.",
  busy: "Octant's data is changing, or another import is running. Try again in a moment.",
  "unsafe-folder":
    "Nothing was imported: Octant Nightly's data folder is not separate from Octant's.",
  "unreadable-event":
    "Octant's history holds records this Octant Nightly cannot read. Nothing was changed.",
  "not-test-host": "Octant Nightly imports only while it runs on its own data.",
};

const FAILURE_MESSAGES: Readonly<
  Record<Extract<NightlyOctantImportOutcome, { kind: "failed" }>["stage"], string>
> = {
  snapshot: "Octant Nightly could not read Octant's data. Nothing was changed.",
  "migrate-snapshot": "Octant Nightly could not read Octant's data. Nothing was changed.",
  settle: "Octant Nightly could not settle Octant's running work. Nothing was changed.",
  "open-nightly": "Octant Nightly could not open its own data. Nothing was changed.",
  backup: "Octant Nightly could not back up its own data first. Nothing was changed.",
  merge: "Octant Nightly could not combine the two histories. Nothing was changed.",
  rebuild:
    "Octant Nightly could not rebuild its data from the combined history. Nothing was changed.",
  verify: "Octant Nightly could not verify the combined data. Nothing was changed.",
  swap: "Octant Nightly could not put the combined data in place. Nothing was changed.",
  "stop-host": "Octant Nightly's host would not stop, so nothing was imported.",
  maintenance: "The import did not finish. Nothing was changed.",
  report:
    "The import finished, but Octant Nightly could not read its report. Reload Octant Nightly to see what came over.",
  "start-host":
    "The import finished, but Octant Nightly's host did not start again. Relaunch Octant Nightly.",
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** The plain-words lines of a finished import. */
export function importSummaryLines(
  outcome: Extract<NightlyOctantImportOutcome, { kind: "imported" }>,
): ReadonlyArray<string> {
  const lines = [`Imported ${plural(outcome.counts.threads, "thread", "threads")} from Octant.`];
  if (outcome.counts.settled > 0)
    lines.push(
      `${plural(outcome.counts.settled, "item that was running", "items that were running")} in Octant arrived paused or settled.`,
    );
  if (outcome.conflicts > 0)
    lines.push(
      `${plural(outcome.conflicts, "thread", "threads")} changed in both apps; Octant Nightly kept its own.`,
    );
  if (outcome.heldBack > 0)
    lines.push(
      `${plural(outcome.heldBack, "setting or Project", "settings or Projects")} changed in both apps; Octant Nightly kept its own.`,
    );
  const keys = outcome.keys;
  if (keys.status === "copied")
    lines.push(
      `Keys: ${keys.copied} copied, ${keys.existing} already in Octant Nightly, ${keys.failed} could not be copied.`,
    );
  else if (keys.status === "unavailable")
    lines.push(
      keys.reason === "cannot-list"
        ? "Keys were not copied: Octant Nightly could not list them."
        : "Keys were not copied: this system is not supported.",
    );
  const preferences = outcome.preferences;
  if (preferences.status === "copied")
    lines.push(`Window preferences: ${preferences.copied} copied.`);
  else
    lines.push(
      preferences.reason === "origin-differs"
        ? "Window preferences were not copied: this build loads from a development server."
        : preferences.reason === "octant-storage-missing"
          ? "Window preferences were not copied: Octant has none saved."
          : preferences.reason === "relaunch-needed"
            ? "Window preferences were not copied: relaunch Octant Nightly, then import again to bring them over."
            : "Window preferences could not be copied.",
    );
  return lines;
}

/**
 * "Import from Octant" in Nightly's Settings. Shown only while Nightly runs on
 * its own data and Octant's data exists. The renderer only asks: the folders
 * come from Nightly's main process, and the one thing a request carries is
 * whether to copy saved keys.
 */
export function NightlyOctantImportRow(props: { readonly bridge: OctantHostBridge | undefined }) {
  const preview = props.bridge?.previewNightlyOctantImport;
  const run = props.bridge?.importNightlyOctantData;
  const [state, setState] = useState<NightlyOctantImportPreview>();
  const [confirming, setConfirming] = useState(false);
  const [copyKeys, setCopyKeys] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<NightlyOctantImportOutcome>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (preview === undefined) return;
    let active = true;
    void preview().then(
      (next) => {
        if (active) setState(next);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [preview]);

  if (preview === undefined || run === undefined || state === undefined) return null;
  if (!state.octantDataPresent && outcome === undefined) return null;

  async function start(): Promise<void> {
    if (run === undefined || preview === undefined) return;
    setImporting(true);
    setFailure(undefined);
    try {
      setOutcome(await run(copyKeys));
      setState(await preview().catch(() => state));
    } catch {
      setFailure("Octant Nightly could not run the import.");
    } finally {
      setImporting(false);
      setConfirming(false);
      setCopyKeys(false);
    }
  }

  const lastImported =
    state?.lastImportedAt === undefined
      ? "not imported yet"
      : `last imported ${new Date(state.lastImportedAt).toLocaleString()}`;
  return (
    <>
      <SettingRow
        description={`Brings Octant's threads, Projects and settings into Nightly's own data; ${lastImported}.`}
        more="Octant's data is only read. A later import brings over what Octant added since and keeps what you changed here."
        label="Import from Octant"
        scope="app"
        settingId="app-nightly-octant-import"
      >
        <OctantButton
          disabled={importing}
          onClick={() => setConfirming(true)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Import from Octant
        </OctantButton>
      </SettingRow>
      {confirming ? (
        <OctantConfirmDialog
          confirmLabel={importing ? "Importing…" : "Import"}
          details={
            <>
              <label>
                <OctantCheckbox
                  checked={copyKeys}
                  disabled={importing}
                  onChange={(event) => setCopyKeys(event.currentTarget.checked)}
                />{" "}
                Copy keys
              </label>
              <p className="app-update__offer-notes">
                Copies the saved provider and tool keys under Octant Nightly's own names. macOS may
                ask once for each key.
              </p>
              {importing ? (
                <p className="app-update__offer-notes" role="status">
                  Importing. Octant Nightly's host restarts when this finishes.
                </p>
              ) : null}
            </>
          }
          onCancel={() => setConfirming(false)}
          onConfirm={() => void start()}
          pending={importing}
          title="Import from Octant?"
        >
          Octant Nightly copies Octant's threads, Projects, instructions and settings, and window
          preferences such as shortcuts and favorite models, into its own data. Octant's data is
          only read. A first import replaces Octant Nightly's settings with Octant's; a later import
          keeps what you changed here. Work still running in Octant arrives paused.
        </OctantConfirmDialog>
      ) : null}
      {failure === undefined ? null : <OctantAlert tone="danger">{failure}</OctantAlert>}
      {outcome === undefined ? null : outcome.kind === "imported" ? (
        <OctantAlert tone="neutral">
          {importSummaryLines(outcome).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <OctantButton
            onClick={() => window.location.reload()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Reload to apply
          </OctantButton>
        </OctantAlert>
      ) : (
        <OctantAlert tone="danger">
          {outcome.kind === "refused"
            ? REFUSAL_MESSAGES[outcome.reason]
            : FAILURE_MESSAGES[outcome.stage]}
        </OctantAlert>
      )}
    </>
  );
}
