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
    <section aria-label="Detected on this Mac" className="setgroup provider-discovery">
      <div className="setgroup-head">
        <span>Detected on this Mac</span>
        <span className="setgroup-gap" />
        <OctantButton
          size="sm"
          variant="outline"
          disabled={scanning}
          onClick={() => void props.onScan()}
          type="button"
        >
          {scanning ? "Scanning…" : "Check again"}
        </OctantButton>
      </div>

      <p className="setgroup-note">
        Octant scans installed runtimes and checks every enabled provider. Enable only the providers
        you want available.
      </p>

      {scanning && snapshot === undefined ? (
        <p className="setgroup-note" role="status">
          Scanning for installed runtimes…
        </p>
      ) : null}

      {props.message === undefined ? null : (
        <p className="setgroup-note" role="alert">
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
        <p className="setgroup-note" role="status">
          Scan was cancelled.{" "}
          <OctantButton size="sm" variant="ghost" onClick={() => void props.onScan()} type="button">
            Retry
          </OctantButton>
        </p>
      ) : null}

      {snapshot !== undefined && snapshot.status === "partial" ? (
        <p className="setgroup-note" role="status">
          {snapshot.message ?? "Scan completed partially."} Some results may be missing.
        </p>
      ) : null}

      {snapshot !== undefined && snapshot.status === "failed" ? (
        <p className="setgroup-note" role="alert">
          {snapshot.message ?? "Discovery scan failed."}{" "}
          <OctantButton size="sm" variant="ghost" onClick={() => void props.onScan()} type="button">
            Retry
          </OctantButton>
        </p>
      ) : null}

      {!scanning && detected.length === 0 && snapshot !== undefined ? (
        <p className="setgroup-note">
          Installed providers are already listed below. Use <strong>Add provider manually</strong>{" "}
          only for a custom endpoint or unusual binary path.
        </p>
      ) : null}

      {detected.map((candidate) => (
        <DiscoveryRow
          key={`${candidate.driverKind}-${candidate.binaryPath}`}
          candidate={candidate}
          connecting={props.connectingPaths.has(candidate.binaryPath)}
          onConnect={props.onConnect}
        />
      ))}
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
          <span className="provider-discovery__version">{candidate.version}</span>
        ) : null}
      </span>
      <p className="setrow-hint">
        <span>{candidate.pathSummary}</span>
        {candidate.readiness === "unauthenticated" && candidate.onboardingGuidance !== undefined ? (
          <span className="provider-discovery__guidance">{candidate.onboardingGuidance}</span>
        ) : null}
      </p>
      <div className="setrow-control row">
        <ReadinessBadge readiness={candidate.readiness} />
        {connected ? (
          <span className="provider-discovery__connected" role="status">
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

function ReadinessBadge(props: { readonly readiness: DiscoveryCandidate["readiness"] }) {
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
  const variant =
    props.readiness === "ready"
      ? "badge badge-ok"
      : props.readiness === "unauthenticated"
        ? "badge badge-warn"
        : props.readiness === "incompatible" || props.readiness === "unavailable"
          ? "badge badge-danger"
          : "badge";
  return <span className={variant}>{label}</span>;
}
