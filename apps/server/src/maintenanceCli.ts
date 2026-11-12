import { runDatabaseCli } from "./dbCli";

// The one entry for offline store maintenance: the `db:*` scripts run it from
// source, and the packaged app runs its built copy from the desktop recovery
// screen when the host refuses to start. Keeping it apart from `dbCli.ts`
// means bundling the commands elsewhere can never run them on import.
process.exitCode = await runDatabaseCli(process.argv.slice(2));
