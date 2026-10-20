import {
  CANVAS_EXPORT_LINK_PASSWORD_MAX_CHARS,
  CANVAS_EXPORT_LINK_PASSWORD_MIN_CHARS,
  type CanvasExportApprovalCard,
  type CanvasExportDecideRequest,
  type CanvasExportDecideResult,
  type CanvasExportDelivery,
  type CanvasExportImplementedFormat,
  type CanvasExportOfferList,
  type CanvasExportPrepareRequest,
  type CanvasExportPrepareResult,
  type CanvasExportTargetOffer,
  type CanvasExportTargetStatus,
} from "@octant/contracts/canvas-export";
import type {
  FolderCandidateId,
  FolderBrowseRequest,
  FolderBrowseResult,
} from "@octant/contracts/folder-browse";
import { useState } from "react";
import { FolderPicker } from "../projects/FolderPicker";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { CanvasExportFolderState } from "./useCanvasExportFolder";

export interface CanvasExportPanelProps {
  readonly offers: CanvasExportOfferList;
  readonly onPrepare: (request: CanvasExportPrepareRequest) => Promise<CanvasExportPrepareResult>;
  readonly onDecide: (request: CanvasExportDecideRequest) => Promise<CanvasExportDecideResult>;
  /** The folder this Canvas exports to. Absent on a host without that surface. */
  readonly folder?: CanvasExportFolderState;
  /** Called after a folder was chosen, so the offers are read again. */
  readonly onExportFolderChosen?: () => void;
  /** Preselects a destination, such as the public link an Update starts from. */
  readonly initialTargetId?: string;
}

const LINK_EXPIRY_DAYS: ReadonlyArray<number> = [1, 7, 30, 90, 365];
const NEVER_EXPIRES = "never";

const FORMAT_LABEL: Record<CanvasExportImplementedFormat, string> = {
  markdown: "Markdown",
  html: "HTML",
  "share-document": "Canvas page",
};

function expiryLabel(days: number): string {
  return days === 1 ? "1 day" : `${String(days)} days`;
}

function passwordFits(password: string): boolean {
  return (
    password.length >= CANVAS_EXPORT_LINK_PASSWORD_MIN_CHARS &&
    password.length <= CANVAS_EXPORT_LINK_PASSWORD_MAX_CHARS
  );
}

/** The fixed choices, plus the destination's own default when it is not one of them. */
function expiryDays(defaultDays: number): ReadonlyArray<number> {
  return LINK_EXPIRY_DAYS.includes(defaultDays)
    ? LINK_EXPIRY_DAYS
    : [...LINK_EXPIRY_DAYS, defaultDays].sort((a, b) => a - b);
}

const STATUS_LABEL: Record<CanvasExportTargetStatus, string> = {
  "not-connected": "Not connected",
  ready: "Ready",
  refused: "Refused",
};

/**
 * Asks the host to render a Canvas, then shows the payload and destination
 * before anything is sent. The host re-checks approval; this panel does not
 * call a destination itself.
 *
 * A destination that names the file it will write shows that path here, because
 * the person is approving a place: an existing file is only replaced once the
 * card naming it is approved.
 */
