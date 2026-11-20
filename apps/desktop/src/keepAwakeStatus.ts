import type { KeepAwakeStatus } from "@octant/contracts/desktop-bridge";

export type { KeepAwakeStatus };

const MAX_SUMMARY_LENGTH = 200;

/**
 * Validates the live keep-awake status crossing the Electron contextBridge.
 * Kept free of runtime package imports so the sandboxed preload can import it.
 */
export function decodeKeepAwakeStatus(value: unknown): KeepAwakeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid keep-awake status.");
  }
  const record = value as Record<string, unknown>;
  if (record.state === "unavailable") {
    return Object.freeze({ state: "unavailable" });
  }
  if (record.state === "idle") {
    if (
      record.reason !== "disabled" &&
      record.reason !== "on-battery" &&
      record.reason !== "no-work"
    ) {
      throw new Error("Invalid keep-awake idle reason.");
    }
    return Object.freeze({ state: "idle", reason: record.reason });
  }
  if (record.state === "active") {
    if (
      typeof record.summary !== "string" ||
      record.summary.trim() === "" ||
      record.summary.length > MAX_SUMMARY_LENGTH
    ) {
      throw new Error("Invalid keep-awake active summary.");
    }
    return Object.freeze({ state: "active", summary: record.summary });
  }
  throw new Error("Invalid keep-awake status.");
}
