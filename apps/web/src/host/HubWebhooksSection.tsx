import { WebhookSignatureScheme } from "@octant/contracts";
import { useId, useRef, useState } from "react";
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
 * it is never read back. Loaded as its own chunk (hub-and-spokes.md,
 * Webhook triggers).
 */

interface Endpoint {
  readonly endpointId: string;
  readonly scheme: string;
  readonly label: string;
  readonly path: string;
  readonly deliveries: number;
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
        ? [{ endpointId, scheme, label, path, deliveries: count(field(entry, "deliveries")) }]
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
  busy: "Held on the hub: the routine has not caught up",
  paused: "Held on the hub: remote access is paused",
};

const REFUSALS: Readonly<Record<string, string>> = {
  "public-not-granted": "Tick Public in this computer's hub grant first.",
  "unknown-endpoint": "That endpoint is gone. The list is up to date now.",
  full: "This computer already has 64 endpoints. Remove one first.",
};

interface Minted {
  readonly label: string;
  readonly path: string;
  readonly secret: string;
  readonly published: boolean;
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
  const [confirming, setConfirming] = useState<{
    readonly kind: "rotate" | "remove";
    readonly endpoint: Endpoint;
  }>();
  const opener = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const schemeId = useId();
  const now = (props.now ?? Date.now)();

  const show = (body: unknown, name: string) => {
    const path = field(body, "path");
    const secret = field(body, "secret");
    if (typeof path === "string" && typeof secret === "string") {
      setMinted({ label: name, path, secret, published: field(body, "published") === true });
    }
  };

  const create = async () => {
    const name = label.trim();
    const body = await action.run(
      "webhook-create",
      { scheme, label: name },
      "created",
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
        "created",
        "Octant could not rotate the endpoint.",
        REFUSALS,
      );
      if (body !== undefined) show(body, chosen.endpoint.label);
    } else {
      const body = await action.run(
        "webhook-remove",
        { endpointId: chosen.endpoint.endpointId },
        "removed",
        "Octant could not remove the endpoint.",
        REFUSALS,
      );
      if (body !== undefined) {
        action.say({
          kind: "success",
          text: `Removed ${chosen.endpoint.label}. Its URL answers nothing now.`,
        });
      }
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
      description="Let a service start one of this computer's routines by sending a signed request to the hub."
      title="Webhook endpoints"
    >
      {!props.member ? null : (
        <>
          <div className="settings-panel__stack">
            <p className="setrow-hint">
              {props.publicGranted
                ? "Name it and pick how the sender signs. A delivery is event data for its routine and never changes what the routine may do."
                : "Tick Public in this computer's hub grant to make one."}
            </p>
            <OctantField>
              <OctantFieldLabel htmlFor={labelId}>Name</OctantFieldLabel>
              <OctantInput
                autoComplete="off"
                disabled={!props.publicGranted}
                id={labelId}
                maxLength={128}
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
                disabled={action.busy || !props.publicGranted || label.trim() === ""}
                onClick={() => void create()}
              >
                Make endpoint
              </OctantButton>
            </div>
          </div>

          {minted === undefined ? null : (
            <div aria-label="New endpoint secret" className="settings-panel__stack" role="group">
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
              <div className="host-settings__controls">
                <OctantButton onClick={() => setMinted(undefined)} variant="secondary">
                  Done
                </OctantButton>
              </div>
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
                      endpoint.deliveries === 0
                        ? ""
                        : ` · ${endpoint.deliveries} waiting for the routine`
                    }`}
                  </p>
                  <div className="setrow-control">
                    <OctantButton
                      aria-label={`Rotate ${endpoint.label}`}
                      disabled={action.busy}
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
              ? "The old URL and secret stop at once. Give the sender the new pair; routines that named this endpoint keep working."
              : "Its URL stops answering at once, and routines that named it get no more deliveries."}
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
    </SettingsSection>
  );
}
