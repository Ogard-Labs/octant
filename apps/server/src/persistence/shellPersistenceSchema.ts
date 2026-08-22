import {
  decodeWorkspaceTab,
  DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE,
  EnvironmentPresentationReplaced,
  ShellSettings,
  ShellSettingsReplaced,
  WindowWorkspace,
  WorkspaceLayoutReplaced,
} from "@octant/contracts";
import { Schema } from "effect";

const PersistedShellSettings = Schema.transform(Schema.Unknown, ShellSettings, {
  strict: false,
  decode: upcastPersistedShellSettings,
  encode: (_encoded, settings) => settings,
});

export const PersistedShellSettingsReplaced = Schema.transform(
  Schema.Unknown,
  ShellSettingsReplaced,
  {
    strict: false,
    decode: upcastPersistedShellSettingsEvent,
    encode: (_encoded, event) => event,
  },
);

const PersistedWindowWorkspace = Schema.transform(Schema.Unknown, WindowWorkspace, {
  strict: false,
  decode: sanitizePersistedWorkspace,
  encode: (_encoded, workspace) => workspace,
});

export const PersistedWorkspaceLayoutReplaced = Schema.transform(
  Schema.Unknown,
  WorkspaceLayoutReplaced,
  {
    strict: false,
    decode: sanitizePersistedWorkspaceEvent,
    encode: (_encoded, event) => event,
  },
);

export const PersistedEnvironmentPresentationReplaced = Schema.transform(
  Schema.Unknown,
  EnvironmentPresentationReplaced,
  {
    strict: false,
    decode: upcastPersistedEnvironmentPresentationEvent,
    encode: (_encoded, event) => event,
  },
);

export const decodePersistedShellSettings = Schema.decodeUnknownSync(PersistedShellSettings);
export const decodePersistedShellSettingsReplaced = Schema.decodeUnknownSync(
  PersistedShellSettingsReplaced,
);
export const decodePersistedWindowWorkspace = Schema.decodeUnknownSync(PersistedWindowWorkspace);
export const decodePersistedWorkspaceLayoutReplaced = Schema.decodeUnknownSync(
  PersistedWorkspaceLayoutReplaced,
);
export const decodePersistedEnvironmentPresentationReplaced = Schema.decodeUnknownSync(
  PersistedEnvironmentPresentationReplaced,
);

function upcastPersistedShellSettingsEvent(value: unknown): unknown {
  if (!isRecord(value) || !("settings" in value)) return value;
  return { ...value, settings: upcastPersistedShellSettings(value.settings) };
}

function upcastPersistedShellSettings(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // Every version that knows about first-run onboarding writes the field, so
  // a persisted document without it comes from a host that ran Octant before
  // onboarding shipped — a host that has definitionally completed first run.
  // Stamping `completed` here keeps the schema-level `pending` default for
  // what it is for: a genuinely new store, whose settings are first written
  // through the domain default. Without the stamp every upgraded store would
  // decode as `pending` and re-run the first-run walkthrough.
  const withFirstRunOnboarding =
    "firstRunOnboarding" in value ? value : { ...value, firstRunOnboarding: "completed" };
  const withContextSettings =
    "contextSidebarWidth" in withFirstRunOnboarding ||
    "lastContextSurface" in withFirstRunOnboarding
      ? withFirstRunOnboarding
      : { ...withFirstRunOnboarding, contextSidebarWidth: 360, lastContextSurface: null };
  const withModeSwitcher =
    "modeSwitcherPresentation" in withContextSettings
      ? withContextSettings
      : { ...withContextSettings, modeSwitcherPresentation: "buttons" };
  const withSidebarBackground =
    "sidebarBackground" in withModeSwitcher
      ? withModeSwitcher
      : {
          ...withModeSwitcher,
          sidebarBackground: {
            kind: "none",
            overlayColor: "#1a1a1c",
            overlayOpacity: 100,
            vibrancyMode: "off",
          },
        };
  return {
    ...withSidebarBackground,
    // Open or closed is renderer state. Stored floating, pinned, or hidden
    // presentation is dropped before decode rather than restored as a panel.
    environmentPresentationByMode: DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE,
  };
}

