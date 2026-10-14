---
description: Let a provider CLI you type into a Code thread's terminal use that thread's Browser, through the octant mcp command.
---

# Browser for a CLI in a terminal

A provider CLI that you start yourself in a Code thread's terminal is not
started by Octant, so it gets none of Octant's tools. You can switch one
terminal on so that a CLI started in it can use that thread's
[Browser](./browser-and-computer-use#browser), under the same rules as the
thread's own agent.

## What you need

- **The `octant` command in the terminal.** A
  [headless install](/guide/installation#install-a-headless-artifact) puts
  `octant` in its `bin` folder; add that folder to your `PATH`. The desktop app
  does not include the command yet, so in the desktop app this only works if
  you put a headless install's `octant` on the terminal's `PATH` yourself.
- **A CLI that can start a stdio MCP server** and pass it the terminal's
  `OCTANT_BROWSER_MCP_URL` and `OCTANT_BROWSER_MCP_TOKEN` variables.

## Add Octant to your CLI once

Octant never writes a provider's configuration. You add one entry yourself,
once. It grants nothing: outside a switched-on terminal, `octant mcp` offers no
tools and says why.

Claude Code passes the terminal's variables on by itself:

```sh
claude mcp add --scope user octant -- octant mcp
```

Codex passes a server only a short list of variables, so the entry names the
two it needs. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.octant]
command = "octant"
args = ["mcp"]
env_vars = ["OCTANT_BROWSER_MCP_URL", "OCTANT_BROWSER_MCP_TOKEN"]
```

For another CLI, add a stdio MCP server named `octant` whose command is
`octant mcp`, with no other arguments, and make sure the CLI passes it the two
variables above.

## Switch a terminal on

1. Open the Code thread's **Terminal**.
2. Open the terminal's **More terminal actions** menu (or right-click the
   terminal) and choose **Let this terminal use the Browser…**.
3. Confirm **Restart with the Browser**. A running shell cannot be given the
   Browser, so the terminal restarts and anything running in it stops.
4. Start your CLI in the terminal. The terminal shows **Browser on** while it
   can use the Browser.

Each terminal starts with the Browser off. Only you, at a window on the
computer that runs Octant, can switch one on; a paired device cannot.

## What it can and cannot do

- **The Browser only.** No Computer use, no other terminal, no Apple or
  Android tools, and no planner tools. The CLI's own shell and file tools are
  unchanged.
- **As this thread.** The Browser's site list, its protection of password
  fields, and Plan mode apply as they do to the thread's agent. In Plan mode
  the Browser refuses every action that would change something.
- **You approve each new site.** The first time the CLI opens a site, the
  thread asks you, in a card that says the request came from a program in the
  thread's terminal, not from the thread's agent. **Always allow** remembers
  the site for every Browser use, as it does elsewhere; you can forget it in
  **Settings → Data & privacy → Remembered websites**.
- **No captures.** A screenshot the CLI takes is not kept in the thread.

## How it ends

The terminal's access ends when you choose **Switch off**, the terminal stops
or restarts, the thread is completed, archived, or deleted, or Octant stops.
The CLI is then refused at its next Browser call and `octant mcp` exits. To use
the Browser again, switch the terminal on again and start the CLI again.

While the window that switched it on shows another Project, the CLI is refused
as well, and `octant mcp` exits; start the CLI again once the window is back on
the thread's Project.
