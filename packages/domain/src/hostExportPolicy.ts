/**
 * Pure authority and shaping for a host-wide export.
 *
 * A paired device may export one thread it can already open. It may not take
 * this cut: the cut is everything the host holds, so only the local owner
 * may ask. Shaping copies allowlisted fields, and the thread export's
 * forbidden-key walk is the closed check before a page is written.
 */

import {
  decodeHostExportBundle,
  decodeHostExportCanvas,
  decodeHostExportPage,
  decodeHostExportProject,
  decodeHostExportSettingsSummary,
  type HostExportBundle,
  type HostExportCanvas,
  type HostExportOmission,
  type HostExportPage,
  type HostExportProject,
  type HostExportSettingsSummary,
} from "@octant/contracts/host-export";
import type { ProjectId } from "@octant/contracts/projects";
import { threadExportContainsForbiddenKey } from "./threadExportPolicy";

export const HOST_EXPORT_PAGE_SIZE = 32;

export type HostExportPrincipal = "local-window" | "remote-device" | "paired-device";

export type HostExportAuthorization =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: "local-owner-only" };

/**
 * Local owner only. A remote principal and a paired device are the same
 * refusal: both are off this host, and this cut is not a thread they can
 * already open.
 */
export function authorizeHostExport(principal: HostExportPrincipal): HostExportAuthorization {
  return principal === "local-window"
    ? { kind: "allow" }
    : { kind: "deny", reason: "local-owner-only" };
}

export function hostExportPageLimit(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 1) return HOST_EXPORT_PAGE_SIZE;
  return Math.min(requested, HOST_EXPORT_PAGE_SIZE);
}

const OMISSIONS: ReadonlyArray<HostExportOmission> = [
  {
    subject: "credentials",
    reason: "Secrets, tokens, and credential material are unrepresentable.",
  },
  {
    subject: "filesystem-paths",
    reason: "Host filesystem paths are omitted so the bundle cannot name a local root.",
  },
  {
    subject: "attachment-bytes",
    reason: "Attachment and image bytes stay outside the bundle; each thread cut names that gap.",
  },
  {
    subject: "raw-provider-payloads",
    reason: "Raw provider payloads, headers, and resume cursors are unrepresentable.",
  },
  {
    subject: "composer-drafts",
    reason: "Unsent composer drafts are not journaled and are not part of this export.",
  },
  {
    subject: "paired-device-keys",
    reason: "Paired-device keys and session proofs stay on the host.",
  },
  {
    subject: "window-capabilities",
    reason: "Window capabilities are authentication material and are omitted.",
  },
];

/** The closed list of what this export never includes, and why. */
export function hostExportOmissions(unrepresentableRecords = 0): ReadonlyArray<HostExportOmission> {
  if (unrepresentableRecords <= 0) return OMISSIONS;
  return [
    ...OMISSIONS,
    {
      subject: "unrepresentable-record",
      reason: "A record that would have carried a forbidden key was left out.",
    },
  ];
}

export interface HostExportSettingsSource {
  readonly chatEnabled: boolean;
  readonly workEnabled: boolean;
  readonly themeMode: HostExportSettingsSummary["themeMode"];
  readonly streamReplies?: boolean;
  /** Present only so a caller cannot sneak a credential past the type. Never copied. */
  readonly apiKey?: unknown;
  readonly password?: unknown;
  readonly canonicalRoot?: unknown;
}

/** Copy only the non-secret settings flags. Extra keys are not representable. */
export function projectHostExportSettings(
  source: HostExportSettingsSource,
): HostExportSettingsSummary {
  return decodeHostExportSettingsSummary({
    chatEnabled: source.chatEnabled,
    workEnabled: source.workEnabled,
    themeMode: source.themeMode,
    ...(source.streamReplies === undefined ? {} : { streamReplies: source.streamReplies }),
  });
}

export interface HostExportProjectSource {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly type: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
  /** Present only so a binding or credential cannot be copied by accident. Never copied. */
  readonly canonicalRoot?: unknown;
  readonly apiKey?: unknown;
}

/** Copy Project identity only. Bindings and paths never enter the cut. */
export function projectHostExportProject(source: HostExportProjectSource): HostExportProject {
  return decodeHostExportProject({
    projectId: source.projectId,
    name: source.name,
    type: source.type,
    lifecycle: source.lifecycle,
  });
}

/**
 * Include a Canvas only when its definition decodes and carries no forbidden
 * key. A dropped Canvas is an omission, not a partial definition.
 */
export function projectHostExportCanvas(source: unknown): HostExportCanvas | undefined {
  if (threadExportContainsForbiddenKey(source)) return undefined;
  try {
    return decodeHostExportCanvas(source);
  } catch {
    return undefined;
  }
}

