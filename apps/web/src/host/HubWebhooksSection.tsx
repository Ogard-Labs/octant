import { WebhookSignatureScheme } from "@octant/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  copyToClipboard,
  field,
  formatWhen,
  list,
  useHubEntranceAction,
  type HubRequest,
} from "./hubEntranceAction";
import "../styles/hub-entrance.css";

/**
 * Settings › Remote access › Webhook endpoints: this computer's endpoints for
 * its routines, made, rotated and removed through the loopback hub
 * administration. The host mints each secret and the window shows it once;
 * it is never read back. Stripe mints its own, so a Stripe endpoint shows
 * its URL and takes the secret Stripe shows, pasted in and never echoed.
 * Loaded as its own chunk (hub-and-spokes.md, Webhook triggers).
 */

interface Endpoint {
  readonly endpointId: string;
  readonly scheme: string;
  readonly label: string;
  readonly path: string;
  readonly deliveries: number;
  /** A Stripe endpoint whose person has not pasted Stripe's secret yet. */
  readonly awaitingSecret: boolean;
}

interface LogEntry {
  readonly at: number;
  readonly endpointId: string;
  readonly outcome: string;
}

export interface WebhooksView {
  readonly endpoints: ReadonlyArray<Endpoint>;
  readonly log: ReadonlyArray<LogEntry>;
  readonly published: boolean;
  /** What the hub holds, on the hub only. */
  readonly hub?: {
    readonly endpoints: number;
    readonly queued: number;
    readonly forwarded: number;
    readonly refused: number;
    readonly expired: number;
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readWebhooks(value: unknown): WebhooksView | undefined {
  const spoke = field(value, "spoke");
  const endpoints = field(spoke, "endpoints");
  if (!Array.isArray(endpoints)) return undefined;
  const hub = field(value, "hub");
  return {
    endpoints: endpoints.flatMap((entry: unknown) => {
      const endpointId = field(entry, "endpointId");
      const scheme = field(entry, "scheme");
      const label = field(entry, "label");
      const path = field(entry, "path");
      return typeof endpointId === "string" &&
        typeof scheme === "string" &&
        typeof label === "string" &&
        typeof path === "string"
        ? [
            {
              endpointId,
              scheme,
              label,
              path,
              deliveries: count(field(entry, "deliveries")),
              awaitingSecret: field(entry, "awaitingSecret") === true,
            },
          ]
        : [];
    }),
    log: list(field(spoke, "log")).flatMap((entry) => {
      const at = field(entry, "at");
      const endpointId = field(entry, "endpointId");
      const outcome = field(entry, "outcome");
      return typeof at === "number" && typeof endpointId === "string" && typeof outcome === "string"
        ? [{ at, endpointId, outcome }]
        : [];
    }),
    published: field(spoke, "published") !== false,
    ...(hub === undefined
      ? {}
      : {
          hub: {
            endpoints: count(field(hub, "endpoints")),
            queued: count(field(hub, "queued")),
            forwarded: count(field(hub, "forwarded")),
            refused: count(field(hub, "refused")),
            expired: count(field(hub, "expired")),
          },
        }),
  };
}

// Names for the schemes Octant knows by brand; any other scheme the contract
// offers reads as its own words, so a new one appears without a change here.
const SCHEME_NAMES: Readonly<Record<string, string>> = {
  "standard-webhooks": "Standard Webhooks",
  github: "GitHub",
};

export function schemeName(scheme: string): string {
  return (
    SCHEME_NAMES[scheme] ??
    scheme
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

const OUTCOME_COPY: Readonly<Record<string, string>> = {
  accepted: "Accepted",
  duplicate: "Already taken; nothing ran again",
  "bad-signature": "Refused: the signature did not match",
  "missing-signature": "Refused: no signature",
  "stale-timestamp": "Refused: too old",
  "unknown-endpoint": "Refused: no such endpoint",
  "public-not-granted": "Refused: Public is not ticked",
  busy: "Held on the hub: the automation has not caught up",
  paused: "Held on the hub: remote access is paused",
};

const REFUSALS: Readonly<Record<string, string>> = {
  "public-not-granted": "Tick Public in this computer's hub grant first.",
  "unknown-endpoint": "That endpoint is gone. The list is up to date now.",
  full: "This computer already has 64 endpoints. Remove one first.",
  "invalid-secret": "That is not a Stripe signing secret. It starts with whsec_.",
  "scheme-mints-its-own":
    "That endpoint uses the secret Octant made; only a Stripe endpoint takes one pasted in.",
  "too-many-replaced-secrets":
    "This endpoint still keeps two replaced secrets for deliveries the hub may hold, and another would drop one early. Paste again two days after the oldest was replaced. Rotating the endpoint instead retires its URL, drops the deliveries it has not run yet, and needs the new URL given to Stripe and the secret Stripe then shows pasted here.",
};

interface Minted {
  readonly endpointId: string;
  readonly label: string;
  readonly path: string;
  readonly secret: string;
  readonly published: boolean;
}

/** The Stripe endpoint whose secret the person is pasting. */
interface Pasting {
  readonly endpointId: string;
  readonly label: string;
  readonly path: string;
  /** Whether Stripe's first secret is awaited, rather than a rolled one. */
  readonly first: boolean;
}

export default function HubWebhooksSection(props: {
  readonly request: HubRequest;
  /** The status body's `webhooks` part, read here so the parsing loads with this chunk. */
  readonly body: unknown;
  /** Whether this computer is a member of a hub; the hub alone has only its counts to show. */
  readonly member: boolean;
  /** Whether this computer's person ticked Public in its hub grant. */
  readonly publicGranted: boolean;
  readonly onChanged: () => Promise<void>;
  readonly now?: () => number;
}) {
  const view = readWebhooks(props.body);
  const action = useHubEntranceAction(props.request);
  const schemes = WebhookSignatureScheme.literals;
  const [label, setLabel] = useState("");
  const [scheme, setScheme] = useState<string>(schemes[0]);
  const [minted, setMinted] = useState<Minted>();
  const [pasting, setPasting] = useState<Pasting>();
  /** What the person is pasting; emptied the moment it is sent, saved or not. */
  const [secretDraft, setSecretDraft] = useState("");
  const [confirming, setConfirming] = useState<{
    readonly kind: "rotate" | "remove";
    readonly endpoint: Endpoint;
  }>();
  const opener = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const schemeId = useId();
  const secretId = useId();
  const keepId = useId();
  // The host never reads a minted secret back, so until the person presses
  // Done nothing that would put another in its place is offered.
  const keeping = minted !== undefined;
  const nameInput = useRef<HTMLInputElement>(null);
  const formHint = useRef<HTMLParagraphElement>(null);
  const mintedPanel = useRef<HTMLDivElement>(null);
  const pastePanel = useRef<HTMLDivElement>(null);
  const now = (props.now ?? Date.now)();

  // What the host shows once, and the paste step, take focus as they appear
  // so a keyboard or screen reader user lands on them, not past them.
  useEffect(() => {
    if (minted !== undefined) mintedPanel.current?.focus();
  }, [minted]);
  const pastingId = pasting?.endpointId;
  useEffect(() => {
    if (pastingId !== undefined) pastePanel.current?.focus();
  }, [pastingId]);

  const show = (body: unknown, name: string) => {
    const endpointId = field(body, "endpointId");
    const path = field(body, "path");
    const secret = field(body, "secret");
    if (typeof endpointId !== "string" || typeof path !== "string") return;
    if (typeof secret === "string") {
      setPasting(undefined);
      setMinted({
        endpointId,
        label: name,
        path,
        secret,
        published: field(body, "published") === true,
      });
    } else if (field(body, "status") === "awaiting-secret") {
      setMinted(undefined);
      setSecretDraft("");
      setPasting({ endpointId, label: name, path, first: true });
    }
  };

  /** Forgets anything shown for an endpoint that no longer exists. */
  const forget = (endpointId: string) => {
    setMinted((current) => (current?.endpointId === endpointId ? undefined : current));
    setPasting((current) => (current?.endpointId === endpointId ? undefined : current));
  };

  const create = async () => {
    const name = label.trim();
    const body = await action.run(
      "webhook-create",
      { scheme, label: name },
      ["created", "awaiting-secret"],
      "Octant could not make the endpoint.",
      REFUSALS,
    );
    if (body !== undefined) {
      setLabel("");
      show(body, name);
    }
    await props.onChanged();
  };

  const decide = async () => {
    const chosen = confirming;
    setConfirming(undefined);
    if (chosen === undefined) return;
    if (chosen.kind === "rotate") {
      const body = await action.run(
        "webhook-rotate",
        { endpointId: chosen.endpoint.endpointId },
        ["created", "awaiting-secret"],
        "Octant could not rotate the endpoint.",
        REFUSALS,
      );
      if (body !== undefined) {
        forget(chosen.endpoint.endpointId);
        show(body, chosen.endpoint.label);
      }
    } else {
      const body = await action.run(
        "webhook-remove",
        { endpointId: chosen.endpoint.endpointId },
        "removed",
        "Octant could not remove the endpoint.",
        REFUSALS,
      );
      if (body !== undefined) {
        forget(chosen.endpoint.endpointId);
        action.say({
          kind: "success",
          text: `Removed ${chosen.endpoint.label}. Its URL answers nothing now.`,
        });
      }
      await props.onChanged();
      // The removed row took its buttons with it; land on the form instead.
      if (body !== undefined) (nameInput.current ?? formHint.current)?.focus();
      return;
    }
    await props.onChanged();
  };

  const saveSecret = async () => {
    const target = pasting;
    const secret = secretDraft;
    setSecretDraft("");
    if (target === undefined || secret.trim() === "") return;
    const body = await action.run(
      "webhook-secret",
      { endpointId: target.endpointId, secret },
      "set",
      "Octant could not save the secret.",
      REFUSALS,
    );
    if (body !== undefined) {
      setPasting(undefined);
      action.say({
        kind: "success",
        text: `Saved the secret for ${target.label}. Stripe's deliveries are checked with it now.${
          field(body, "published") === true
            ? ""
            : " The hub has not taken it yet; this computer tries again shortly."
        }`,
      });
    }
    await props.onChanged();
  };

  const copy = async (text: string, what: string) => {
    action.say(
      (await copyToClipboard(text))
        ? { kind: "success", text: `${what} copied.` }
        : {
            kind: "error",
            text: `The ${what.toLowerCase()} could not be copied. Select it instead.`,
          },
    );
  };

  if (view === undefined) return null;

  const labelOf = (endpointId: string) =>
    view.endpoints.find((endpoint) => endpoint.endpointId === endpointId)?.label ??
    "A removed endpoint";

  return (
    <SettingsSection
      description="Let a service start one of this computer's automations by sending a signed request to the hub."
      title="Webhook endpoints"
    >
      {!props.member ? null : (
        <>
          <div className="settings-panel__stack">
            <p className="setrow-hint" ref={formHint} tabIndex={-1}>
              {props.publicGranted
                ? "Name it and pick how the sender signs. A delivery is event data for its automation and never changes what the automation may do."
                : "Tick Public in this computer's hub grant to make one."}
            </p>
            <OctantField>
              <OctantFieldLabel htmlFor={labelId}>Name</OctantFieldLabel>
              <OctantInput
                autoComplete="off"
                disabled={!props.publicGranted}
                id={labelId}
                maxLength={128}
                ref={props.publicGranted ? nameInput : undefined}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Deploys from GitHub"
                value={label}
              />
            </OctantField>
            <OctantField>
              <OctantFieldLabel htmlFor={schemeId}>Signing</OctantFieldLabel>
              <OctantSelectField
                disabled={!props.publicGranted}
                id={schemeId}
                onValueChange={setScheme}
                options={schemes.map((entry) => ({ id: entry, label: schemeName(entry) }))}
                value={scheme}
              />
            </OctantField>
            <div className="host-settings__controls">
              <OctantButton
                aria-describedby={keeping ? keepId : undefined}
                disabled={action.busy || keeping || !props.publicGranted || label.trim() === ""}
                onClick={() => void create()}
              >
                Make endpoint
              </OctantButton>
            </div>
          </div>

          {minted === undefined ? null : (
            <div
              aria-label="New endpoint secret"
              className="settings-panel__stack"
              ref={mintedPanel}
              role="group"
              tabIndex={-1}
            >
              <p className="setrow-hint">
                {`${minted.label}: give the sender the full URL and this secret now. Octant does not show the secret again.`}
              </p>
              <div className="setrow">
                <span className="setrow-label">Path on your hub's public address</span>
                <code className="setrow-hint hub-entrance__secret">{minted.path}</code>
                <div className="setrow-control">
                  <OctantButton
                    onClick={() => void copy(minted.path, "Path")}
                    size="sm"
                    variant="secondary"
                  >
                    Copy path
                  </OctantButton>
                </div>
              </div>
              <div className="setrow">
                <span className="setrow-label">Secret</span>
                <code className="setrow-hint hub-entrance__secret">{minted.secret}</code>
                <div className="setrow-control">
                  <OctantButton
                    onClick={() => void copy(minted.secret, "Secret")}
                    size="sm"
                    variant="secondary"
                  >
                    Copy secret
                  </OctantButton>
                </div>
              </div>
              {minted.published ? null : (
                <p className="setrow-hint">
                  The hub has not taken the endpoint yet; this computer tries again shortly.
                </p>
              )}
              <p className="setrow-hint" id={keepId}>
                Keep the secret, then press Done. Until then you cannot make an endpoint or change
                another one's secret.
              </p>
              <div className="host-settings__controls">
                <OctantButton onClick={() => setMinted(undefined)} variant="secondary">
                  Done
                </OctantButton>
              </div>
            </div>
          )}

          {pasting === undefined ? null : (
            <div
              aria-label="Stripe signing secret"
              className="settings-panel__stack"
              ref={pastePanel}
              role="group"
              tabIndex={-1}
            >
              <p className="setrow-hint">
                {pasting.first
                  ? `${pasting.label}: in Stripe, add an endpoint with the full URL, then paste the signing secret Stripe shows. It starts with whsec_.`
                  : `${pasting.label}: after you roll the secret in Stripe, paste the new one here. Octant keeps taking the old one for 24 hours.`}
              </p>
              <div className="setrow">
                <span className="setrow-label">Path on your hub's public address</span>
                <code className="setrow-hint hub-entrance__secret">{pasting.path}</code>
                <div className="setrow-control">
                  <OctantButton
                    onClick={() => void copy(pasting.path, "Path")}
                    size="sm"
                    variant="secondary"
                  >
                    Copy path
                  </OctantButton>
                </div>
              </div>
              <form
                className="settings-panel__stack"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSecret();
                }}
              >
                <OctantField>
                  <OctantFieldLabel htmlFor={secretId}>Signing secret from Stripe</OctantFieldLabel>
                  <OctantInput
                    autoComplete="off"
                    id={secretId}
                    maxLength={256}
                    onChange={(event) => setSecretDraft(event.target.value)}
                    placeholder="whsec_…"
                    spellCheck={false}
                    type="password"
                    value={secretDraft}
                  />
                </OctantField>
                <div className="host-settings__controls">
                  <OctantButton disabled={action.busy || secretDraft.trim() === ""} type="submit">
                    Save secret
                  </OctantButton>
                  <OctantButton
                    onClick={() => {
                      setSecretDraft("");
                      setPasting(undefined);
                    }}
                    type="button"
                    variant="secondary"
                  >
                    {pasting.first ? "Later" : "Cancel"}
                  </OctantButton>
                </div>
              </form>
            </div>
          )}

          {action.notice === undefined ? null : (
            <SettingsState kind={action.notice.kind}>{action.notice.text}</SettingsState>
          )}

          {view.endpoints.length === 0 ? (
            <SettingsState kind="empty">This computer has no webhook endpoints.</SettingsState>
          ) : (
            <ul aria-label="Webhook endpoints" className="setgroup">
              {view.endpoints.map((endpoint) => (
                <li className="setrow" key={endpoint.endpointId}>
                  <span className="setrow-label">{endpoint.label}</span>
                  <p className="setrow-hint">
                    {`${schemeName(endpoint.scheme)} · ${endpoint.path}${
                      endpoint.awaitingSecret ? " · waiting for the secret from Stripe" : ""
                    }${
                      endpoint.deliveries === 0
                        ? ""
                        : ` · ${endpoint.deliveries} waiting for the automation`
                    }`}
                  </p>
                  <div className="setrow-control">
                    {endpoint.scheme !== "stripe" ? null : (
                      <OctantButton
                        aria-label={`${endpoint.awaitingSecret ? "Paste secret" : "Paste new secret"} for ${endpoint.label}`}
                        aria-describedby={keeping ? keepId : undefined}
                        disabled={action.busy || keeping || !props.publicGranted}
                        onClick={() => {
                          setSecretDraft("");
                          setPasting({
                            endpointId: endpoint.endpointId,
                            label: endpoint.label,
                            path: endpoint.path,
                            first: endpoint.awaitingSecret,
                          });
                        }}
                        size="sm"
                        variant={endpoint.awaitingSecret ? "default" : "secondary"}
                      >
                        {endpoint.awaitingSecret ? "Paste secret" : "New secret"}
                      </OctantButton>
                    )}
                    <OctantButton
                      aria-label={`Rotate ${endpoint.label}`}
                      aria-describedby={
                        keeping && minted.endpointId !== endpoint.endpointId ? keepId : undefined
                      }
                      disabled={
                        action.busy || (keeping && minted.endpointId !== endpoint.endpointId)
                      }
                      onClick={() => setConfirming({ kind: "rotate", endpoint })}
                      ref={
                        confirming?.endpoint.endpointId === endpoint.endpointId &&
                        confirming.kind === "rotate"
                          ? opener
                          : undefined
                      }
                      size="sm"
                      variant="secondary"
                    >
                      Rotate…
                    </OctantButton>
                    <OctantButton
                      aria-label={`Remove ${endpoint.label}`}
                      disabled={action.busy}
                      onClick={() => setConfirming({ kind: "remove", endpoint })}
                      ref={
                        confirming?.endpoint.endpointId === endpoint.endpointId &&
                        confirming.kind === "remove"
                          ? opener
                          : undefined
                      }
                      size="sm"
                      variant="secondary"
                    >
                      Remove…
                    </OctantButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {view.published ? null : (
            <p className="setrow-hint">
              The hub has not taken the latest endpoint list yet; this computer tries again shortly.
            </p>
          )}

          {view.log.length === 0 ? null : (
            <ul aria-label="Recent deliveries" className="setgroup">
              {[...view.log]
                .reverse()
                .slice(0, 10)
                .map((entry, index) => (
                  <li className="setrow" key={`${entry.at}-${entry.endpointId}-${index}`}>
                    <span className="setrow-label">{labelOf(entry.endpointId)}</span>
                    <p className="setrow-hint">
                      {`${OUTCOME_COPY[entry.outcome] ?? `Refused: ${entry.outcome}`} · ${formatWhen(entry.at, now)}`}
                    </p>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}

      {view.hub === undefined ? null : (
        <p className="setrow-hint">
          {`As the hub: holding ${view.hub.endpoints} endpoint${view.hub.endpoints === 1 ? "" : "s"}, ${view.hub.queued} queued, ${view.hub.forwarded} forwarded, ${view.hub.refused} refused, ${view.hub.expired} expired.`}
        </p>
      )}

      <OctantDialogPresence>
        {confirming === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel={confirming.kind === "rotate" ? "Rotate endpoint" : "Remove endpoint"}
            destructive
            onCancel={() => setConfirming(undefined)}
            onConfirm={() => void decide()}
            restoreFocus={opener}
            title={
              confirming.kind === "rotate"
                ? `Rotate ${confirming.endpoint.label}?`
                : `Remove ${confirming.endpoint.label}?`
            }
          >
            {confirming.kind === "rotate"
              ? confirming.endpoint.scheme === "stripe"
                ? "The old URL and secret stop at once. Give Stripe the new URL and paste the secret it shows; automations that named this endpoint keep working."
                : "The old URL and secret stop at once. Give the sender the new pair; automations that named this endpoint keep working."
              : "Its URL stops answering at once, and automations that named it get no more deliveries."}
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
    </SettingsSection>
  );
}