function upcastPersistedEnvironmentPresentationEvent(value: unknown): unknown {
  if (!isRecord(value) || !("presentation" in value)) return value;
  return { ...value, presentation: upcastPersistedEnvironmentPresentation(value.presentation) };
}

function upcastPersistedEnvironmentPresentation(_value: unknown): unknown {
  return {
    byTab: [],
    byMode: DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE,
  };
}

function sanitizePersistedWorkspaceEvent(value: unknown): unknown {
  if (!isRecord(value) || !("workspace" in value)) return value;
  return { ...value, workspace: sanitizePersistedWorkspace(value.workspace) };
}

/**
 * Upcast persisted workspaces into the pane model. A leaf journaled as a tab
 * group collapses to one pane showing the group's active tab — background
 * tabs are deliberately lost; the group's id survives as the pane's, and the
 * renamed top-level fields (`activeGroupIds`, `focusedGroupId`, a stowed
 * entry's `activeGroupId`) carry over under their pane names so restore keeps
 * the same view in front.
 */
function sanitizePersistedWorkspace(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.layouts)) return value;
  const layouts = {
    chat: sanitizeLayout(value.layouts.chat, "chat"),
    work: sanitizeLayout(value.layouts.work, "work"),
    code: sanitizeLayout(value.layouts.code, "code"),
  };
  const contextByMode = isRecord(value.contextByMode)
    ? {
        chat: sanitizeContextKey(value.contextByMode.chat, "chat"),
        work: sanitizeContextKey(value.contextByMode.work, "work"),
        code: sanitizeContextKey(value.contextByMode.code, "code"),
      }
    : {
        chat: defaultContextKey("chat"),
        work: defaultContextKey("work"),
        code: defaultContextKey("code"),
      };
  // The result is built explicitly rather than spread from the input: the wire
  // schema rejects excess properties, so the legacy tab-group field names must
  // not survive into the decoded document.
  const result: Record<string, unknown> = {
    windowId: value.windowId,
    activeMode: value.activeMode,
    layouts,
    contextByMode,
    activePaneIds: value.activePaneIds ??
      value.activeGroupIds ?? {
        chat: firstPersistedPaneId(layouts.chat),
        work: firstPersistedPaneId(layouts.work),
        code: firstPersistedPaneId(layouts.code),
      },
    version: value.version,
  };
  const focusedPaneId = value.focusedPaneId ?? value.focusedGroupId;
  if (focusedPaneId !== undefined) result.focusedPaneId = focusedPaneId;
  if (Array.isArray(value.stowedLayouts)) {
    result.stowedLayouts = value.stowedLayouts.map((entry) => sanitizeStowedLayout(entry));
  }
  return result;
}

function sanitizeStowedLayout(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const mode =
    isRecord(value.context) && isPersistedMode(value.context.mode) ? value.context.mode : undefined;
  if (mode === undefined) return value;
  const layout = sanitizeLayout(value.layout, mode);
  return {
    context: sanitizeContextKey(value.context, mode),
    layout,
    activePaneId: value.activePaneId ?? value.activeGroupId ?? firstPersistedPaneId(layout),
  };
}

function isPersistedMode(value: unknown): value is "chat" | "work" | "code" {
  return value === "chat" || value === "work" || value === "code";
}

function defaultContextKey(mode: "chat" | "work" | "code"): unknown {
  return { host: "local", mode, projectId: null, boundRoot: null };
}

function sanitizeContextKey(value: unknown, mode: "chat" | "work" | "code"): unknown {
  if (!isRecord(value)) return defaultContextKey(mode);
  return {
    host: typeof value.host === "string" && value.host.trim().length > 0 ? value.host : "local",
    mode,
    projectId: value.projectId ?? null,
    boundRoot: value.boundRoot ?? null,
  };
}

function firstPersistedPaneId(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (value.kind === "pane") return value.paneId;
  if (value.kind === "group") return value.groupId;
  return value.kind === "split" ? firstPersistedPaneId(value.first) : undefined;
}

