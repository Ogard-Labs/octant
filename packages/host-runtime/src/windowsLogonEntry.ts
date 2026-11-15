import { execFile } from "node:child_process";
import { win32 } from "node:path";

/** The per-user Run key holding the logon entry `octant` writes on Windows. */
export const WINDOWS_LOGON_ENTRY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_LOGON_ENTRY_VALUE = "Octant";

/** A drive-absolute, normalized Windows folder with no quote or line break. */
export function isWindowsSystemRoot(value: string): boolean {
  return (
    /^[A-Za-z]:\\[^"]*$/.test(value) &&
    !["\0", "\r", "\n"].some((character) => value.includes(character)) &&
    win32.normalize(value) === value
  );
}

/** Whether `reg.exe query` output names a non-empty `Octant` string value. */
export function windowsLogonEntryPresent(queryOutput: string): boolean {
  return new RegExp(`^\\s+${WINDOWS_LOGON_ENTRY_VALUE}\\s+REG_SZ\\s+\\S`, "m").test(queryOutput);
}

export type WindowsLogonEntryQuery = () => Promise<
  { readonly status: "present" | "absent" } | { readonly status: "failed" }
>;

/**
 * The host's automatic-startup policy on Windows, read from the logon entry
 * the CLI writes, so Settings and `octant server status` report the same
 * thing. The host never writes the entry: only the CLI knows the command it
 * records, so `setEnabled` refuses and the lifecycle controls name the CLI.
 */
export function createWindowsLogonEntryPolicy(options: {
  readonly systemRoot: string;
  readonly query?: WindowsLogonEntryQuery;
  readonly now?: () => string;
}) {
  const query = options.query ?? regQuery(options.systemRoot);
  const now = options.now ?? (() => new Date().toISOString());
  return {
    supervisor: "logon-entry" as const,
    read: async () => {
      const result = await query();
      if (result.status === "failed") throw new Error("The Windows logon entry could not be read.");
      return { enabled: result.status === "present", updatedAt: now() };
    },
    setEnabled: async (): Promise<never> => {
      throw new Error("The Windows logon entry changes only through `octant server`.");
    },
  };
}

function regQuery(systemRoot: string): WindowsLogonEntryQuery {
  return () =>
    new Promise((resolve) => {
      if (!isWindowsSystemRoot(systemRoot)) {
        resolve({ status: "failed" });
        return;
      }
      execFile(
        win32.join(systemRoot, "System32", "reg.exe"),
        ["query", WINDOWS_LOGON_ENTRY_KEY, "/v", WINDOWS_LOGON_ENTRY_VALUE],
        { shell: false, timeout: 5_000, maxBuffer: 64 * 1_024, windowsHide: true },
        (error, stdout) => {
          // reg.exe exits 1 for a value that is not there.
          if (error !== null)
            resolve(
              "code" in error && error.code === 1 ? { status: "absent" } : { status: "failed" },
            );
          else resolve({ status: windowsLogonEntryPresent(stdout) ? "present" : "absent" });
        },
      );
    });
}
