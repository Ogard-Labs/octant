# 0019. User profile and first-run setup

**Status:** Accepted

## Context

A clean store launches into an app that knows nothing about the person using it
and nothing about what this Mac can reach. The first-run surface already
reported provider readiness, but three things a new host needs were reachable
only by hunting through Settings afterwards: the default model new Chat threads
start with, whether Navigator is turned on, and how the user wants to be shown
inside the app.

Octant has no account and no sign-in. That makes a "profile" easy to get wrong
in either direction: modelled as an identity it implies an account that does not
exist, and omitted entirely it leaves every surface addressing a placeholder.

Avatars raise a second problem. Users expect to be able to use a real picture,
and the obvious sources are a local file and Gravatar — but Gravatar is an
external service, and this repository's default is local-first with no outbound
calls unless a decision record and the request authorise them.

## Decision

- Shell settings gain a `userProfile` section: optional display name, optional
  email address, a named accent, and an avatar that is either `initials` or an
  inlined `image`. Every field is optional; the empty profile is valid, and a
  store persisted before this shipped decodes to it rather than to a name
  guessed from the OS account.
- The profile authenticates nothing and authorises nothing. No authority check,
  approval decision, or provider call reads it.
- First run becomes five steps — profile, workspace, providers, default model,
  Navigator — in that order, because both model choices are picked from what the
  provider step found. No step is a gate: any of them can be walked past, and the
  surface states what stays unavailable rather than refusing to continue.
  (Superseded for the profile step by [0033](0033-first-run-asks-what-to-call-you.md),
  which requires a name before first run goes on.)
- The workspace step collects colour scheme, whether Chat and Work are enabled,
  and the mode switcher's presentation. These are opinions a user forms in the
  first minute and would otherwise have to hunt for. Each writes through to the
  setting that already owns it — appearance to theme settings, the rest to shell
  settings — so first run keeps no copy of any of them.
- Code has no switch on that step. It is always available (0003), and a control
  that cannot be turned off would imply otherwise. The step also states that
  turning Chat or Work off hides the mode without deleting its data, because a
  bare "Enable Work" toggle reads to a new user as a choice about whether their
  work will exist.
- The rail's checkmark means "the host holds a real answer". Name, address, and
  picture are absent until given, so their presence is the answer. Every
  workspace setting and the avatar accent always hold a value, so for those the
  checkmark means "changed from what Octant ships with" — the only fact that
  separates a decision from a default nobody looked at.
- Profile edits persist when they settle — a blurred field, a chosen accent, a
  finished import — not when the step is left. Quitting the app is not one of
  this dialog's exits, and an answer that waited for one would be lost by
  someone who typed their name and closed the window. Settling is not
  keystroking, so this costs a handful of writes, not one per character.
- Settings writes are queued per surface, and each reads the expected version as
  it goes out. A queued write is abandoned if an earlier one hit a conflict:
  these commands carry the whole settings record, so re-stamping a stale one
  with the reloaded version would get it accepted and put this window's old
  values back over the ones another window just wrote.
- Answers are recorded as they are made, so quitting part-way keeps what was
  already chosen. Only the first-run _outcome_ is recorded at the end, and
  dismissing the dialog records the same durable "skipped" outcome as the button.
- The outcome is recorded last, and only once every answer already given has
  been accepted by the host. Answers are written by three independent
  controllers — shell, Chat, and theme — so one can still be in flight, or have
  been discarded by a conflict, when the user answers first run. A conflict is
  recovered by reloading, which leaves the surface able to record an outcome
  against state that never took the answer; because the outcome is durable, the
  user would never be asked again and the answer would be gone with no retry.
  Leaving first run pending is the honest result: the surface returns on the
  next launch, still holding the question. This is why a settings write reports
  whether the host accepted it rather than only that it finished.
- An avatar image is stored inlined in settings, downscaled to a 128px square
  and bounded at 96 KB of encoded characters by the contract itself. Settings are
  journaled, so an unbounded image would grow every replay of them forever.
- Gravatar is offered, and is the one part of a profile that leaves this Mac. It
  is bounded three ways: it runs only when the user presses the button, only
  once an address has been typed, and the surface says in place that pressing it
  sends a hash of the address to gravatar.com. The lookup requests `d=404`, so a
  miss is reported as a miss instead of storing Gravatar's generated placeholder
  as the user's picture. What comes back is copied into settings, not linked, so
  the avatar renders offline and the host never contacts gravatar.com again on
  its own initiative.

## Consequences

- The default-model and Navigator steps show the same picker as Settings, built
  from the same provider groups, so first run cannot offer a model the rest of
  the app would refuse.
- An avatar costs journal space in every settings replacement that carries it.
  The 96 KB bound is the ceiling on that cost and is enforced in the contract,
  where a renderer cannot talk its way past it.
- Octant now makes one outbound request that is not to a configured provider.
  It is user-initiated, one-shot, and carries a hash rather than the address,
  but it is a real exception to the no-outbound-calls default and is listed here
  so it stays visible rather than becoming precedent.
- A profile is deliberately not a git identity. Code threads still take their
  commit author from the repository's own configuration; reusing this name and
  address for commits would put a display preference into published history.

## Related

- 0002 Durable event journal and rebuildable projections
- 0015 Workspace shell model
