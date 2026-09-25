import { createHash } from "node:crypto";
import {
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
  MAX_BROWSER_TABS_PER_CONTEXT,
  decodeBrowserContextId,
  decodeBrowserThreadId,
  decodeProjectBrowserResult,
  type BindingRevisionId,
  type BrowserContextId,
  type BrowserContextPolicy,
  type BrowserContextState,
  type BrowserPresentationKind,
  type BrowserThreadId,
  type Project,
  type ProjectBrowserCommand,
  type ProjectBrowserMode,
  type ProjectBrowserPage,
  type ProjectBrowserRefusalReason,
  type ProjectBrowserResult,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { BrowserRuntimeObservation, BrowserRuntimePort } from "./browserRuntimePort";

/** The longest a context may live, the same ceiling every browsing context has on this host. */
const PROJECT_BROWSER_SESSION_MS = 600_000;
/** How often a headless page may be pictured, however often the renderer asks. */
const PEEK_INTERVAL_MS = 1_500;

/** Who is asking. Only the person at a local window may drive a Project browser. */
export type ProjectBrowserCaller = "local-window" | "remote-device";

export interface ProjectBrowserServiceOptions {
  readonly runtime: Pick<
    BrowserRuntimePort,
    "available" | "createContext" | "act" | "peek" | "closeContext" | "onProcessExit"
  >;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  /**
   * Whether this window's own workspace holds the Project for its mode, the
   * same boundary a thread's browsing context is held to.
   */
  readonly canAccessProject: (
    windowId: WindowId,
    projectId: ProjectId,
    mode: ProjectBrowserMode,
  ) => boolean;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
}

interface OwnedPage {
  readonly windowId: WindowId;
  readonly projectId: ProjectId;
  readonly mode: ProjectBrowserMode;
  readonly subjectId: BrowserThreadId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly contextId: BrowserContextId;
  readonly origin: string;
  readonly abort: AbortController;
  state: BrowserContextState;
  presentation: BrowserPresentationKind | undefined;
  page: ProjectBrowserPage | undefined;
  peekedAt: number | undefined;
  cancelExpiry: (() => void) | undefined;
}

type Authority =
  | {
      readonly kind: "allowed";
      readonly mode: ProjectBrowserMode;
      readonly bindingRevisionId: BindingRevisionId;
    }
  | {
      readonly kind: "refused";
      readonly reason: ProjectBrowserRefusalReason;
      readonly message: string;
    };

/**
 * The owner a Project's page is registered under with the browser runtime.
 *
 * The runtime and the desktop view know an owner only as a window and an
 * opaque id; a native view attaches when both match. Deriving the id from the
 * Project under its own namespace keeps it stable for the renderer to name and
 * keeps it from ever being the id of a thread, so no thread's surface can
 * attach to a Project's page or the other way round.
 */
export function projectBrowserSubjectId(projectId: ProjectId): BrowserThreadId {
  const digest = createHash("sha256")
    .update("octant.project-browser.v1\0")
    .update(String(projectId))
    .digest("hex");
  return decodeBrowserThreadId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  );
}

/**
 * Browsers a person opens for a Work or Code Project without a thread.
 *
 * A page here is the person's and nobody else's. It lives in its own isolated
 * context, separate from every thread's browsing context, and this service is
 * the only thing that knows it exists: the agent's browser tools resolve
 * contexts through the thread-owned automation service, which never sees
 * these, so no tool call can name one. Nothing is journaled, as for a thread's
 * browsing context; the page ends with the session, the window, or the
 * Project's binding.
 */
export class ProjectBrowserService {
  readonly #options: ProjectBrowserServiceOptions;
  readonly #schedule: (delayMs: number, callback: () => void) => () => void;
  readonly #pages = new Map<string, OwnedPage>();
  readonly #removeProcessExitListener: (() => void) | undefined;

