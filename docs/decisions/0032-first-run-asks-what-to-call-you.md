# 0032. First run asks what to call you

**Status:** Accepted

## Context

0019 made first run five steps and stated that none of them is a gate: any step
can be walked past, and the surface says what stays unavailable rather than
refusing to continue. That reading held while a profile was decoration. Every
surface that could have named the reader named something else instead, so a host
with no name lost nothing by having none.

It no longer holds. The foot of the sidebar names the person using the host, and
threads, commits, and shared surfaces are meant to name a human rather than a
placeholder. On an unnamed host that row reads "Set your name" permanently: the
app's one statement about the reader is a request it already made and was
allowed to walk past.

A name is also not like the other four answers. A provider, a model, or a
colour scheme is a capability the app can honestly report as unavailable and
carry on without. A name is not a capability. Nothing degrades without it —
there is simply nobody there.

## Decision

- The profile step asks for a name and does not walk past the question.
  Continue, Skip for now, dismissing the dialog, and the rail's other steps are
  all refused until one is given.
- Only the name gates. Address, picture, and accent stay optional on that same
  step, and the other four steps stay skippable exactly as 0019 describes them.
- The gate reads the step's own draft, not the saved profile, so a name just
  typed releases the step whether or not its write has landed. A rejected write
  leaves first run pending, which 0019 already requires; it does not trap
  someone behind a name they already gave.
- Any name is a name. A first name, a nickname, a handle, or a single letter all
  pass. Octant has no account and verifies nothing, so a rule about what a real
  name looks like would enforce a claim the host cannot check and would reject
  people whose name it did not anticipate.
- Whitespace is not a name. A value that trims to nothing names nobody and is
  refused as absent rather than stored.
- A host that finished first run before this asked is not retroactively unnamed
  and is not asked again. It has no name, every surface says so in place, and
  Settings is where it is given.

## Consequences

- 0019's "no step is a gate" holds for four of the five steps. This record
  supersedes it for the profile step only.
- Someone who wants no profile at all can no longer have one. That is the cost,
  and it is deliberate: the alternative is an app whose only sentence about its
  user is a request to identify themselves.
- `isNamed` is the domain predicate for this, separate from
  `isProfileConfigured`, because "has told us anything" and "can be addressed"
  became two different questions the moment one of them started gating.

## Related

- [0019](0019-user-profile-and-first-run-setup.md) — user profile and first-run setup
