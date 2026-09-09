# 0092. The terminal reads the shell's own configuration

**Status:** Accepted

## Context

A Code thread's terminal runs the person's shell inside the thread's Seatbelt
confinement (0009): reads are the bound root, the shell's own state directory,
a private temp, and the shell binary's directory, and the rest of the home is
enumerated as denied. That kept the shell from reading credentials, but it
also kept it from reading `~/.zshrc`, `~/.zprofile`, and whatever they source,
so every terminal opened as a bare `%m%#` prompt with a PATH assembled by
nothing. Beside the platform's own terminal and the peer workspaces the
maintainer compared it to on 2026-09-07 — each of which opens the person's
shell as it is — it read as a broken terminal rather than a safe one.

## Decision

The maintainer chose, on 2026-09-07, to let the terminal read the shell's own
configuration.

- **Named, read-only, and only these.** The launch adds to its read roots the
  shell's rc and login files, the frameworks and prompts they source, and the
  tool hooks a rc commonly loads, each named in
  `apps/server/src/code/terminalProcessPort.ts` and included only when it
  exists. Nothing else in the home is granted; the enumerated denial of the
  rest stands, and writes stay confined to the bound root and the shell's own
  state directory (history, caches). A credential file that shares a
  directory with a hook is why the hook's file is named, never its directory.
- **A login shell.** The shell starts with `-l`, as the platform's terminal
  starts one, so the login files that assemble PATH run.
- **A path a rc sources that is not on the list fails at the prompt** where it
  can be read as a permission error, rather than the grant widening on its
  own. Adding a path is a change to the list and to this record's spirit:
  read-only, configuration, no credentials.
- **Linux is unchanged.** Under 0057 the shell's HOME is replaced by its state
  directory and a minimal rc; this record is the macOS Seatbelt path.

## Consequences

- The person's prompt, aliases, completions, and PATH are their own.
- A rc that exports a secret into the environment exports it into this
  terminal too. That is the person's own configuration doing what it does in
  every terminal they open; the confinement still denies the files the secret
  usually lives in.
- The read-root list is a place to keep small. Reviewers should refuse a
  directory that could hold a token where a single file would do.
