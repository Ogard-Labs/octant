# 0136. A saved view filters and orders by thread status

**Status:** Accepted

## Context

Decision 0134 named the sidebar's thread-status vocabulary once, in
`@octant/domain`, so a thread row and a folded Project heading could not rank
the same facts differently. It recorded that a later surface wanting to speak
about thread state should read that vocabulary rather than invent a parallel
one. Two such surfaces were named there and deferred: a saved Project View that
lists only the statuses a reader cares about, and an ordering that puts the
Project holding the loudest thread first.

Both change where the vocabulary lives. A Project View is durable: its filters
are written to disk and read back by a later build, possibly an older one. The
moment a status word can be saved, it is a wire value, and `@octant/domain` is
the wrong owner for a wire value — contracts own what crosses a boundary, and
domain already depends on contracts, so a status the domain package defined
could not be referenced by the schema that has to validate it without inverting
that direction.

Decision 0134 also modelled "nothing to report" as a status called `idle`. That
was tolerable while the only consumer drew a mark, because a mark for `idle` is
simply no mark. A filter and a sort make it a liability: `idle` becomes a word a
saved view could ask for, and a rank a Project could be ordered by, when what it
actually denotes is the absence of any claim.

## Decision

The status vocabulary is a wire contract, silence is not a status, and a saved
view may both narrow and order by what threads are doing.

- **The words live in `@octant/contracts`.** `SidebarThreadStatus` names the
  four statuses and `SIDEBAR_THREAD_STATUS_ORDER` fixes their strength order.
  `@octant/domain` keeps what the words mean — the labels, the resolution, the
  per-Project roll-up, the comparison — because meaning is policy, while the set
  of legal words and their order is what has to survive being written down.
- **Silence is the absence of a status, not a word.** A thread with nothing to
  report resolves to `undefined` and a Project with nothing to report rolls up
  to `undefined`. A caller therefore has to handle silence deliberately rather
  than receive a word it might render, filter for, or sort by. `idle` survives
  only as a DOM attribute value, where it is a styling hook rather than a claim.
- **A status the sidebar cannot observe stays out of the vocabulary.** This is
  0134's rule, and putting the words on the wire strengthens it: a word added
  here is a word a saved view can persist, so it must denote a fact the sidebar
  actually carries before it is named.
- **An empty status filter means every status.** No selection is no constraint,
  exactly as an empty environment list already reads in the same schema. A view
  saved before the field existed therefore keeps showing what it showed, which
  is why the field is optional rather than defaulted to the full set, and a
  reader who opens the submenu and closes it again has not emptied their
  sidebar.
- **A filter judges a thread by its strongest status.** Asking for "Needs
  attention" lists the threads that are waiting on the reader, not the ones that
  are already running and happen to also be unread. Any other reading would
  disagree with the mark the row wears and with the Project heading above it.
- **An unknown saved status narrows; it never refuses.** A lens written by a
  newer build is filtered down to the words this build understands. Rejecting it
  would strand a reader on the older build, and adopting it wholesale would mean
  honouring a constraint this build cannot evaluate. Dropping every word
  collapses to no constraint, for the same reason an empty list does.
- **Ordering by status is loudest first, then the order already on screen.** A
  Project leads on its strongest thread, then on how many threads reached that
  status, then on recency and name. Every Project with nothing to report sorts
  after every Project that has something, and keeps the relative order a reader
  already knows rather than being shuffled.

## Consequences

A sidebar too long to read top to bottom can be narrowed to the threads that
are waiting and ordered so the loudest Project opens first, without a second
status vocabulary appearing anywhere. The saved lens travels with the rest of a
Project View, so the narrowing survives a restart and reaches every client that
reads the same host.

The cost is that the vocabulary now has two homes to keep honest rather than
one: contracts for the words, domain for their meaning. The compiler carries
most of that — a label record over the contract's union fails to build if a word
is added without a label — but adding a status is now a wire change, with the
migration thinking that implies, rather than a local edit to a policy file.

Statuses are still limited to facts the sidebar carries, so a filter cannot yet
ask for a failed run or a blocked check. Giving the sidebar those facts is the
prerequisite, not this filter.

The view menu is only rendered where Project Views are enabled, so the filter
and the ordering reach Code and not Chat. That is a property of where the menu
lives rather than a decision about who should have them; a Chat surface that
grows an equivalent menu inherits both without new vocabulary.

## Related

- `docs/decisions/0134` — the vocabulary this moves and the roll-up it reuses.
- `docs/decisions/0015` — sidebar and navigation shape.
- `docs/decisions/0017` — Project authority, which saved views never exceed.
