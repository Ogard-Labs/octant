# Legacy documents

History only. Nothing in this folder is a rule, and nothing here constrains
current work. Current decisions and their requirements are listed in
[Decisions and requirements](../design/decisions.md), and each entry links to
the specification that owns its detail.

| Path                                                   | What it was                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [decisions/](decisions/README.md)                      | The closed design decision archive (0001 to 0164), moved from `docs/decisions/` on 2026-10-31 |
| [plans/](plans/)                                       | Approved delivery plans whose rules moved into the specifications, moved from `docs/plans/`   |
| [fx-acp-compatibility.md](fx-acp-compatibility.md)     | A compatibility probe of one ACP agent; that agent is withheld today                          |
| [release-boundary-holds.md](release-boundary-holds.md) | The start gates of two release holds, both lifted; the architecture owns the release scope    |

Current documents do not link into this folder, and `bun run decisions:check`
refuses such a link. Each file kept its history across the move.