export function CanvasExportPanel(props: CanvasExportPanelProps) {
  const ready = props.offers.targets.filter((target) => target.status === "ready");
  const initialTarget = ready.find(
    (target) => String(target.targetId) === props.initialTargetId,
  )?.targetId;
  const [targetId, setTargetId] = useState(initialTarget ?? ready[0]?.targetId ?? "");
  const selected = props.offers.targets.find((target) => String(target.targetId) === targetId);
  const formats = selected?.formats ?? [];
  const [format, setFormat] = useState(formats[0] ?? "markdown");
  const [card, setCard] = useState<CanvasExportApprovalCard | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  // The audience the person chose for a remote export. Reset to the
  // destination's own default each time a card is prepared, so a previous
  // choice never silently carries over to a different export.
  const [visibility, setVisibility] = useState<"secret" | "public">("secret");
  // What the person chose for a link. Reset from the destination's terms each
  // time a card is prepared; "never" is only ever picked, never a default.
  const [linkExpiry, setLinkExpiry] = useState("");
  const [linkPassword, setLinkPassword] = useState("");

  const chosenFormat = formats.includes(format) ? format : formats[0];
  const folder = props.folder;
  // Narrowed once here: an optional property of an optional object loses its
  // narrowing inside a callback, which is where the picker is built.
  const folderView = folder?.view;
  const folderBrowse = folder?.browse;

  async function prepare() {
    if (selected === undefined || selected.status !== "ready" || chosenFormat === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await props.onPrepare({
        schemaVersion: 1,
        kind: "canvas-export-prepare",
        canvasId: props.offers.canvasId,
        versionId: props.offers.versionId,
        expectedSequence: props.offers.sequence,
        targetId: selected.targetId,
        format: chosenFormat,
      });
      if (result.kind === "approval") {
        setCard(result.card);
        setVisibility(result.card.destinationVisibility ?? "secret");
        setLinkExpiry(String(result.card.destinationLinkTerms?.defaultExpiryDays ?? ""));
        setLinkPassword("");
        return;
      }
      setMessage(result.message);
    } catch {
      setMessage("Export could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder(candidateId: FolderCandidateId) {
    if (folder === undefined) return;
    setPickingFolder(false);
    if (await folder.choose(candidateId)) props.onExportFolderChosen?.();
  }

  async function decide(decision: CanvasExportDecideRequest["decision"]) {
    if (card === undefined) return;
    const terms = card.destinationLinkTerms;
    const password = terms?.allowsPassword === true ? linkPassword : "";
    if (decision === "approved" && password !== "" && !passwordFits(password)) {
      setMessage(
        `A password needs at least ${String(CANVAS_EXPORT_LINK_PASSWORD_MIN_CHARS)} characters.`,
      );
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await props.onDecide({
        schemaVersion: 1,
        kind: "canvas-export-decision",
        canvasId: props.offers.canvasId,
        approvalId: card.approvalId,
        decision,
        // The choice is only sent when the card actually offered one; a
        // destination with no audience never sees an audience field.
        ...(card.destinationVisibility === undefined ? {} : { visibility }),
        ...(terms === undefined || decision !== "approved"
          ? {}
          : {
              link: {
                expiry:
                  linkExpiry === NEVER_EXPIRES
                    ? { kind: "never" as const }
                    : { kind: "days" as const, days: Number(linkExpiry) },
                ...(password === "" ? {} : { password }),
              },
            }),
      });
      setCard(undefined);
      setLinkPassword("");
      if (result.kind === "exported") {
        setMessage(receiptText(result.record.outcome));
        return;
      }
      if (result.kind === "unrecorded") {
        setMessage(`${receiptText(result.outcome)} ${result.message}`);
        return;
      }
      setMessage(result.message);
    } catch {
      setMessage("Export could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="canvas-export" data-testid="canvas-export-panel">
      <h2 className="canvas-export__title" id="canvas-export-title">
        Export
      </h2>
      <p className="canvas-export__description" id="canvas-export-description">
        Send a rendered copy to a destination. Nothing leaves until you approve the payload and the
        destination.
      </p>
      {folder === undefined || folderView === undefined ? null : (
        <div className="canvas-export__folder">
          <span className="canvas-export__folder-label">Folder</span>
          <span className="canvas-export__folder-path" data-testid="canvas-export-folder">
            {folderView.folder ?? "No folder chosen yet"}
          </span>
          <OctantButton
            disabled={folder.busy || folderBrowse === undefined}
            onClick={() => setPickingFolder(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Choose folder…
          </OctantButton>
        </div>
      )}
      {props.offers.targets.length === 0 ? (
        <p className="canvas-export__note" data-testid="canvas-export-empty">
          No export destination is installed yet.
        </p>
      ) : card === undefined ? (
        <form
          className="canvas-export__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void prepare();
          }}
        >
          <OctantSelectField
            aria-label="Destination"
            id="canvas-export-destination"
            onValueChange={setTargetId}
            options={props.offers.targets.map((target) => ({
              id: String(target.targetId),
              label: destinationLabel(target),
              disabled: target.status !== "ready",
              ...(target.message === undefined ? {} : { disabledReason: target.message }),
            }))}
            value={targetId}
          />
          <ul className="canvas-export__statuses">
            {props.offers.targets.map((target) => (
              <li key={String(target.targetId)}>
                <span>{target.label}</span>
                <span>{STATUS_LABEL[target.status]}</span>
                {target.message === undefined ? null : <span>{target.message}</span>}
              </li>
            ))}
          </ul>
          <OctantSelectField
            aria-label="Format"
            id="canvas-export-format"
            onValueChange={(value) => {
              if (value === "markdown" || value === "html" || value === "share-document")
                setFormat(value);
            }}
            options={(formats.length === 0 ? (["markdown", "html"] as const) : formats).map(
              (item) => ({ id: item, label: FORMAT_LABEL[item] }),
            )}
            value={chosenFormat ?? "markdown"}
          />
          <OctantButton
            disabled={busy || selected?.status !== "ready" || chosenFormat === undefined}
            type="submit"
            variant="secondary"
          >
            {busy ? "Preparing…" : "Review export"}
          </OctantButton>
        </form>
      ) : (
        <OctantApprovalCard
          actions={
            <>
              <OctantButton
                disabled={busy}
                onClick={() => void decide("denied")}
                type="button"
                variant="ghost"
              >
                Don't export
              </OctantButton>
              <OctantButton
                disabled={busy}
                onClick={() => void decide("approved")}
                type="button"
                variant="secondary"
              >
                {busy ? "Exporting…" : "Approve export"}
              </OctantButton>
            </>
          }
          detail={FORMAT_LABEL[card.format]}
          label="Approve export"
          summary={`Export to ${card.destinationLabel}`}
        >
          {card.destinationPath === undefined ? null : (
            <p className="canvas-export__destination" data-testid="canvas-export-destination">
              {card.replacesExisting === true
                ? `Replaces ${card.destinationPath}`
                : `Writes ${card.destinationPath}`}
            </p>
          )}
          {card.writesDesignMarkup === true ? (
            <p className="canvas-export__note" data-testid="canvas-export-design-markup">
              This Canvas's design markup leaves as written. Octant does not check markup for
              secrets.
            </p>
          ) : null}
          {card.destinationAccount === undefined ? null : (
            <p className="canvas-export__account" data-testid="canvas-export-account">
              {`Posts as ${card.destinationAccount}`}
            </p>
          )}
          {card.destinationVisibility === undefined ? null : (
            <OctantSelectField
              aria-label="Who can see this export"
              id="canvas-export-visibility"
              onValueChange={(value) => {
                if (value === "secret" || value === "public") setVisibility(value);
              }}
              options={[
                { id: "secret", label: "Secret — anyone with the link" },
                { id: "public", label: "Public — visible to anyone" },
              ]}
              value={visibility}
            />
          )}
          {card.destinationLinkTerms === undefined ? null : (
            <div className="canvas-export__link" data-testid="canvas-export-link-terms">
              <p className="canvas-export__note">The link opens for anyone who has it.</p>
              {card.destinationLinkTerms.updatesLink === undefined ? null : (
                <p className="canvas-export__note" data-testid="canvas-export-updates-link">
                  {`Updates ${card.destinationLinkTerms.updatesLink}`}
                </p>
              )}
              <label className="canvas-export__field">
                <span>Link expires</span>
                <OctantSelectField
                  aria-label="Link expires"
                  id="canvas-export-link-expiry"
                  onValueChange={setLinkExpiry}
                  options={[
                    ...expiryDays(card.destinationLinkTerms.defaultExpiryDays).map((days) => ({
                      id: String(days),
                      label: expiryLabel(days),
                    })),
                    { id: NEVER_EXPIRES, label: "Never expires" },
                  ]}
                  value={linkExpiry}
                />
              </label>
              {card.destinationLinkTerms.allowsPassword ? (
                <label className="canvas-export__field">
                  <span>Password (optional)</span>
                  <OctantInput
                    autoComplete="new-password"
                    data-testid="canvas-export-link-password"
                    maxLength={CANVAS_EXPORT_LINK_PASSWORD_MAX_CHARS}
                    minLength={CANVAS_EXPORT_LINK_PASSWORD_MIN_CHARS}
                    onChange={(event) => setLinkPassword(event.target.value)}
                    type="password"
                    value={linkPassword}
                  />
                  <span className="canvas-export__note">
                    {card.destinationLinkTerms.hasPassword === true
                      ? "This link has a password. An update keeps it unless you enter a new one."
                      : `At least ${String(CANVAS_EXPORT_LINK_PASSWORD_MIN_CHARS)} characters.`}
                  </span>
                </label>
              ) : null}
            </div>
          )}
          {card.destinationNote === undefined ? null : (
            <p className="canvas-export__note" data-testid="canvas-export-note">
              {card.destinationNote}
            </p>
          )}
          <pre className="canvas-export__payload" data-testid="canvas-export-payload">
            {card.payload}
          </pre>
        </OctantApprovalCard>
      )}
      {message === undefined ? null : (
        <p className="canvas-export__note" role="status">
          {message}
        </p>
      )}
      {folder?.message === undefined ? null : (
        <p className="canvas-export__note" role="status">
          {folder.message}
        </p>
      )}
      {pickingFolder && folderView !== undefined && folderBrowse !== undefined ? (
        <FolderPicker
          client={{ browse: (request) => browseRequest(folderBrowse, request) }}
          hint="Pick the folder Octant writes exported files into."
          hostId={folderView.hostId}
          mode={folderView.mode}
          onCancel={() => setPickingFolder(false)}
          onSelectCandidate={(candidate) => void chooseFolder(candidate.candidateId)}
          showGitInit={false}
          title="Export folder"
        />
      ) : null}
    </div>
  );
}

/**
 * The picker names the host and mode it browses with; this client already
 * knows both from the host, so it takes only the part of the request that
 * describes where in the tree the person is.
 */
function browseRequest(
  browse: NonNullable<CanvasExportFolderState["browse"]>,
  request: FolderBrowseRequest,
): Promise<FolderBrowseResult> {
  return browse({
    ...(request.parentCandidateId === undefined
      ? {}
      : { parentCandidateId: request.parentCandidateId }),
    ...(request.search === undefined ? {} : { search: request.search }),
  });
}

function destinationLabel(target: CanvasExportTargetOffer): string {
  return `${target.label} — ${STATUS_LABEL[target.status]}`;
}

function receiptText(outcome: CanvasExportDelivery): string {
  if (outcome.kind === "refused") return outcome.message;
  const receipt = outcome.receipt;
  if (receipt.kind === "link") return `Exported. ${receipt.href}`;
  if (receipt.kind === "path") return `Exported. ${receipt.path}`;
  return `Exported. ${receipt.remoteId}`;
}
