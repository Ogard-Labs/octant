import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { HostResourceSnapshot } from "@octant/contracts/host-resources";
import { Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import {
  agentCountLabel,
  capacityLabel,
  COMPUTERS_ROW_LIMIT,
  computerBars,
  connectionLabel,
  type ComputersCardHost,
} from "./computers";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";
import { useActiveAgentRuns } from "./useActiveAgentRuns";

export const COMPUTERS_CARD_ID = "computers";
const RESOURCE_POLL_MS = 10_000;

export type HostResourceRead =
  | { readonly status: "ready"; readonly snapshot: HostResourceSnapshot }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" };

export interface ComputersCardSource {
  readonly hosts: ReadonlyArray<ComputersCardHost>;
  /**
   * The host whose AgentRun projection this window already holds. Its running
   * count is that read; every other host uses `runningAgents` on the row.
   */
  readonly launchHostId: string;
  readonly agentRunClient: AgentRunClient | undefined;
  readonly runRevision: number;
  readonly now: number;
  /**
   * Read one host's load snapshot. Called only for a visible card, about
   * every 10 seconds, and never while the window is hidden.
   */
  readonly readResources: (hostId: string) => Promise<HostResourceRead>;
  /** Opens Running with the environment filter set to this host. */
  readonly onOpenRunning: (hostId: string) => void;
  /** Test seam. Production waits ten seconds between reads. */
  readonly pollMs?: number;
}

/**
 * Computers this window is connected to: this computer, paired hosts,
 * devboxes, and servers. A row names the connection in words, and shows
 * load only when this window may read that host.
 */
export function createComputersCard(source: ComputersCardSource): HomeCardDefinition {
  return {
    id: COMPUTERS_CARD_ID,
    title: "Computers",
    icon: Monitor,
    defaultOn: true,
    available: true,
    emptyLabel: "No computers are connected.",
    useContent: () => useComputersContent(source),
  };
}

function useComputersContent(source: ComputersCardSource): HomeCardContent {
  const runs = useActiveAgentRuns(source.agentRunClient, source.runRevision);
  const hosts = source.hosts.map((host) =>
    host.hostId === source.launchHostId && runs !== undefined
      ? { ...host, runningAgents: runs.length }
      : host,
  );
  const snapshots = useVisibleResourceReads(
    hosts,
    source.readResources,
    source.pollMs ?? RESOURCE_POLL_MS,
  );
  if (hosts.length === 0) return { status: "ready", count: 0, body: null };
  return {
    status: "ready",
    count: hosts.length,
    body: (
      <ComputerRows
        hosts={hosts}
        now={source.now}
        onOpenRunning={source.onOpenRunning}
        snapshots={snapshots}
      />
    ),
  };
}

/**
 * Reads while the card is mounted and the window is in front. Hiding the
 * window clears the timer; it does not keep sampling in the background.
 */
function useVisibleResourceReads(
  hosts: ReadonlyArray<ComputersCardHost>,
  readResources: (hostId: string) => Promise<HostResourceRead>,
  pollMs: number,
): ReadonlyMap<string, HostResourceSnapshot> {
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, HostResourceSnapshot>>(
    () => new Map(),
  );
  const readRef = useRef(readResources);
  readRef.current = readResources;
  const allowedKey = hosts
    .filter((host) => host.figuresAllowed && host.connection !== "offline")
    .map((host) => host.hostId)
    .join("\0");

  useEffect(() => {
    const ids = allowedKey.length === 0 ? [] : allowedKey.split("\0");
    const allowed = new Set(ids);
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const apply = (hostId: string, result: HostResourceRead) => {
      if (stopped) return;
      setSnapshots((current) => {
        const next = new Map(current);
        if (result.status === "ready") next.set(hostId, result.snapshot);
        else if (result.status === "refused") next.delete(hostId);
        return next;
      });
    };

    const readAll = () => {
      if (document.hidden) return;
      for (const hostId of ids) {
        void readRef.current(hostId).then(
          (result) => apply(hostId, result),
          () => apply(hostId, { status: "unavailable" }),
        );
      }
    };

    const stopTimer = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };

    const start = () => {
      readAll();
      timer = setInterval(readAll, pollMs);
    };

    setSnapshots((current) => {
      const next = new Map<string, HostResourceSnapshot>();
      for (const [hostId, snapshot] of current) {
        if (allowed.has(hostId)) next.set(hostId, snapshot);
      }
      return next;
    });

    if (!document.hidden) start();
    const onVisibility = () => {
      if (document.hidden) {
        stopTimer();
        return;
      }
      if (timer === undefined) start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [allowedKey, pollMs]);

  return snapshots;
}

function ComputerRows(props: {
  readonly hosts: ReadonlyArray<ComputersCardHost>;
  readonly snapshots: ReadonlyMap<string, HostResourceSnapshot>;
  readonly now: number;
  readonly onOpenRunning: (hostId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? props.hosts : props.hosts.slice(0, COMPUTERS_ROW_LIMIT);
  const hidden = props.hosts.length - shown.length;
  return (
    <>
      <ul className="computers-card__list">
        {shown.map((host) => (
          <ComputerRow
            host={host}
            key={host.hostId}
            now={props.now}
            onOpenRunning={props.onOpenRunning}
            snapshot={props.snapshots.get(host.hostId)}
          />
        ))}
      </ul>
      {hidden <= 0 ? null : (
        <OctantButton
          className="computers-card__more window-no-drag"
          onClick={() => setExpanded(true)}
          size="sm"
          type="button"
          variant="link"
        >
          {`+${String(hidden)} more`}
        </OctantButton>
      )}
    </>
  );
}

function ComputerRow(props: {
  readonly host: ComputersCardHost;
  readonly snapshot: HostResourceSnapshot | undefined;
  readonly now: number;
  readonly onOpenRunning: (hostId: string) => void;
}) {
  const { host } = props;
  const bars =
    host.connection !== "offline" && props.snapshot !== undefined
      ? computerBars(props.snapshot)
      : undefined;
  const seen = seenTitle(host.lastSeenAt);
  return (
    <li className="computers-card__row" data-connection={host.connection}>
      <span className="computers-card__identity">
        <span
          aria-hidden="true"
          className="computers-card__dot"
          data-connection={host.connection}
        />
        <span className="oct-row-label computers-card__name">{host.name}</span>
        <span className="oct-meta computers-card__state">{connectionLabel(host.connection)}</span>
      </span>
      {host.connection === "offline" ? (
        <span
          className="oct-meta computers-card__seen"
          {...(seen === undefined ? {} : { title: seen })}
        >
          {seenLabel(host.lastSeenAt, props.now)}
        </span>
      ) : bars === undefined ? null : (
        <span className="oct-meta computers-card__capacity">
          {capacityLabel(bars.cores, bars.totalMemoryBytes)}
        </span>
      )}
      {bars === undefined ? null : (
        <span className="computers-card__bars">
          <LoadBar label="CPU" percent={bars.cpuPercent} />
          <LoadBar label="Memory" percent={bars.memoryPercent} />
          {bars.diskPercent === undefined ? null : (
            <LoadBar label="Disk" percent={bars.diskPercent} />
          )}
        </span>
      )}
      <OctantButton
        className="computers-card__agents window-no-drag"
        onClick={() => props.onOpenRunning(host.hostId)}
        size="sm"
        type="button"
        variant="link"
      >
        {agentCountLabel(host.runningAgents)}
      </OctantButton>
    </li>
  );
}

function LoadBar(props: { readonly label: string; readonly percent: number }) {
  return (
    <span className="computers-card__meter">
      <span className="oct-meta computers-card__meter-label">{props.label}</span>
      <span
        aria-label={`${props.label} ${String(props.percent)} percent`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={props.percent}
        className="computers-card__track"
        role="meter"
      >
        <span className="computers-card__fill" style={{ width: `${String(props.percent)}%` }} />
      </span>
      <span className="oct-meta computers-card__percent">{`${String(props.percent)}%`}</span>
    </span>
  );
}

function seenLabel(lastSeenAt: string | undefined, now: number): string {
  if (lastSeenAt === undefined) return "Not seen yet";
  return `Last seen ${relativeTimeLabel(lastSeenAt, now)}`;
}

function seenTitle(lastSeenAt: string | undefined): string | undefined {
  if (lastSeenAt === undefined) return undefined;
  const parsed = Date.parse(lastSeenAt);
  if (!Number.isFinite(parsed)) return undefined;
  return absoluteTimeFormatter.format(new Date(parsed));
}
