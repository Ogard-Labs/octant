---
description: Project-wide type errors and go to definition in the Code editor, from a confined language server, and how to turn them off.
---

# Language Services

When you open a TypeScript or JavaScript file in a Code thread, the editor
shows the Project's real type errors and lets you jump to a definition in
another file of the same checkout. The analysis comes from the TypeScript
language server that ships with Octant, which the host runs for that checkout.

## What you see

- **Problems.** Errors and warnings are underlined in the editor, and hovering
  one shows the server's message. A line under the file's toolbar counts them,
  or says **No problems found**. These are the Project's errors: the server
  reads your `tsconfig`, your dependencies, and the other files of the
  checkout, which the editor's built-in services cannot.
- **Go to definition.** Press **F12**, or hold **⌘** (macOS) or **Ctrl** and
  click a name. A definition in the same file moves the cursor there. A
  definition in another file of the checkout opens that file in a Code file
  tab, at the definition. A definition outside the checkout, such as one in
  TypeScript's own library, is not opened: a short notice says where it is,
  and no host path is shown.
- **Unsaved text.** The server reads what you have typed, not only the saved
  file. Your text is sent shortly after you stop typing, kept in memory, and
  never written to disk.

The editor's own services (colouring, completions in the open file, and the
other editing basics) keep working beside the server. While the server serves
a file, its problems are the only ones shown, because the editor's built-in
check reads one file alone and would report imports it cannot see as errors.

Plan threads are served too: the server reads the checkout and cannot change
it. A paired device that can reach the thread gets the same problems and
definitions.

## What the server can do

The server is part of Octant: the desktop app and the headless host install
each carry the one built for their Mac or Linux machine, with its license and
notices, and nothing is downloaded when it starts. On macOS it is signed with
the app. It changes version only when Octant updates.

The bundled server is confined when the host starts it:

- It reads the checkout and its own install, and nothing else of yours.
- It writes only its own cache, never the checkout.
- It cannot run other programs or reach the network.
- It starts only when you open a file it reads, and stops after ten minutes
  unused, or when the thread is archived or completed.

It never runs anything the repository names. A `tsconfig` plugin list, an
editor settings folder, or a repository's list of servers is data the server
reads, never a program it starts.

## States

| The line under the toolbar says                  | What it means                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Language services are starting…                  | The server is starting for this checkout. Problems appear when it is ready.     |
| Language services are off                        | You turned them off in **Settings › Code**.                                     |
| The language server stopped (with **Retry**)     | It stopped unexpectedly more than twice in a minute. **Retry** starts it again. |
| The language server did not answer in time       | A request took longer than ten seconds. **Retry** opens the file with it again. |
| Language services are unavailable: _reason_      | The host refused, for example because the checkout is unavailable.              |
| Language services are not available on this host | The host is neither macOS nor Linux.                                            |
| This file is too large for language services     | The file is past what the server is sent. Editing still works.                  |

Files the server does not read, such as Markdown or Python, show nothing.

## Agents

An agent in a Code thread can ask the same server two things: the problems in
a file (`octant_code_diagnostics`) and where a name in it is defined
(`octant_code_definition`). It can do this in Plan mode too, since both only
read. They are offered on providers that can carry Octant's own tools, the
same ones listed for the other Octant tools in [Code](/guide/code), and a
profile whose tool list leaves them out does not offer them.

- The agent gets answers for the file as saved, with lines counted from 1, so
  they match what it reads. If you have unsaved changes in that file, the
  agent is told to wait for you to save; your text stays as you typed it and
  is never sent to the provider.
- A definition outside the checkout is named only as a library or "elsewhere",
  never by its host path.
- An agent can start the bundled server, but never one that runs the
  repository's own tooling, and it never restarts a server that stopped:
  **Retry** in the editor stays yours.

## Turning them off

**Settings › Code › Editor › Language services** turns the bundled server off
for every Code thread on this host. Running servers stop at once, and the
editor keeps its built-in single-file services. Turn the switch back on to use
the server again.

The design, its confinement rules, and the slices still to come are in the
[Language services specification](https://github.com/Ogard-Labs/octant/blob/main/docs/design/language-services.md).
