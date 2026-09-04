import type { DiscoveryCandidate, DiscoverySnapshot, ProviderInstance } from "@octant/contracts";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ProviderDiscoverySectionProps {
  readonly snapshot: DiscoverySnapshot | undefined;
  readonly scanning: boolean;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly onScan: () => Promise<void>;
  readonly onConnect: (candidate: DiscoveryCandidate) => Promise<boolean>;
  readonly connectingPaths: ReadonlySet<string>;
  readonly message?: string;
}

export function ProviderDiscoverySection(props: ProviderDiscoverySectionProps) {
  const { snapshot, scanning, instances } = props;

  // One configured instance per driver family hides further detected candidates.
  const configuredDriverKinds = new Set<string>(instances.map((instance) => instance.driverKind));
  const configuredPaths = new Set(
    instances
      .filter((i) => "binaryPath" in i.configuration)
      .map((i) => (i.configuration as { binaryPath: string }).binaryPath),
  );
  const detected = (snapshot?.candidates ?? []).filter(
    (candidate) =>
      !configuredDriverKinds.has(candidate.driverKind) &&
      !configuredPaths.has(candidate.binaryPath),
  );

  return (
    <section
      aria-label="Detected on this Mac"
      className="settings-card-section settings-card-section--open provider-discovery"
    >
      <div className="settings-section-head">
        <h2>Detected on this Mac</h2>
        <OctantButton
          size="sm"
          variant="ghost"
          disabled={scanning}
          onClick={() => void props.onScan()}
          type="button"
        >
          {scanning ? "Scanning…" : "Check again"}
        </OctantButton>
      </div>

      <p className="settings-section-note">
        Octant scans installed runtimes and checks every enabled provider. Enable only the providers
        you want available.
      </p>

      {scanning && snapshot === undefined ? (
        <p className="settings-section-line" role="status">
          Scanning for installed runtimes…
        </p>
      ) : null}

      {props.message === undefined ? null : (
        <p className="settings-section-line" role="alert">
          {props.message}{" "}
          <OctantButton
            size="sm"
            variant="ghost"
            aria-label="Retry provider discovery"
            onClick={() => void props.onScan()}
            type="button"
          >
            Retry
          </OctantButton>
        </p>
      )}

      {snapshot !== undefined && snapshot.status === "cancelled" ? (
        <p className="settings-section-line" role="status">
          Scan was cancelled.{" "}
          <OctantButton size="sm" variant="ghost" onClick={() => void props.onScan()} type="button">
            Retry
          </OctantButton>
        </p>
      ) : null}

      {snapshot !== undefined && snapshot.status === "partial" ? (
        <p className="settings-section-line" role="status">
          {snapshot.message ?? "Scan completed partially."} Some results may be missing.
        </p>
      ) : null}

      {snapshot !== undefined && snapshot.status === "failed" ? (
        <p className="settings-section-line" role="alert">
          {snapshot.message ?? "Discovery scan failed."}{" "}
          <OctantButton size="sm" variant="ghost" onClick={() => void props.onScan()} type="button">
            Retry
          </OctantButton>
        </p>
      ) : null}

      {!scanning && detected.length === 0 && snapshot !== undefined ? (
        <p className="settings-section-line">
          Installed providers are already listed below. Use “Add provider manually” only for a
          custom endpoint or unusual binary path.
        </p>
      ) : null}

      {detected.length === 0 ? null : (
        <div className="setgroup">
          {detected.map((candidate) => (
            <DiscoveryRow
              key={`${candidate.driverKind}-${candidate.binaryPath}`}
              candidate={candidate}
              connecting={props.connectingPaths.has(candidate.binaryPath)}
              onConnect={props.onConnect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface DiscoveryRowProps {
  readonly candidate: DiscoveryCandidate;
  readonly connecting: boolean;
  readonly onConnect: (candidate: DiscoveryCandidate) => Promise<boolean>;
}

function DiscoveryRow(props: DiscoveryRowProps) {
  const { candidate, connecting } = props;
  const [connected, setConnected] = useState(false);

  return (
    <div className="setrow">
      <span className="setrow-label">
        {candidate.displayName}
        {candidate.version !== undefined ? (
          <span className="oct-meta oct-meta--mono provider-discovery__version">
            {candidate.version}
          </span>
        ) : null}
      </span>
      <p className="setrow-hint">
        <span className="oct-meta--mono">{candidate.pathSummary}</span>
        {candidate.readiness === "unauthenticated" && candidate.onboardingGuidance !== undefined ? (
          <span className="provider-discovery__guidance">{candidate.onboardingGuidance}</span>
        ) : null}
      </p>
      <div className="setrow-control row">
        <ReadinessText readiness={candidate.readiness} />
        {connected ? (
          <span className="oct-meta" role="status">
            Connected
          </span>
        ) : (
          <OctantButton
            size="sm"
            variant="outline"
            disabled={connecting}
            onClick={() => {
              void props.onConnect(candidate).then((ok) => {
                if (ok) setConnected(true);
              });
            }}
            type="button"
          >
            {connecting ? "Connecting…" : "Enable"}
          </OctantButton>
        )}
      </div>
    </div>
  );
}

/**
 * Readiness is a fact about the runtime on disk, said in words rather than a
 * pill: colour marks only the states that need attention.
 */
function ReadinessText(props: { readonly readiness: DiscoveryCandidate["readiness"] }) {
  const label =
    props.readiness === "ready"
      ? "Ready"
      : props.readiness === "unauthenticated"
        ? "Authentication required"
        : props.readiness === "incompatible"
          ? "Incompatible"
          : props.readiness === "unavailable"
            ? "Unavailable"
            : "Unknown";
  const tone =
    props.readiness === "ready"
      ? "ok"
      : props.readiness === "unauthenticated"
        ? "warn"
        : props.readiness === "incompatible" || props.readiness === "unavailable"
          ? "danger"
          : "neutral";
  return (
    <span className="prov-state" data-tone={tone}>
      {label}
    </span>
  );
}
