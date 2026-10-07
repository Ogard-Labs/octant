import type { FederatedHostLifecycleState } from "@octant/client-runtime/host-federation-lifecycle";
import type { HostResourceSnapshot } from "@octant/contracts/host-resources";

/** How many hosts the card lists before it says "+N more". */
export const COMPUTERS_ROW_LIMIT = 4;

export type ComputerConnection = "connected" | "reconnecting" | "offline";

export interface ComputersCardHost {
  readonly hostId: string;
  readonly name: string;
  readonly connection: ComputerConnection;
  /** False when this window may see the host but not its figures. */
  readonly figuresAllowed: boolean;
  /**
   * Agents running there. Absent when the host does not report it: only the
   * host whose AgentRun projection this window holds has a count to show.
   */
  readonly runningAgents?: number;
  /** When the host was last ready. Shown for an offline row. */
  readonly lastSeenAt?: string;
}

export interface ComputerResourceBars {
  readonly cores: number;
  readonly totalMemoryBytes: number;
  readonly cpuPercent: number;
  readonly memoryPercent: number;
  readonly diskPercent?: number;
}

/**
 * Connection words the card shows. Unauthorized is still connected: the host
 * answered, and the missing figures are an authority refusal, not an outage.
 */
export function computerConnection(state: FederatedHostLifecycleState): {
  readonly connection: ComputerConnection;
  readonly figuresAllowed: boolean;
} {
  switch (state) {
    case "ready":
      return { connection: "connected", figuresAllowed: true };
    case "connecting":
      return { connection: "reconnecting", figuresAllowed: true };
    case "unauthorized":
      return { connection: "connected", figuresAllowed: false };
    case "stale":
    case "incompatible":
    case "unavailable":
      return { connection: "offline", figuresAllowed: false };
  }
}

export function sameHostOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function connectionLabel(connection: ComputerConnection): string {
  switch (connection) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
  }
}

export function computerBars(snapshot: HostResourceSnapshot): ComputerResourceBars {
  const memoryPercent = percentOf(snapshot.memory.usedBytes, snapshot.memory.totalBytes);
  const disk = snapshot.disk;
  const diskPercent =
    disk === undefined ? undefined : percentOf(disk.usedBytes, disk.usedBytes + disk.freeBytes);
  return {
    cores: snapshot.cores,
    totalMemoryBytes: snapshot.memory.totalBytes,
    cpuPercent: snapshot.cpuPercent,
    memoryPercent,
    ...(diskPercent === undefined ? {} : { diskPercent }),
  };
}

export function memoryLabel(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 10) return `${Math.round(gib).toString()} GB`;
  if (gib >= 1) {
    const rounded = Math.round(gib * 10) / 10;
    return `${rounded.toFixed(1)} GB`;
  }
  const mib = bytes / (1024 * 1024);
  return `${Math.max(1, Math.round(mib)).toString()} MB`;
}

export function capacityLabel(cores: number, totalMemoryBytes: number): string {
  const coreWord = cores === 1 ? "core" : "cores";
  return `${cores.toString()} ${coreWord} · ${memoryLabel(totalMemoryBytes)}`;
}

export function agentCountLabel(count: number): string {
  return count === 1 ? "1 agent" : `${count.toString()} agents`;
}

function percentOf(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}
