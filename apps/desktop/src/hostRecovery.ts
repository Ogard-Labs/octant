/**
 * The recovery screen the desktop shows when its local host refuses to start.
 *
 * The host prints one fixed JSON line when it refuses (`startupFailedOutput`
 * in the server). This module reads that line, decides in plain words what is
 * wrong, and offers only actions that are safe for that refusal. Every action
 * runs through the server's own offline store maintenance, so authority and
 * data-integrity rules stay where they are; the desktop decides only what to
 * offer. Nothing here deletes data: a restore replaces the store only after
 * the person confirms it in a separate native dialog.
 */

export type HostStoreRecovery = "store-damaged" | "removal-unfinished";

export interface HostStartupRefusal {
  readonly category: string;
  readonly message: string;
  readonly recovery?: HostStoreRecovery;
}

export type HostRecoveryAction = "rebuild" | "restore" | "retry" | "quit" | "export";

export interface HostRecoveryScreen {
  readonly heading: string;
  readonly explanation: string;
  readonly detail: string;
  readonly actions: ReadonlyArray<HostRecoveryAction>;
}

export interface HostRecoveryOutcome {
  readonly status: "repaired" | "refused" | "saved";
  readonly message: string;
}

const RECOVERY_SCHEME = "octant-recovery:";

/**
 * Finds the refusal line in a failed start's last output. The output is the
 * redacted stderr tail the desktop already keeps; any line that is not the
 * host's own refusal record is ignored, so a crash that printed nothing usable
 * keeps the plain error dialog.
 */
export function readHostStartupRefusal(error: unknown): HostStartupRefusal | undefined {
  if (!(error instanceof Error)) return undefined;
  const lines = error.message.split("\n").reverse();
  for (const line of lines) {
    const refusal = decodeRefusalLine(line.trim());
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function decodeRefusalLine(line: string): HostStartupRefusal | undefined {
  if (!line.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.product !== "Octant" || record.status !== "failed") return undefined;
  if (typeof record.category !== "string" || typeof record.message !== "string") return undefined;
  const recovery =
    record.recovery === "store-damaged" || record.recovery === "removal-unfinished"
      ? record.recovery
      : undefined;
  return {
    category: record.category,
    message: record.message,
    ...(recovery === undefined ? {} : { recovery }),
  };
}

export function hostRecoveryScreenFor(refusal: HostStartupRefusal): HostRecoveryScreen {
  const detail = refusal.message;
  if (refusal.category === "recovery-required" && refusal.recovery === "removal-unfinished") {
    return {
      heading: "Octant's data removal did not finish",
      explanation:
        "An earlier request to remove all local data stopped partway. Octant will not start over a half-removed store, and it will not rebuild or restore over it either, so nothing you asked to remove comes back.",
      detail,
      actions: ["retry", "quit"],
    };
  }
  if (refusal.category === "recovery-required") {
    return {
      heading: "Octant's local data needs repair",
      explanation:
        "Octant keeps a full history of your work and builds what you see from it. It already tried rebuilding from that history at startup, and something is still wrong. Nothing has been deleted. You can rebuild again, or put back the last backup Octant verified.",
      detail,
      actions: ["rebuild", "restore", "retry", "quit"],
    };
  }
  if (refusal.category === "migration-incompatible") {
    return {
      heading: "This data belongs to a different Octant version",
      explanation:
        "Octant's data was written by a version this app cannot use, or its upgrade history does not match. Nothing has been changed. Install the latest Octant and open it again.",
      detail,
      actions: ["retry", "quit"],
    };
  }
  if (refusal.category === "storage-busy") {
    return {
      heading: "Octant's data is busy",
      explanation:
        "Another program is using Octant's data right now. Close it, then try again. Nothing has been changed.",
      detail,
      actions: ["retry", "quit"],
    };
  }
  if (refusal.category === "storage-unavailable") {
    return {
      heading: "Octant cannot reach its data",
      explanation:
        "Octant could not read or write its data folder. Check that the disk has free space and that the folder belongs to you, then try again. Nothing has been changed.",
      detail,
      actions: ["retry", "quit"],
    };
  }
  return {
    heading: "Octant could not start",
    explanation:
      "Octant's local server stopped before it was ready. Nothing has been changed. Try again, and if it keeps happening, quit and reopen Octant.",
    detail,
    actions: ["retry", "quit"],
  };
}

/** The offline maintenance arguments each repair runs, after any confirmation. */
export function hostMaintenanceArguments(
  action: "rebuild" | "restore",
): ReadonlyArray<"rebuild" | "restore" | "--confirm"> {
  return action === "rebuild" ? ["rebuild"] : ["restore", "--confirm"];
}

export function hostMaintenanceSpawnSpec(options: {
  readonly packaged: boolean;
  readonly root: string;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly action: "rebuild" | "restore";
}): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const commandArguments = hostMaintenanceArguments(options.action);
  if (!options.packaged) {
    return {
      command: "bun",
      args: [
        "run",
        "--cwd",
        `${options.root}/apps/server`,
        "src/maintenanceCli.ts",
        ...commandArguments,
      ],
      env: options.env,
    };
  }
  return {
    command: options.execPath,
    args: [`${options.root}/apps/server/dist/dbMaintenance.mjs`, ...commandArguments],
    env: { ...options.env, ELECTRON_RUN_AS_NODE: "1", OCTANT_PACKAGED_RUNTIME: "1" },
  };
}

/**
 * Turns a maintenance run into what the screen says. The maintenance command
 * prints only fixed, secret-free messages, so its refusal message is shown as
 * it is; anything unrecognized becomes one generic sentence.
 */
export function describeHostMaintenanceOutcome(
  action: "rebuild" | "restore",
  exitCode: number | null,
  stderr: string,
): HostRecoveryOutcome {
  if (exitCode === 0) {
    return {
      status: "repaired",
      message:
        action === "rebuild"
          ? "Octant rebuilt its data from its history. Start Octant to continue."
          : "Octant put back its last verified backup. Start Octant to continue.",
    };
  }
  return { status: "refused", message: maintenanceRefusalMessage(action, stderr) };
}

function maintenanceRefusalMessage(action: "rebuild" | "restore", stderr: string): string {
  try {
    const parsed: unknown = JSON.parse(stderr);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = parsed.error;
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        return error.message;
      }
    }
  } catch {
    // Not the maintenance command's own report; fall through to the fixed copy.
  }
  return action === "rebuild"
    ? "Octant could not rebuild its data. Nothing was changed."
    : "Octant could not restore its backup. Nothing was changed.";
}

