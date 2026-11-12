let guarded = false;

/**
 * Writes one line to standard error and never throws. A closed terminal or
 * pipe fails the write synchronously or, more often, as an asynchronous EPIPE
 * 'error' event; unhandled, that becomes an uncaught exception and Electron's
 * own blocking error dialog on the failure path this is meant to report.
 */
export function writeDiagnostic(line: string): void {
  try {
    if (!guarded) {
      guarded = true;
      process.stderr.on("error", () => undefined);
    }
    process.stderr.write(`${line}\n`, () => undefined);
  } catch {
    // Nothing is left to report to when stderr is closed.
  }
}