function sanitizeLayout(value: unknown, mode: "chat" | "work" | "code"): unknown {
  if (!isRecord(value)) return value;
  if (value.kind === "split") {
    return {
      ...value,
      first: sanitizeLayout(value.first, mode),
      second: sanitizeLayout(value.second, mode),
    };
  }
  if (value.kind === "pane") {
    return {
      kind: "pane",
      nodeId: value.nodeId,
      paneId: value.paneId,
      surface: sanitizeSurface(value.surface, mode),
    };
  }
  if (value.kind !== "group" || !Array.isArray(value.tabs)) return value;
  // A tab-group leaf collapses to one pane showing its active tab; background
  // tabs are deliberately lost. A group with no usable tab renders the mode's
  // welcome surface, reusing the group's uuid as the surface id so the pane
  // keeps a stable identity.
  const active =
    value.tabs.find((tab) => isRecord(tab) && tab.id === value.activeTabId) ??
    value.tabs.find(isRecord);
  return {
    kind: "pane",
    nodeId: value.nodeId,
    paneId: value.groupId,
    surface:
      active === undefined
        ? welcomePersistedSurface(mode, value.groupId)
        : sanitizeSurface(active, mode),
  };
}

function sanitizeSurface(value: unknown, mode: "chat" | "work" | "code"): unknown {
  if (!isRecord(value) || typeof value.kind !== "string") return value;
  const welcomeInPlace = () => welcomePersistedSurface(mode, value.id);
  if (value.kind === "draft-thread") {
    if (value.mode !== mode) return welcomeInPlace();
    return decodeOrWelcome(value, welcomeInPlace);
  }
  if (value.kind === "work-thread") {
    if (mode !== "work") return welcomeInPlace();
    return decodeOrWelcome(value, welcomeInPlace);
  }
  if (value.kind === "chat-thread") {
    if (mode !== "chat") return welcomeInPlace();
    return decodeOrWelcome(value, welcomeInPlace);
  }
  if (value.kind.startsWith("code-")) {
    if (mode !== "code") return welcomeInPlace();
    // Review now lives in the dock. A restored full-window diff becomes the
    // thread itself so the transcript stays in the pane.
    if (value.kind === "code-diff") {
      const { relativePath: _relativePath, ...rest } = value;
      return decodeOrWelcome({ ...rest, kind: "code-overview" }, welcomeInPlace);
    }
    return decodeOrWelcome(value, welcomeInPlace);
  }
  if (value.kind === "browser" || value.kind === "files") {
    if (mode === "chat") return welcomeInPlace();
    return decodeOrWelcome(value, welcomeInPlace);
  }
  if (value.kind === "side-chat" || value.kind === "preview") {
    return decodeOrWelcome(value, welcomeInPlace);
  }
  if (value.kind === "canvas") {
    // Canvas tabs briefly persisted a tab-strip `pinned` ordering flag; the
    // pane model has no strip, so the flag is dropped on decode.
    const { pinned: _pinned, ...withoutPin } = value;
    return decodeOrWelcome(withoutPin, welcomeInPlace);
  }
  if (["welcome", "settings", "project"].includes(value.kind)) return value;
  // Unknown kinds and the retired `unavailable` placeholder both render the
  // mode's welcome surface in place: a pane never shows a dead view.
  return welcomeInPlace();
}

function decodeOrWelcome(value: Record<string, unknown>, fallback: () => unknown): unknown {
  try {
    return decodeWorkspaceTab(value);
  } catch {
    return fallback();
  }
}

// Persistence upcasts operate on untyped JSON before any schema decode, so the
// welcome surface is built raw here; the copy mirrors the domain's mode titles.
const WELCOME_TITLES = {
  chat: "Welcome to Chat",
  work: "Welcome to Work",
  code: "Welcome to Code",
} as const;

function welcomePersistedSurface(mode: "chat" | "work" | "code", id: unknown): unknown {
  return { kind: "welcome", id, mode, title: WELCOME_TITLES[mode] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
