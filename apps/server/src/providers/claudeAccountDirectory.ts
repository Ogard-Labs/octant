/**
 * Claude's SDK reads the account directory from process.env during
 * `listSessions`. Isolated resume overlays that directory for the
 * duration of one lookup. Every other Claude consumer that would
 * snapshot `process.env` must take that snapshot through this gate so
 * a concurrent default launch cannot inherit the overlay.
 */

let gate: Promise<void> = Promise.resolve();

export function withClaudeAccountDirectory<T>(
  configDirectory: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const next = gate.then(async () => {
    if (configDirectory === undefined) return await run();
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousSecure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDirectory;
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDirectory;
    try {
      return await run();
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      if (previousSecure === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = previousSecure;
    }
  });
  gate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Copy `process.env` when no isolated lookup is overlaying Claude's directory. */
export function snapshotClaudeHostEnvironment(): Promise<NodeJS.ProcessEnv> {
  return withClaudeAccountDirectory(undefined, async () => ({ ...process.env }));
}
