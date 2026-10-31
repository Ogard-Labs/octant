---
description: Debug a program in a Code thread with breakpoints, stepping, variables, and a debug console, from the Run and debug tool.
---

# Run and Debug

The **Run and debug** tool in a Code thread's dock starts a program under a
debug adapter, stops it at your breakpoints in the editor, and lets you look
at the call stack and variables, step, evaluate an expression, and stop. It
needs a debug adapter: add one from **Settings › Skills & Extensions** as
described in [Add a debug adapter](/advanced/plugins-and-skills#add-a-debug-adapter),
review it, trust it, and switch it on.

## Breakpoints

Click in the gutter to the left of a line number to set a breakpoint, or press
**F9** on the line the cursor is on. Click or press again to clear it. A red
dot marks each breakpoint.

Breakpoints belong to this window and this thread. They go to the program
when you press **Start**, and a breakpoint you set or clear while a session
runs reaches it at once. Octant does not keep them: reloading the window
clears them.

A session takes at most 256 breakpoints in a file and breakpoints in at most
64 files. Past either, the editor sets nothing and says which limit you
reached; clear a breakpoint, or another file's breakpoints, first.

## Configurations

A configuration says what runs: the adapter, the program and its arguments,
the working folder, and environment values. The tool lists three things:

- **Configurations** you have confirmed for this checkout or this Project,
  each with **Start**.
- **From .vscode/launch.json**: what the repository's launch file proposes.
  Octant reads that one file only to propose configurations; nothing in it
  runs until you confirm it, and Octant never writes it. An entry that
  cannot be used says why, for example when it attaches to a running
  process or uses a variable Octant does not fill.
- **New**: write a configuration yourself. Paths are inside the checkout.
  Put one argument per line and one `NAME=value` per line for the
  environment.

**Review** shows a confirmation card with every value that will run, the
adapter with the package and version it came from, and for a launch file
entry, every field Octant does not use (a pre-launch task, for example,
never runs). When two installed adapters share a name, the list names each
one's package too. Choose **Allow in this checkout** or **Allow in this
Project**. The arguments and environment values are kept in the Project's
record of what you allowed. Changing the configuration, or any change to its
adapter (an update, switching it off and on, or changing its trust), asks
again.

## A session

Press **Start** on a confirmed configuration. The tool then shows:

- **The toolbar**: Continue, Pause, Step over, Step into, Step out, and Stop,
  with the session's state.
- **Call stack**: where the program is paused. Choosing a frame in the
  checkout opens its file at that line; a frame outside the checkout opens
  nothing, and code the adapter generated is shown read-only in the tool.
- **Variables**: the paused frame's values. Open a value to see what it
  holds. A value longer than 4 KiB is cut and says so.
- **Debug console**: the program's output, and the answer to any expression
  you type and press Enter on, evaluated in the selected frame.

When the program pauses, the editor opens the file at that line and marks
it. Closing the tool removes the mark, since nothing then follows the
program; the session keeps running, and reopening the tool marks the line
again. A notice that the host could not be reached goes away once the host
answers again. When the session ends the tool says why: you stopped it, the program
exited (with its exit code), or something about the thread changed, such as
moving to Plan or being archived.

A thread has one session at a time. Stop it before starting another.

## Child processes

Some adapters also debug the programs your program starts, such as Python's
`subprocess` or `multiprocessing` workers. The adapter's review in Settings
says whether it does. With such an adapter, a **Processes** list appears
under the session: the program, then each child process as it starts. Choose
a child to see where it is paused, step it, or evaluate in it; **Stop child
process** ends that child only, and the session goes on. Your breakpoints
apply to the program and to every child. Stopping the session ends its
children first.

A session debugs at most 8 children at once and 32 in all; the list says how
many more ran undebugged. A child runs in the same confinement as the program,
with the same network rules, and nothing of it is kept after it ends.

## What a session can do

The adapter and your program run together, confined as a terminal command in
this thread is:

- They can write the checkout and their own temporary folder, nothing else
  of yours.
- Below Full access they reach only the hosts your thread's network rules
  allow; a refused connection is offered on the thread's **Network access**
  list. Under Full access they reach the network as your terminal does.
- They get no provider key, token, or other credential of Octant's.
- They never run in Plan, for a paired device, or for an agent, and they stop
  when the thread stops being active, moves to Plan, or its access changes
  across Full access.

Octant keeps no variable value, expression, output, or breakpoint: they live
in memory for the session and are gone when it ends. The Project's record
holds what you confirmed and when each session started and ended. A
diagnostics export counts the sessions started, and ended for each reason,
over the last 14 days, and names none of them.

## Extra folders

A program in one of the Project's extra folders can be debugged: give its
absolute path as the program, and the working folder, if you set one, as a
folder inside the same extra folder. The session runs in that folder, so
breakpoints and stack frames belong to the folder the program runs in, and a
session never spans the main folder and an extra one. Anything outside the
Project's folders is refused.

## Where it is not offered

| The tool says                              | What it means                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| Debugging stays on this computer           | This is a paired device. Only a window on the host computer can debug.        |
| No debug adapter                           | No adapter is installed, trusted, and switched on for Code.                   |
| Plan is read-only…                         | The thread is in Plan. Leave Plan to confirm or start a configuration.        |
| This configuration needs your confirmation | It, or its adapter, changed since you confirmed it. Review it again.          |
| This thread already has a debug session…   | A session this window does not show is running. Stop it there, or let it end. |

The design and its rules are in the
[Language services specification](https://github.com/Ogard-Labs/octant/blob/main/docs/design/language-services.md#debugger-addendum).
