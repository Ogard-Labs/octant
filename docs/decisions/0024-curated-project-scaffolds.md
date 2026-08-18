# 0024. Curated project scaffolds

**Status:** Accepted

## Context

A Code thread can be bound to any folder, including an empty one, but Octant had
nothing to say once it was. Starting a project meant remembering a generator's
name, guessing which version to run, and typing it into a terminal — the one
moment a local-first tool is least useful, because the person has nothing yet
to point it at.

Two shortcuts were available and both are wrong. Vendoring template files into
this repository makes Octant the owner of every framework's starting point and
stale within a release. Letting a catalog entry carry a command line makes the
catalog a place where arbitrary shell arrives with the host's own authority.

## Decision

- A **scaffold** is a curated catalog entry: display metadata, the tool it needs,
  the notable paths it writes, and a **pinned generator** — an exact package and
  version, or a toolchain the machine already has. Nothing is vendored, and a
  version that could move (`latest`, a range) fails to decode.
- **The host composes the command line.** A catalog entry contributes a pinned
  package and a preset; the argv is built in pure policy from that record plus
  the directory name. An entry cannot contribute a flag, a path, or a shell
  fragment, and shell executables and `-c` are refused as argument tokens — the
  same rule repository-test definitions already follow.
- The renderer **selects** an entry and names a directory. It never authors one.
  A `run-scaffold` command carries only `{scaffoldId, directoryName}`, and an id
  the host does not publish is refused rather than resolved into something
  adjacent.
- The directory name is one path segment: no separators, no traversal, no
  leading dot, and no leading `-`, so nothing the user typed can be read as a
  flag by the generator. A name that already answers to anything — including a
  symlink — refuses the run.
- Running one is an **ordinary Code operation**: approval-gated, journaled, and
  classed with the shell commands a thread can already ask for. There is no new
  authority, no new posture, and Plan mode refuses before any process starts.
- The generator runs in the same confined process path repository tests use,
  bound to the checkout it writes. It differs in exactly two ways, both stated
  here: network egress is allowed, because a generator downloads what it writes;
  and every package cache is redirected into a private work directory, so
  nothing it fetches lands in the user's own caches.
- **Dependencies are not installed by the scaffold.** Writing a project is one
  approval; downloading a dependency tree is another, and the user takes it in
  the thread's terminal once they can see what they got.
- A run that did not exit cleanly is never reported as a created project. The
  schema refuses the combination outright.

## Consequences

- Starting a project is one gesture from an empty Code thread, and the exact
  command is on screen before it is approved.
- Bumping a pin is a reviewed change to this repository, which is the point: the
  curation is the decision, and it is visible in a diff.
- A machine without the tool an entry needs is told so in the listing rather
  than after a failed run. Tool presence is resolved by looking along `PATH`,
  never by running the generator to see whether it exists.
- The catalog is small on purpose. Growing it is adding a record, and a scaffold
  a third party wants belongs behind the plugin seams rather than in this list.
- Scaffolds are not digest-verified the way curated plugin packages are. A
  generator resolves its own dependency tree over the network, so the bytes it
  produces are not content-addressable in advance; the pin on the exact
  generator version and the host-composed argv are what stand in for that, and
  the confinement is what bounds the result.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0011 Extensions and skills: the activation ladder
- 0017 Code Projects bind any folder