export type EncodedHostExportPage =
  | { readonly kind: "ok"; readonly line: string }
  | { readonly kind: "refused" };

/**
 * Write one page only after the thread-export forbidden-key walk accepts it.
 * A refusal is a fixed object: the page that failed the walk is not serialized.
 */
export function encodeHostExportPage(page: unknown): EncodedHostExportPage {
  if (threadExportContainsForbiddenKey(page)) return { kind: "refused" };
  try {
    const decoded = decodeHostExportPage(page);
    if (threadExportContainsForbiddenKey(decoded)) return { kind: "refused" };
    return { kind: "ok", line: `${JSON.stringify(decoded)}\n` };
  } catch {
    return { kind: "refused" };
  }
}

export function hostExportPageContainsForbiddenKey(page: unknown): boolean {
  return threadExportContainsForbiddenKey(page);
}

/**
 * Slice a resident identity list into a bounded page. The cursor is the next
 * index; an unreadable cursor yields nothing rather than restarting.
 */
export function pageHostExportSlice<T>(
  items: ReadonlyArray<T>,
  cursor: string | undefined,
  limit: number,
): { readonly items: ReadonlyArray<T>; readonly nextCursor: string | undefined } {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0) return { items: [], nextCursor: undefined };
  const bounded = hostExportPageLimit(limit);
  const page = items.slice(start, start + bounded);
  const next = start + page.length;
  return {
    items: page,
    nextCursor: next < items.length ? String(next) : undefined,
  };
}

export type AssembledHostExport =
  | { readonly kind: "exported"; readonly bundle: HostExportBundle }
  | {
      readonly kind: "refused";
      readonly reason: "local-owner-only" | "unrepresentable" | "incomplete";
    };

/**
 * Assemble streamed pages into the inspectable bundle and walk the result
 * with the thread-export forbidden-key scan. A refusal does not return the
 * pages that failed the walk.
 */
export function assembleHostExportBundle(pages: ReadonlyArray<unknown>): AssembledHostExport {
  const threads: HostExportBundle["threads"][number][] = [];
  const projects: HostExportBundle["projects"][number][] = [];
  const projectMemory: HostExportBundle["projectMemory"][number][] = [];
  const canvases: HostExportBundle["canvases"][number][] = [];
  const usage: HostExportBundle["usage"][number][] = [];
  const windows: HostExportBundle["retention"]["windows"][number][] = [];
  const tombstones: HostExportBundle["retention"]["tombstones"][number][] = [];
  let header: HostExportBundle["octant"] | undefined;
  let settings: HostExportBundle["settings"] | undefined;
  let omissions: HostExportBundle["omissions"] | undefined;
  let completed: number | undefined;

  for (const page of pages) {
    if (threadExportContainsForbiddenKey(page))
      return { kind: "refused", reason: "unrepresentable" };
    let decoded: HostExportPage;
    try {
      decoded = decodeHostExportPage(page);
    } catch {
      return { kind: "refused", reason: "incomplete" };
    }
    if (decoded.kind === "refused") {
      return {
        kind: "refused",
        reason: decoded.reason === "local-owner-only" ? "local-owner-only" : "unrepresentable",
      };
    }
    if (decoded.kind === "header") header = decoded.octant;
    else if (decoded.kind === "threads") threads.push(...decoded.threads);
    else if (decoded.kind === "projects") projects.push(...decoded.projects);
    else if (decoded.kind === "project-memory") projectMemory.push(...decoded.projectMemory);
    else if (decoded.kind === "canvases") canvases.push(...decoded.canvases);
    else if (decoded.kind === "settings") settings = decoded.settings;
    else if (decoded.kind === "usage") usage.push(...decoded.usage);
    else if (decoded.kind === "retention-windows") windows.push(...decoded.windows);
    else if (decoded.kind === "retention-tombstones") tombstones.push(...decoded.tombstones);
    else if (decoded.kind === "omissions") omissions = decoded.omissions;
    else completed = decoded.threadCount;
  }

  if (
    header === undefined ||
    settings === undefined ||
    omissions === undefined ||
    completed === undefined ||
    header.threadCount !== threads.length ||
    completed !== threads.length
  ) {
    return { kind: "refused", reason: "incomplete" };
  }

  let bundle: HostExportBundle;
  try {
    bundle = decodeHostExportBundle({
      octant: header,
      threads,
      projects,
      projectMemory,
      canvases,
      settings,
      usage,
      retention: { windows, tombstones },
      omissions,
    });
  } catch {
    return { kind: "refused", reason: "incomplete" };
  }
  if (threadExportContainsForbiddenKey(bundle))
    return { kind: "refused", reason: "unrepresentable" };
  return { kind: "exported", bundle };
}