export function hostRecoveryActionUrl(action: HostRecoveryAction): string {
  return `${RECOVERY_SCHEME}//${action}`;
}

export function decodeHostRecoveryAction(url: string): HostRecoveryAction | undefined {
  if (!url.startsWith(RECOVERY_SCHEME)) return undefined;
  const action = url.slice(RECOVERY_SCHEME.length).replace(/^\/\//, "");
  return action === "rebuild" ||
    action === "restore" ||
    action === "retry" ||
    action === "quit" ||
    action === "export"
    ? action
    : undefined;
}

const ACTION_LABELS: Readonly<Record<HostRecoveryAction, string>> = {
  rebuild: "Rebuild from history",
  restore: "Restore last backup…",
  retry: "Start Octant",
  quit: "Quit",
  export: "Save support bundle…",
};

/**
 * A static document with no script: each action is a link the main process
 * intercepts, so the page itself can do nothing but ask. Saving a support
 * bundle is offered on every screen, after the screen's own actions: it reads
 * and changes nothing in the store.
 */
export function renderHostRecoveryDocument(
  screen: HostRecoveryScreen,
  state: { readonly busy?: boolean; readonly outcome?: HostRecoveryOutcome } = {},
): string {
  const actions =
    state.busy === true
      ? `<p role="status">Working… This can take a minute on a large history.</p>`
      : [...screen.actions.filter((action) => action !== "export"), "export" as const]
          .map(
            (action, index) =>
              `<a class="button${index === 0 ? " primary" : ""}" href="${hostRecoveryActionUrl(action)}">${escapeHtml(ACTION_LABELS[action])}</a>`,
          )
          .join("");
  const outcome =
    state.outcome === undefined
      ? ""
      : `<p class="outcome ${state.outcome.status}" role="status">${escapeHtml(state.outcome.message)}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Octant recovery</title>
<style>
:root { color-scheme: light dark; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; padding: 28px 32px; background: Canvas; color: CanvasText; }
h1 { font-size: 17px; font-weight: 600; margin: 0 0 12px; }
p { margin: 0 0 12px; max-width: 520px; }
.detail { color: GrayText; font-size: 12px; }
.outcome.refused { color: #c0392b; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.button { padding: 5px 14px; border-radius: 6px; border: 1px solid ButtonBorder; background: ButtonFace; color: ButtonText; text-decoration: none; }
.button.primary { background: AccentColor; color: AccentColorText; border-color: AccentColor; }
.button:focus-visible { outline: 2px solid AccentColor; outline-offset: 2px; }
</style></head>
<body><main>
<h1>${escapeHtml(screen.heading)}</h1>
<p>${escapeHtml(screen.explanation)}</p>
<p class="detail">${escapeHtml(screen.detail)}</p>
${outcome}
<div class="actions">${actions}</div>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
