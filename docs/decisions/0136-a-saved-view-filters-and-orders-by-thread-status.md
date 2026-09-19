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

Both change where part of the vocabulary lives. A Project View is durable: its
filters are written to disk and read back by a later build, possibly an older
one. The moment a status word can be saved, the set of legal words is a wire
value, and `@octant/domain` is the wrong owner for one — contracts own what
crosses a boundary, and domain already depends on contracts, so a status the
domain package defined could not be referenced by the schema that has to
validate it without inverting that direction.

Only the set moves. A rank is never written down: a saved view stores which
statuses a reader wants, not how they compare, so the strength order remains
policy and remains in domain, where `@octant/contracts` is required to hold no
runtime meaning.

Decision 0134 also modelled "nothing to report" as a status called `idle`. That
was tolerable while the only consumer drew a mark, because a mark for `idle` is
simply no mark. A filter and a sort make it a liability: `idle` becomes a word a
saved view could ask for, and a rank a Project could be ordered by, when what it
actually denotes is the absence of any claim.

## Decision

The set of status words is a wire contract, their meaning is not, silence is not
a status, and a saved view may both narrow and order by what threads are doing.

- **The legal set lives in `@octant/contracts`; its meaning stays in
  `@octant/domain`.** `SidebarThreadStatus` names the four statuses a saved view
  may store, because that set has to survive being written down. Everything a
  caller concludes from a status — the strength order, the labels, the
  resolution, the per-Project roll-up, the comparison — is policy and stays in
  domain, so the schema package holds no runtime meaning. The label record is
  typed over the contract's union and the ranking is asserted against it, so a
  status cannot be added on the wire and left unranked.
- **Silence is the absence of a status, not a word.** A thread with nothing to
  report resolves to `undefined` and a Project with nothing to report rolls up
  to `undefined`. A caller therefore has to handle silence deliberately rather
  than receive a word it might render, filter for, or sort by. `idle` survives
  only as a DOM attribute value, where it is a styling hook rather than a claim.
- **A status the sidebar cannot observe stays out of the vocabulary.** This is
  0134's rule, and putting the set on the wire strengthens it: a word added
  there is a word a saved view can persist, so it must denote a fact the sidebar
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
one: contracts for the legal set, domain for its meaning. The compiler and one
test carry that — a label record typed over the contract's union fails to build
if a word arrives without a label, and the ranking is asserted to cover the
contract's members — but adding a status is now a wire change, with the
migration thinking that implies, rather than a local edit to a policy file.

Statuses are still limited to facts the sidebar carries, so a filter cannot yet
ask for a failed run or a blocked check. Giving the sidebar those facts is the
prerequisite, not this filter.

The view menu is only rendered where Project Views are enabled, which is Work and
Code, so the filter and the ordering reach both of those and not Chat. That is a
property of where the menu lives rather than a decision about who should have
them; a Chat surface that grows an equivalent menu inherits both without new
vocabulary.

## Supersession

This is a scoped partial supersession of 0134, which stays `Accepted`.

Two of its rules are superseded, and only in part:

- **"One vocabulary, in the domain"** is superseded as to _where the set of
  legal words is declared_: `@octant/contracts` now declares it, because a
  saved view persists it. The rest of that rule stands, and is what the move
  preserves — there is still exactly one vocabulary, the strength order and
  labels are still a pure domain policy, and the thread row and the Project
  heading still resolve through it so they cannot rank the same facts
  differently.
- **"`idle` is the absence of a claim"** is superseded as to _`idle` being a
  member of the vocabulary_. 0134 listed five words and gave `idle` no label;
  this record removes it from the set, so silence is `undefined`. The rule's
  substance is unchanged and in fact enforced rather than merely observed: a row
  or heading with nothing to report still says nothing rather than "Idle", and
  now cannot say it.

Every other rule of 0134 stands unqualified: only observed facts are statuses; a
Project reports its strongest status and how many threads reached it; the report
appears only while the threads are hidden; the report is the mark its rows wear;
the report never widens the row; and the report obeys the Status row property.
This record adds to that list rather than narrowing it — a saved status filter
and a status ordering are the two surfaces 0134 deferred.

## Related

- `docs/decisions/0134` — the vocabulary this partially supersedes and the
  roll-up it reuses.
- `docs/decisions/0015` — sidebar and navigation shape.
- `docs/decisions/0017` — Project authority, which saved views never exceed.
