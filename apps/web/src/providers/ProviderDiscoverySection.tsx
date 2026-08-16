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
  // Discovery may include deferred families (e.g. cursor) that ProviderInstance cannot yet create.
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
    <section aria-label="Detected on this Mac" className="provider-discovery">
      <div className="provider-discovery__header">
        <div>
          <h3>Detected on this Mac</h3>
          <p>
            Octant scans installed runtimes automatically. Enable only the providers you want
            available.
          </p>
        </div>
        <OctantButton
          className="settings-view__action"
          disabled={scanning}
          onClick={() => void props.onScan()}
          type="button"
        >
          {scanning ? "Scanning…" : "Check again"}
        </OctantButton>
      </div>

      {scanning && snapshot === undefined ? (
        <p role="status">Scanning for installed runtimes…</p>
      ) : null}

      {props.message === undefined ? null : (
        <p className="provider-discovery__notice" role="alert">
          {props.message}{" "}
          <OctantButton
            aria-label="Retry provider discovery"
            onClick={() => void props.onScan()}
            type="button"
          >
            Retry
          </OctantButton>
        </p>
      )}

      {snapshot !== undefined && snapshot.status === "cancelled" ? (
        <p className="provider-discovery__notice" role="status">
          Scan was cancelled.{" "}
          <OctantButton onClick={() => void props.onScan()} type="button">
            Retry
          </OctantButton>
        </p>
      ) : null}

      {snapshot !== undefined && snapshot.status === "partial" ? (
        <p className="provider-discovery__notice" role="status">
          {snapshot.message ?? "Scan completed partially."} Some results may be missing.
        </p>
      ) : null}

      {snapshot !== undefined && snapshot.status === "failed" ? (
        <p className="provider-discovery__notice" role="alert">
          {snapshot.message ?? "Discovery scan failed."}{" "}
          <OctantButton onClick={() => void props.onScan()} type="button">
            Retry
          </OctantButton>
        </p>
      ) : null}

      {!scanning && detected.length === 0 && snapshot !== undefined ? (
        <p className="provider-discovery__empty">
          Installed providers are already listed below. Use <strong>Add provider manually</strong>
          only for a custom endpoint or unusual binary path.
        </p>
      ) : null}

      {detected.length > 0 ? (
        <ul className="provider-discovery__list" role="list">
          {detected.map((candidate) => (
            <DiscoveryCard
              key={`${candidate.driverKind}-${candidate.binaryPath}`}
              candidate={candidate}
              connecting={props.connectingPaths.has(candidate.binaryPath)}
              onConnect={props.onConnect}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface DiscoveryCardProps {
  readonly candidate: DiscoveryCandidate;
  readonly connecting: boolean;
  readonly onConnect: (candidate: DiscoveryCandidate) => Promise<boolean>;
}

function DiscoveryCard(props: DiscoveryCardProps) {
  const { candidate, connecting } = props;
  const [connected, setConnected] = useState(false);

  return (
    <li className="provider-discovery__card">
      <div className="provider-discovery__card-info">
        <span className="provider-discovery__card-name">{candidate.displayName}</span>
        {candidate.version !== undefined ? (
          <span className="provider-discovery__card-version">{candidate.version}</span>
        ) : null}
        <span className="provider-discovery__card-path">{candidate.pathSummary}</span>
        <ReadinessBadge readiness={candidate.readiness} />
      </div>
      <div className="provider-discovery__card-actions">
        {connected ? (
          <span className="provider-discovery__connected" role="status">
            Connected
          </span>
        ) : (
          <OctantButton
            className="settings-view__action"
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
      {candidate.readiness === "unauthenticated" && candidate.onboardingGuidance !== undefined ? (
        <p className="provider-discovery__guidance">{candidate.onboardingGuidance}</p>
      ) : null}
    </li>
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
  return (
    <span
      className={`provider-discovery__readiness provider-discovery__readiness--${props.readiness}`}
    >
      {label}
    </span>
  );
}
