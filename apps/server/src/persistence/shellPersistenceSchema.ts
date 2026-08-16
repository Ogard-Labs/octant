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

export const UNAVAILABLE_PERSISTED_TAB_REASON =
  "This tab type is unavailable in this version of Octant.";

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
  if ("environmentPresentationByMode" in withSidebarBackground) return withSidebarBackground;
  return {
    ...withSidebarBackground,
    environmentPresentationByMode: DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE,
  };
}

function upcastPersistedEnvironmentPresentationEvent(value: unknown): unknown {
  if (!isRecord(value) || !("presentation" in value)) return value;
  return { ...value, presentation: upcastPersistedEnvironmentPresentation(value.presentation) };
}

function upcastPersistedEnvironmentPresentation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const byMode =
    "byMode" in value && isRecord(value.byMode)
      ? value.byMode
      : DEFAULT_ENVIRONMENT_PRESENTATION_BY_MODE;
  const byTab = "byTab" in value && Array.isArray(value.byTab) ? value.byTab : [];
  return { byTab, byMode };
}

function sanitizePersistedWorkspaceEvent(value: unknown): unknown {
  if (!isRecord(value) || !("workspace" in value)) return value;
  return { ...value, workspace: sanitizePersistedWorkspace(value.workspace) };
}

function sanitizePersistedWorkspace(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.layouts)) return value;
  const layouts = {
    ...value.layouts,
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
  return {
    ...value,
    layouts,
    contextByMode,
    activeGroupIds:
      "activeGroupIds" in value
        ? value.activeGroupIds
        : {
            chat: firstPersistedGroupId(layouts.chat),
            work: firstPersistedGroupId(layouts.work),
            code: firstPersistedGroupId(layouts.code),
          },
  };
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

function firstPersistedGroupId(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (value.kind === "group") return value.groupId;
  return value.kind === "split" ? firstPersistedGroupId(value.first) : undefined;
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
  if (value.kind !== "group" || !Array.isArray(value.tabs)) return value;
  return { ...value, tabs: value.tabs.map((tab) => sanitizeTab(tab, mode)) };
}

function sanitizeTab(value: unknown, mode: "chat" | "work" | "code"): unknown {
  if (!isRecord(value) || typeof value.kind !== "string") return value;
  if (value.kind === "draft-thread") {
    if (value.mode !== mode) return unavailablePersistedTab(value);
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (value.kind === "work-thread") {
    if (mode !== "work") return unavailablePersistedTab(value);
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (value.kind === "chat-thread") {
    if (mode !== "chat") return unavailablePersistedTab(value);
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (value.kind.startsWith("code-")) {
    if (mode !== "code") return unavailablePersistedTab(value);
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (value.kind === "browser" || value.kind === "files") {
    if (mode === "chat") return unavailablePersistedTab(value);
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (value.kind === "side-chat") {
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (value.kind === "preview") {
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (value.kind === "canvas") {
    try {
      return decodeWorkspaceTab(value);
    } catch {
      return unavailablePersistedTab(value);
    }
  }
  if (["welcome", "settings", "project", "unavailable"].includes(value.kind)) return value;
  return unavailablePersistedTab(value);
}

function unavailablePersistedTab(value: Record<string, unknown>): unknown {
  if (!validTitle(value.title)) return value;
  return {
    kind: "unavailable",
    id: value.id,
    title: value.title,
    reason: UNAVAILABLE_PERSISTED_TAB_REASON,
  };
}

function validTitle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
