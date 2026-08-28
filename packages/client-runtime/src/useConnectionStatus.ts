import { useSyncExternalStore } from "react";
import type { ConnectionStatus, ConnectionSupervisor } from "./connectionSupervisor";

const IDLE_STATUS: ConnectionStatus = Object.freeze({ kind: "idle", attempts: 0 });
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;
const READ_IDLE_STATUS = (): ConnectionStatus => IDLE_STATUS;

export function useConnectionStatus(
  supervisor: ConnectionSupervisor | undefined,
): ConnectionStatus {
  const subscribe = supervisor?.subscribe ?? NOOP_SUBSCRIBE;
  const readStatus = supervisor?.status ?? READ_IDLE_STATUS;
  return useSyncExternalStore(subscribe, readStatus, readStatus);
}