  constructor(options: ProjectBrowserServiceOptions) {
    this.#options = options;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#removeProcessExitListener = options.runtime.onProcessExit?.((contextIds) => {
      const affected = contextIds === undefined ? undefined : new Set(contextIds.map(String));
      for (const owned of this.#pages.values()) {
        if (affected !== undefined && !affected.has(String(owned.contextId))) continue;
        this.#forget(owned, "failed");
      }
    });
  }

  async execute(
    windowId: WindowId,
    caller: ProjectBrowserCaller,
    command: ProjectBrowserCommand,
  ): Promise<ProjectBrowserResult> {
    // A paired device may not open or drive a page on this Mac. A thread's
    // context keeps creation local for the same reason; a Project's page has
    // no thread whose approval could stand in for the person being here.
    if (caller !== "local-window") {
      return refused("unauthorized", "A Project browser opens only from this Mac's own window.");
    }
    const authority = this.#authority(windowId, command.projectId);
    const owned = this.#pages.get(key(windowId, command.projectId));
    if (authority.kind === "refused") {
      if (owned !== undefined && authority.reason === "authority-revoked") {
        await this.#close(owned, "stopped");
      }
      return refused(authority.reason, authority.message);
    }
    if (
      owned !== undefined &&
      String(owned.bindingRevisionId) !== String(authority.bindingRevisionId)
    ) {
      await this.#close(owned, "stopped");
      return refused("authority-revoked", "This Project's folder changed, so its page closed.");
    }
    switch (command.kind) {
      case "current":
        return this.#view(command.projectId, authority.mode, await this.#peek(owned));
      case "stop":
        if (owned !== undefined) await this.#close(owned, "stopped");
        return this.#view(command.projectId, authority.mode, undefined);
      case "open":
        return this.#open(windowId, command.projectId, authority, command.url, owned);
    }
  }

  /**
   * Close every page of a Project that is no longer what it was opened
   * against: archived, or relinked to another root.
   */
  async settleProject(projectId: ProjectId): Promise<void> {
    const project = this.#options.readProject(projectId);
    const current =
      project !== undefined && project.type !== "chat" && project.lifecycle === "active"
        ? project.bindingHistory.at(-1)?.revisionId
        : undefined;
    const closing: Array<Promise<void>> = [];
    for (const owned of this.#pages.values()) {
      if (String(owned.projectId) !== String(projectId)) continue;
      if (current !== undefined && String(current) === String(owned.bindingRevisionId)) continue;
      closing.push(this.#close(owned, "stopped"));
    }
    await Promise.allSettled(closing);
  }

  /** Close every page a window opened; its authority ended with it. */
  async revokeWindow(windowId: WindowId): Promise<void> {
    const closing = [...this.#pages.values()]
      .filter((owned) => String(owned.windowId) === String(windowId))
      .map((owned) => this.#close(owned, "stopped"));
    await Promise.allSettled(closing);
  }

  close(): void {
    this.#removeProcessExitListener?.();
    for (const owned of this.#pages.values()) {
      owned.abort.abort();
      owned.cancelExpiry?.();
    }
    this.#pages.clear();
  }

  async #open(
    windowId: WindowId,
    projectId: ProjectId,
    authority: Extract<Authority, { readonly kind: "allowed" }>,
    url: string,
    existing: OwnedPage | undefined,
  ): Promise<ProjectBrowserResult> {
    const target = webAddress(url);
    if (target === undefined) {
      return refused("invalid", "Only http and https addresses open in a Project browser.");
    }
    // A live page on the same site takes the new address. Another site starts
    // a fresh isolated context: its allowlist is the site it was opened for,
    // and the person browsing onward from there widens only their own view.
    if (
      existing !== undefined &&
      existing.state === "active" &&
      existing.origin === target.origin
    ) {
      return this.#navigate(existing, target.href);
    }
    if (existing !== undefined) await this.#close(existing, "stopped");
    if (!(await this.#options.runtime.available())) {
      return refused("unavailable", "No browser runtime is available on this host.");
    }
    const contextId = decodeBrowserContextId(this.#options.uuid());
    const subjectId = projectBrowserSubjectId(projectId);
    const owned: OwnedPage = {
      windowId,
      projectId,
      mode: authority.mode,
      subjectId,
      bindingRevisionId: authority.bindingRevisionId,
      contextId,
      origin: target.origin,
      abort: new AbortController(),
      state: "creating",
      presentation: undefined,
      page: undefined,
      peekedAt: undefined,
      cancelExpiry: undefined,
    };
    this.#pages.set(key(windowId, projectId), owned);
    const policy: BrowserContextPolicy = {
      profileMode: "isolated",
      allowedOrigins: [target.origin],
      credentialFieldProtection: true,
      maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
      sessionTimeoutMs: PROJECT_BROWSER_SESSION_MS,
    };
    try {
      const presentation = await this.#options.runtime.createContext(
        contextId,
        policy,
        owned.abort.signal,
        { windowId, threadId: subjectId },
      );
      owned.presentation = presentation === undefined ? undefined : presentation;
    } catch {
      this.#forget(owned, "failed");
      await this.#options.runtime.closeContext(contextId).catch(() => undefined);
      return refused(
        "unavailable",
        "The host could not open an isolated browser for this Project.",
      );
    }
    if (owned.abort.signal.aborted) {
      await this.#options.runtime.closeContext(contextId).catch(() => undefined);
      return refused("unavailable", "The page closed while it was opening.");
    }
    owned.state = "active";
    owned.cancelExpiry = this.#schedule(PROJECT_BROWSER_SESSION_MS, () => {
      void this.#close(owned, "expired");
    });
    return this.#navigate(owned, target.href);
  }

  async #navigate(owned: OwnedPage, href: string): Promise<ProjectBrowserResult> {
    try {
      const observed = await this.#options.runtime.act(
        owned.contextId,
        { kind: "navigate", target: href },
        owned.abort.signal,
      );
      owned.page = pageFrom(observed);
      owned.peekedAt = this.#options.now();
    } catch {
      // The context stays open; the person can try another address or close it.
      return refused("unavailable", "The page did not open.");
    }
    return this.#view(owned.projectId, owned.mode, owned);
  }

  /**
   * A fresh picture of a page only the host can see. A native view is on the
   * person's screen already and needs none; a headless page is shown as a
   * picture, taken no more often than the interval.
   */
  async #peek(owned: OwnedPage | undefined): Promise<OwnedPage | undefined> {
    if (owned === undefined || owned.state !== "active") return owned;
    const peek = this.#options.runtime.peek;
    if (owned.presentation === "native-live" || peek === undefined) return owned;
    const now = this.#options.now();
    if (owned.peekedAt !== undefined && now - owned.peekedAt < PEEK_INTERVAL_MS) return owned;
    try {
      owned.page = pageFrom(
        await peek.call(this.#options.runtime, owned.contextId, owned.abort.signal),
      );
      owned.peekedAt = now;
    } catch {
      // The last picture stands.
    }
    return owned;
  }

  #authority(windowId: WindowId, projectId: ProjectId): Authority {
    const project = this.#options.readProject(projectId);
    if (project === undefined || project.type === "chat") {
      return {
        kind: "refused",
        reason: "unavailable",
        message: "Only a Work or Code Project has a Project browser.",
      };
    }
    if (project.lifecycle !== "active") {
      return {
        kind: "refused",
        reason: "authority-revoked",
        message: "This Project is archived, so its page closed.",
      };
    }
    if (!this.#options.canAccessProject(windowId, projectId, project.type)) {
      return {
        kind: "refused",
        reason: "unauthorized",
        message: "Open this Project in this window to use its browser.",
      };
    }
    const revision = project.bindingHistory.at(-1);
    if (revision === undefined) {
      return {
        kind: "refused",
        reason: "unavailable",
        message: "This Project has no folder bound.",
      };
    }
    return { kind: "allowed", mode: project.type, bindingRevisionId: revision.revisionId };
  }

  async #close(owned: OwnedPage, state: "stopped" | "expired"): Promise<void> {
    this.#forget(owned, state);
    await this.#options.runtime.closeContext(owned.contextId).catch(() => undefined);
  }

  #forget(owned: OwnedPage, state: BrowserContextState): void {
    owned.abort.abort();
    owned.cancelExpiry?.();
    owned.cancelExpiry = undefined;
    owned.state = state;
    const current = this.#pages.get(key(owned.windowId, owned.projectId));
    if (current === owned) this.#pages.delete(key(owned.windowId, owned.projectId));
  }

  #view(
    projectId: ProjectId,
    mode: ProjectBrowserMode,
    owned: OwnedPage | undefined,
  ): ProjectBrowserResult {
    return decodeProjectBrowserResult({
      kind: "project-browser",
      browser: {
        projectId,
        mode,
        subjectId: projectBrowserSubjectId(projectId),
        ...(owned === undefined
          ? {}
          : {
              context: {
                contextId: owned.contextId,
                state: owned.state,
                ...(owned.presentation === undefined ? {} : { presentation: owned.presentation }),
              },
              ...(owned.page === undefined ? {} : { page: owned.page }),
            }),
      },
    });
  }
}

function key(windowId: WindowId, projectId: ProjectId): string {
  return `${String(windowId)}\0${String(projectId)}`;
}

function webAddress(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pageFrom(observed: BrowserRuntimeObservation): ProjectBrowserPage {
  return {
    ...(observed.url === undefined || observed.url === ""
      ? {}
      : { url: observed.url.slice(0, 4096) }),
    ...(observed.title === undefined ? {} : { title: observed.title.slice(0, 1024) }),
    // A picture past the bound is dropped rather than cut: half an image is
    // not a smaller image.
    ...(observed.screenshotDataUrl === undefined ||
    observed.screenshotDataUrl.length > MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS
      ? {}
      : { screenshotDataUrl: observed.screenshotDataUrl }),
  };
}

function refused(reason: ProjectBrowserRefusalReason, message: string): ProjectBrowserResult {
  return { kind: "project-browser-refused", reason, message };
}

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
