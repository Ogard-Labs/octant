# Thread view

How a thread reads in Chat, Work, and Code: the turn header, the transcript, what a turn shows of its work, the composer's thread-specific parts, and the controls that sit beside it. The shared composer shape and row are in [DESIGN.md: Composer row](../../DESIGN.md#composer-row); behavior of panes and tools is in [Workspace](workspace.md).

## Turn header

Every assistant reply in Chat, Work, and Code opens with the same line: who
answered (provider and model as the picker names them), how the turn stands
(Working, Waiting for approval, Completed with how long it took, Failed with
the host's sanitized reason on the line below), and when it last changed at the
right edge. While a turn runs and has a start time, the header holds no status;
the turn instead ends with its live line, "Working · 12s · Read", under its
reply and task list (maintainer decision, 2026-11-24), so the line stays beside
the newest content however long the turn grows. In the header it scrolled away
with the top of a long turn. The clock counts from the turn's own start (not from when the row
mounted) once a second in tabular digits with a fixed minimum width, so a tick
moves nothing; the step is the title of the newest running tool, left out when
none runs (a reply that spoke before a tool ran still names it), and clips to an ellipsis. The live
region holds the step alone, so a change of step is announced politely and the
clock is never read; the timer stops when the turn settles and when the row
unmounts. A turn waiting on the person, or one with a label of its own
("Waiting for your answer"), keeps its status in the header and draws no live
line. `TurnLiveLine` beside `TurnHeader` draws it, and the header and the line
ask the same question, so exactly one of them shows a running turn's status. A finished turn's duration ("Worked for 1m 5s") is drawn once: at the
head of the fold's summary line when the turn folds its tool calls, otherwise in
the header. It is set in the interface face at the detail size; only the status
word carries colour. `TurnHeader` in `apps/web/src/transcript/` is the one
recipe; a mode maps its own lifecycle onto its vocabulary and adds nothing of
its own.

## Strict notice

When a provider launch was Strict, the host journals what Strict kept for it,
and the turn shows one quiet note above its reply in Code and Work: "Strict
kept: Octant's sandbox, protected files, a fixed environment, …". The words
come from the protections the host applied to that launch (its runtime
family, and whether it ran in Octant's sandbox), never from the level alone.
The note shows on the first Strict launch in a thread and again only when what
Strict kept differs from the turn before, so a thread says it once per change
rather than on every turn; a launch outside Strict shows nothing. It is the
same meta-ink note as a provider handoff's (`role="note"`), not a page banner
or a card. `strictKeptSentence` in `@octant/domain` is the one wording.

## Cleaned-up worktree

When the host has removed a Code thread's managed worktree folder to save space
(or an interrupted cleanup or restore left it that way), the thread view says so
in one neutral card above the composer, in the settled thread's place and wording
family: "This thread's worktree was cleaned up to save space. The branch and the
thread are kept, and the thread takes no new turn until the worktree is
restored." (`cleanedUpWorktreeSentence` in `@octant/domain`, with its two
variants for a cleanup or a restore still under way). The card carries
**Restore worktree**, which asks the host's existing restore route and then
reads the thread again; the card goes with the host's answer, even when that
read fails and waits for the next refresh, and a worktree another window already
restored counts as back. That answer belongs to the thread and to the cleanup it
answered: moving to another thread while a restore runs never hides that
thread's card, and a later cleanup of the same thread shows its card again. A refusal, such as a branch that moved, shows as a
second quiet line (naming what to do where waiting would not help) and the card
stays; a warning that the host handed the folder back with some files missing
stays on its line after the card is gone, with **Dismiss**. An open thread reads
its cleanup standing again on the navigation refresh, so the card appears when
a cleanup happens under it and goes when another window restores it. Sending is held while the card shows: the
send button is disabled, Enter sends nothing, and the draft stays. The files and
terminal surfaces of that thread say the same in place of "This checkout can't
be read" and do not offer to move the thread to the Project's checkout. The host
answers a send, a queued message or a wake-up that fires for such a thread with
the same sentence. A window on this computer or a device the host's own person
paired gets the button, a paired browser's over its session; a hub-introduced or restricted device reads the sentence
without it. `cleanedUpWorktreeNotice` in `apps/web/src/composer/` is the one
recipe, and `CodeThreadView.worktreeCleanup` is what the host reports.

## Context handoffs

When a thread changes provider, moves to another account, switches models, or
starts a new session from a fork, branch, or rewind, Chat, Work, and Code draw
one shared boundary, `TranscriptHandoff` in `apps/web/src/transcript/`: a
full-width hairline (`OctantSeparatorWithLabel`) with a 12px transition icon,
the boundary label (**Context handoff**, **Model switch**, **Forked context**,
**Branched context**, or **Rewound context**), and when the provider or model
changed, the source and target models joined by a 12px arrow with their
provider marks (`ProviderGlyph` at 14px; one mark on a same-provider model
switch, both marks when switching providers or accounts, and account names
beside the model when two accounts share one model name). Across turns, the
boundary sits ahead of the next user message so it marks the handoff between
the previous reply and the prompt sent to the new provider; within a single
Chat turn's retry onto another provider or model, it sits ahead of that
attempt. Whenever the host recorded a handoff, its disclosure sentence sits
centred in meta ink (`role="note"`, no card or banner) directly beneath the
hairline, naming what carried over, every omission, any outside-content mark,
and what stayed behind. The phone draws the same boundary and disclosure across
Chat, Work, and Code (`TranscriptHandoffDivider` in `apps/mobile/src/ui/`).

## Loop and stall notices

Outside Strict, neither a repeated-tool loop (6 identical consecutive calls)
nor silence past the stalled-turn limit stops the turn. Instead, the host
journals `turn-loop-noticed` (tool name and count) or `turn-stall-noticed`,
and the turn shows one quiet meta-ink line (`role="note"`,
`TurnLoopStallNotice` in `apps/web/src/transcript/`, styled like
`OutputLimitNote` with no card or banner) with an inline **Stop** button while
the turn runs. Once the turn settles, **Stop** disappears and the quiet line
stays as the record. Under Strict, a 6-call loop stops the turn, journals
`turn-loop-stopped`, shows one quiet line without **Stop**, and leaves the
thread ready to accept the next message straight away. `turnLoopNoticeSentence`
and `turnStallNoticeSentence` in `@octant/domain` are the shared wordings.

## Server sign-in

When an MCP server the thread's next turn would get needs a sign-in, the thread
shows a notice beside its waiting requests, in Chat, Work and Code alike:
"{server} needs sign-in", one sentence, the sign-in control Settings uses, and
Dismiss. The person finishes there, with no visit to Settings; on a device the
host's own person paired, the control shows the address field once the host says
the attempt can be finished that way.

- Which servers count is the host's answer, never the window's
  ([Architecture: extensions and skills](../architecture.md#extensions-and-skills)):
  one pinned to the thread's Project, or one selected with `@` in the composer.
  In Chat the latest turn's selections count too, since Retry and Regenerate send
  them again. A server the person has switched off, not trusted, or not chosen for
  this thread is never named, whatever state it is in.
- A read-only thread, and a device that may not sign in, show nothing and ask
  nothing.
- The notice goes when the server is signed in (here, in Settings or on another
  device), when it is switched off, unpinned or taken out of the composer. A
  sign-in finished here says "Signed in to {server}" for a moment first. A read
  that could not reach the host keeps it, so a half-pasted address is not lost.
- Dismiss hides it in this thread until the window closes, or until the server
  has been usable and needs a sign-in again. Dismissing changes nothing on the
  host; Settings › Skills & Extensions still lists the server.
- It is announced politely, not as an alert, because it waits on no running work.

## Reply actions

A finished reply (completed, failed, interrupted or cancelled) ends with one
action row, `TurnActions` in `apps/web/src/transcript/`, the same in Chat, Work
and Code: Copy, Fork from here (where the thread can fork), Read aloud (only
where speech is available), Regenerate (where the host supports it), and the
time at the right of the buttons, a clock time today and the date and time
older, with the full date in its title. The buttons are 14px ghost icons in
the meta ink on a 28px row. The row always holds its height, so showing it
moves nothing: the thread's last reply keeps it visible at rest, an older reply
shows it on hover or keyboard focus, and touch and increased contrast always
show it. A reply still working has no row. A failed or interrupted reply shows
its time (its last update, or its start when none is journaled yet). Fork also
stays in a turn's "…" menu. The turn header above the reply keeps only the
status, how long it took, and the provider and time in its hover details.

## Transcript

The rest of the thread view is one set of recipes in `octant.css` and the
reply prose in `chat.css`, worn by Chat, Work, and Code alike; a mode positions
them and repaints nothing. The scroll frame (`transcript-scroll`) keeps 20px
between rows and fades its content out over 12px at both edges, in every mode:
text scrolling under the title band's hairline or into the composer ended in half
a line cut flat, and only Code had a fade, at the top. At rest the first line
sits below it. The find bar sits just below the top fade so it is never dimmed;
the fade also dims the scrollbar thumb at the two extremes, which is accepted. A person's message is a right-aligned bubble (`turn-user`,
`bubble`: control fill, hairline, `--oct-radius-md`, no shadow) with its time beneath
it (`turn-time`: detail size, muted, right edge), and carries 12px more air
above it than the reply before it. A reply (`turn-agent`) is bare prose at the
transcript size with 1.5 leading, its paragraphs, list items and table cells at
the 1.6 reading leading ([DESIGN.md: Scale](../../DESIGN.md#scale)), with no card of its own: only the work a turn
produced is boxed. Over the application ground, the conversation supplies one quiet,
continuous reading veil below the title band: the sheet colour at 94%, so the
ground stays a whisper behind the transcript. Replies remain bare prose, including on translucent
workspaces; user bubbles and the composer retain glass over the application
ground. Under Glass the thread's container stays clear, the ground steps down to an eighth of its strength while a thread is on screen, and keeps a quarter of it under the sidebar, so it never reads as letters behind text. Reduced transparency keeps the reading background opaque.

The follow-up composer has 24px of space above it outside the transcript
scroll frame, so a reply never touches the input. Running text, tables and code
blocks all run the column's width, which is the reading width the person chose,
and end on the same edge as the divider, the bubble and the composer (a 72ch cap
on prose stopped paragraphs at about 635px at every width past Narrow, so the
setting only ever moved tables); markdown headings inside it are headings on
the type scale (20/17/15/14 at weight 600, 24px above and 12px below), lists
sit 4px apart, and a fenced block is a
`CodeBlock`: a 28px header strip naming the language with a ghost copy control,
then detail-size mono on the application ground. Tool rows are 28px each, the
name at the body size and the state at the right as detail text with a 12px
mark (spinner, check, cross), parted by hairlines and indented together; at
the default Reply detail (below) a settled turn folds them behind "N tool
calls". An approval Octant Shield
answered is a 28px line among them, not a disclosure: a 14px shield mark
(check, alert, or cross, the cross in the danger ink), "Octant Shield
allowed", "asked you", or "denied", the call in detail-size mono, the
one-sentence reason in the muted ink, and the rule or model and the latency
at the right as detail text. It always names Shield, never the provider, and
does not count as a tool call. A Code turn that changed files ends with one card: "N files changed while this ran", then a 28px row per path with the folder in the meta ink, the name in the primary ink, and the added and removed line counts in the diff inks at the right. It folds after five rows, says "Showing n of N" when the record is incomplete rather than summing rows it never saw, and never says who wrote a file. When a Work or Code lead records a finished receipt through `octant_report_finished`, the turn ends with a **"Finished, with proof"** card showing the summary, the observed diff file and line counts (or `Diff unavailable`), each host-run check or goal criterion with its status (`Proven`, `Failed`, `Claimed`, `Unavailable`) and expandable output, and a `Stale` notice whenever a later file-change journal event landed after the receipt. The same card sits above the last reply on the Review page, where Send back prefills any failed or claimed items. A turn paused on the person uses a neutral composer-adjacent request row with
an icon and explicit answer controls. Follow-up composers use one compact
hairline message surface across Chat, Work, and Code. Feedback above the toolbar
appears only when it has content; empty feedback consumes no space. A held
message queue with items still waiting shows a compact **Follow-up paused**
chip and **Resume** next to the composer; the expandable queue still lists
the items and the specific hold sentence. Long notices
remain accessible and scrollable. The access menu holds the optional provider
approval-review choice and starting-profile detail. The Code checkout strip is
attached underneath, rather than floating above the input. It keeps its height
and border when checkout metadata is unavailable: missing project, branch and
diff values stay blank, and unavailable checkout actions are not shown. Input growth from
extra typed lines and visible notices is intentional. Repository, branch
and PR actions stay visible below the input. Utility panels keep one resize
boundary and a compact tab row without a second horizontal divider.

## Reply detail

**Reply detail** chooses how much of a turn's work the transcript shows open.
Settings › Appearance › Reading › Reply detail (`replyDetail`) is the default
every thread starts at: one `OctantToggleGroup` of three levels whose
description reads "Where every thread starts unless it sets its own." followed
by the chosen level's sentence. A thread may set its own level, which then
stays with that thread: it survives a reload, every window and paired device
of the host draws it, and changing the default never moves it. A thread that
never chose follows the default. The levels apply the same in Chat, Work, and
Code, wherever `TurnActivityRows` and `AssistantMessageBody` draw a turn:

- **Low** (default): "Thinking stays folded, and a finished turn's tool calls
  fold behind one line." Thinking is shut, tool rows are listed while the turn
  runs and fold behind "N tool calls" once it settles, and each row's detail is
  shut. A run of two or more consecutive reads, searches, and folder listings
  (recognised by tool name; a call carrying a published page, an automation, or
  an outside-content tag stays its own row) is one row such as "Read 4 files,
  searched 2 times", shut at Low and listed at Medium and High, in running and
  settled turns; any other row ends the run, and a lone look stays a plain row.
  The settled fold's line leads with the turn's duration: "Worked for 1m 5s · 12
  tool calls · 4 files edited". This is the transcript as it was before the setting.
- **Medium**: "Thinking stays folded with its first line showing, and tool
  calls stay listed." A shut Thinking row carries the reasoning's first line
  after its name, as plain words in the muted ink, clipped to the row with an
  ellipsis; it goes away while Thinking is open. A settled turn's "N tool
  calls" fold starts open, and each row's detail stays shut.
- **High**: "Thinking, tool calls, and each call's recorded result stay open."
  Thinking, the fold and every row start open on the summary the transcript
  already holds, still clipped behind Show all past 1,200 characters. While a
  reply streams, its thinking is open and grows as it arrives, and a running
  turn's tool rows are open; Settings › Chat › Stream replies still alone
  decides whether the partial answer shows, at every level.

### Turn activity rows

Every row of a turn's work leads with a 14px icon for its kind in the muted ink,
in one column so the names line up: Thinking a brain, a tool call the mark of
what it did (command, file read, edit, search, web, connector or subagent) and
a generic wrench for a kind the transcript cannot read. The chevron stays at the
start. A row ends in one 16px status slot that is reserved whether or not a mark
shows, so a call that finishes swaps its mark and moves nothing: a spinner
while it runs, a check when done, a cross in the danger ink when failed, a
hollow circle when it never finished. The state word stays in the row's
accessible name and in text only a screen reader reads.

A tool's name is the tool's own display name. The host's internal kinds, which
are kebab-case ("provider-tool"), read as words ("Provider tool"), and an
`mcp__server__tool` name reads "tool (server)". Thinking says "Thought for 12s"
when the turn recorded how long reasoning ran ("Thought briefly" under a
second) and "Thinking" otherwise. Every mode records its reasoning as the sum
of the disjoint stretches between provider events, journaled as a cumulative
total when each stretch ends, so a rebuilt transcript reads the same figure a
live one showed. A turn whose host kept only the total — reasoning text is
never recorded for it — still draws the measured row, as a plain line that
opens nothing.

The folded "tool calls" group says what ran in marks, not only a count: an icon
and a number per kind, most frequent first ("terminal 4, file 5, pencil 2"), at
most four kinds and then "+n" for the rest. Its accessible name carries the
total and the words ("11 tool calls: 5 reads, 4 commands, 2 edits"). Opened,
each call is one row of fixed height: the kind icon, the name, a one-line
preview in the meta ink (a command's first line, a file's name, a search's
query) clipped with an ellipsis, the call's duration when the host recorded one,
and the status slot. A call that paused on the person's approval carries both
halves instead ("waited 4m · ran 2s"): the wait is the journaled ask-to-answer
span of the approval that gated that call alone, never time a neighbouring
call waited. Chat and Work calls carry the same recorded bounds as Code's; a
call the host ran itself is timed from its own start and finish, and a settle
that no person made (an automated review, an expiry) is never wait time. An
answer the agent refused and Code put back (an allow it cannot take as asked)
does not end the wait; it runs on to the person's next answer. A
call still running, and any call whose bounds are missing or cannot be
trusted, shows no time rather than an invented one. The preview is drawn, not read: the detail under the row
stays the one place the summary's words are, and clicking the row opens it as
before. A call that finishes changes its mark only.

A Code turn's checkout capture notes (the latest capture and its time, what the
changes are measured from, a note that no paths were captured, and that a final
comparison is missing) are one quiet, closed line below the reply: a camera
icon and "Checkout capture · 19:04". The sentences sit inside it, so they do not
read as part of the answer.

The thread's own choice is a row of the thread's
[info panel](workspace.md#thread-info) in Chat, Work, and Code. The
row reads "Reply detail" with the level in effect ("Low") at its trailing
edge, and its accessible name also says whose the level is ("Reply
detail: High, this thread's own" or "Reply detail: Low, the default"). As a
bare glyph in the composer row it read as one of two unexplained list icons.
Its radio items are **Use default (Low)**
(naming the current default; "Follow the level in Settings") and the three
levels, with short descriptions that fit a phone-width menu: "Thinking and
finished tool calls folded", "Thinking's first line, tool calls listed",
"Thinking, tool calls, and results open". A client that cannot change the
level shows no menu (a paired browser the host's own person paired changes it
as a local window does; any other paired browser shows none).

**Change reply detail in this thread** (`reply-detail-cycle`, Mod+Shift+D by
default, remappable in Settings › Keyboard shortcuts) steps the thread in front
through Low, Medium, High and back to Low, setting its own level, and says so
in a status toast ("Reply detail: Medium" over "This thread:" and the level's
sentence). A thread is in front only while it is on screen: behind Settings,
Usage, Review, Zen, or any other page that covers the workspace, the chord does
nothing and is left to the browser, and the palette offers only the default's
commands. Mod+Shift+D is held by no other default, no desktop menu item, and no
macOS or Windows system chord; in a browser it is Bookmark all tabs (Safari:
Add to Reading List), which the page takes only when it changes a thread. The
command palette offers the same cycle (showing the chord), each level not in
effect for this thread, **Use the default reply detail in this thread** when the
thread has its own, and **Set the default reply detail to …** for the default.

The level is presentation only. It never changes what a model is asked or what
a client fetches, and a row with no recorded summary says so rather than
showing more. Every disclosure stays native, with `open` and `aria-expanded` in
step, so a person can open or close any one by hand; that choice holds for that
disclosure while the turn stays mounted and the thread's level is unchanged,
and a change of that level (its own, or the default it follows) puts every
disclosure where the new level puts it. The first line beside Thinking is
hidden from assistive technology: the button's name stays "Thinking", and the
same words are read from the body once it opens. Nothing animates beyond the
chevron's turn, which reduced motion stills.

The default and the threads' own levels live in the host's shell settings
(`replyDetail`, `threadReplyDetail`), the document that already holds every
other per-person presentation choice, keyed maps included. That is the
narrowest home that keeps it a preference: it is written only by the shell
route, which a window on the host reaches (a device the host's own person
paired too, by maintainer decision, 2026-11-12); it is not part of any thread's
journal, so forks, exports and provider context never see it; and host export
does not carry it. Code's pin is the one per-thread presentation choice kept on
a thread's own record, and Chat and Work have no such record to share, so a
level on three mode journals would have put a presentation choice where thread
authority lives. Purging a thread, alone, with its Project, or past the
retention window, removes its level in the same pass, so no level outlives its
thread; the host writes that change itself, with no window to name. The list
also holds at most 500 threads, and setting one more drops the longest-standing
choice, a backstop should that write lose a race. The host has no settings push,
so another open window picks up a change when it regains focus: it re-reads the
shell settings behind any edit it is still saving. The phone and a paired browser read the two fields, and nothing
else from the settings document, through `GET /api/reply-detail`
(`settings.read-non-secret`, read-only, at most 128 KiB): the phone when a
thread opens and when the app returns to the foreground, a paired browser when
its workspace opens, when the mode changes, and when the window regains focus.
Until an answer arrives, or if none can, they draw Low. On the phone the
reasoning panel opens at High and shows its first line at Medium. A run of
consecutive tool calls draws as one rail of 28pt rows, each with a round
status mark (a finished call shows its check alone; Running and Failed keep
their words); a settled run folds behind "N tool calls" at Low (naming any
failed calls) and starts open at Medium and High, a finished call's detail
opens at High, and an open run past five rows shows its latest five behind
"+N earlier". A change of level remounts them.

## Streaming and earlier messages

A streaming answer is revealed at an even pace, not as the bursts arrive. The
view keeps a smoothed measure of how fast text arrives and how often, holds back
about one arrival interval of it (between 50 and 400 milliseconds), and shows
text from that buffer on each animation frame at the arrival rate. It speeds up
gently when the backlog grows and never jumps, and it ends a step on a word
boundary when the word finishes within twelve characters. When the reveal falls
more than about 1.2 seconds behind (a reconnect or a large paste) it skips ahead
to the buffer. Answers of at least sixteen thousand text units step at most every
hundred milliseconds instead of every thirty-two, to bound the cost of parsing.
The first content, a replacement or shrunk text, and text already present when a
running thread opens appear immediately; only text that arrives afterwards is
paced. The finished answer drains its remaining text within one hundred
milliseconds. With reduced motion requested, text shows as it arrives. Pacing
happens before parsing the whole answer, so Markdown references and code fences
keep their document-wide meaning, and only the streaming message updates; it
does not delay provider data, journal writes or copy/export.

A thread opens on its newest messages. When earlier ones exist, one row above
the oldest loaded message offers **Load earlier messages** as a ghost button;
while a page loads it reads "Loading earlier messages" and stays focusable, a
failed page says "Earlier messages could not be loaded." with **Try again**,
and once the start is reached it says "No earlier messages" in the meta ink.
The row is 32px tall in every state, because it sits above what the reader is
looking at, and an arriving page keeps the reader's row where it was. A thread
that never had earlier messages shows no row. Only a new last message is
announced; earlier messages arriving above are not.

Chat, Work, and Code all open at the end and follow new output while the
reader is there; a reader who has scrolled up stays on their row while turns
arrive below. A Code fork's own messages come first; below them the row goes on
into the messages it was forked from, at the fork point, and up the thread it
came from, so a fork reads as one conversation. Coming back to a thread puts
the reader back on the row they left when its loaded messages still start where
they did, and at the end otherwise. While a reader is scrolled away from the
end of a following transcript, a secondary **Jump to latest** button floats at
the foot of the transcript; it returns to the end, resumes following, and goes
away once the reader is back at the end.

Find (⌘F, Ctrl+F) opens for the thread in the active pane, including while
focus is still on the sidebar row that just chose it; the code editor and the
terminal keep their own Find. Closing the find bar returns focus to what had it
when Find opened, or to the transcript when that is gone.

A jump to a Chat message that is not loaded, such as a search hit, shows the
run of messages that ends with it in place of the newest ones, with the Load
earlier row above it. One row below that run holds **Load later messages** and
**Jump to latest** as ghost buttons, 32px tall in every state; while a page
loads the first reads "Loading later messages" and stays focusable, and a
failed page says "Later messages could not be loaded." with **Try again**.
Load later keeps the reader's row in place rather than following the new
rows to their end. Once a later page reaches the newest messages the two runs
become one and the row goes away, with the reader's row where it was; Jump to
latest, or sending a message, returns to the newest messages at the end. A
jump happens once: after its message has been shown, nothing jumps back to it.

## Message actions

Message timestamps and direct Copy controls share one reserved row. They appear
on message hover or keyboard focus and stay visible on touch and high-contrast
interfaces. Revealing them must not move the transcript.

## Outside content on tool rows

A Code, Chat, or Work tool row whose result was outside content carries an
"Outside content" tag, followed by what Octant Shield's Watcher found in it in
the warning role, and a Code thread's board card a small mark; at Full access
the tag stays quiet. A call Octant refused because it named a protected secret
file carries the same tag, naming that finding.
Neither prompts.

The thread itself says it is marked in two places, with no popover (a
maintainer's choice, 2026-11-14). The Environment panel carries a calm row,
"Outside content · read N times", with Review; its globe is in the warning ink
only while the mark has effect, which is below Full access. In the composer's
row a 16px warning globe with no words sits immediately before the mode
control, only below Full access, named "This thread read outside content, so
risky actions ask first. Review in Environment."; it appears and goes with the
mode or a clear, never while the person types. Both open one dialog, "Outside
content in this thread": the sources with their counts and times, one plain
paragraph (the thread read text from outside Octant, risky actions ask first
while it is marked, clearing says the person checked it and undoes nothing the
model read, and new outside content marks it again), and the buttons Cancel
and Clear mark. The mark stays server-owned: the renderer shows it and sends
the existing clear.

## Choosing a subagent model in a prompt

Typing `@model` (or a prefix of it) offers **@model** as the first row of the
`@` menu at the caret, and Enter on it opens a searchable picker. The row does
not open the picker by itself, so a file mention that passes through `@model`
while it is typed (`@models/schema.ts`) keeps the keyboard. The picker lists
every model a ready (or degraded) configured provider serves that can run
Octant's tools, the rule the host applies to a subagent's target; a model
served by two configured providers appears twice, with each provider's logo
and name.
Choosing a row opens the reasoning choices advertised for that route (the
model's `reasoning` or `effort` values), including **Provider default**; a
model that advertises none is inserted at once. Enter inserts the selection.
Escape dismisses the picker and preserves the draft. Every thread composer
and the Chat Project quick start offer it.

The composer renders the selection inline as **provider logo – model –
reasoning**. The provider's name is the chip's accessible name and its tooltip,
and stands in for the logo when the provider has none. Activating the chip
reopens the picker with its current values. The prompt holds the selection as
plain text, `@model(<provider instance id>/<model id>, reasoning=<value>)`,
so copying it preserves the exact provider instance, model ID and optional
reasoning setting, and pasting a valid tag restores the chip. Omitting
reasoning selects the provider default. The caret and deletion treat a chip as
one unit.

A tag qualifies the subagent requested in the prompt. The parent thread keeps
its model. At launch the host resolves the exact configured provider instance
and model and validates any explicit reasoning setting against the values that
model advertises; an explicit route never falls back to another one. A chip
whose choice is unavailable (provider removed or not ready, model gone,
reasoning no longer offered) is outlined as needing attention and says why in
its name and tooltip, so the person can revise it before sending. Sending is
not blocked: the launch refuses the unavailable route, and the delegation tool
tells the parent agent to report which choice is unavailable rather than pick
another route. The child thread identifies the selected provider, model and
reasoning setting in its row.

Every composer's prompt is an editable element rather than a text field so the
chip can sit in the text (maintainer decision, 2026-11-23). It keeps a text
field's behavior for callers: its value is the plain-text prompt, Enter and
Shift+Enter, paste (as plain text), copy, cut and undo work as in a text
field, and a label names it. Rejected: a chip row above a text field with the
tag kept as text (not inline), and a styled highlight behind the tag text (no
logo or names).

## Mentioning a thread in a prompt

A thread chosen from the `#` list, dropped on the composer, or attached from
its row menu sits in the prompt as one inline chip: its Project's mark (a `#`
where it has none), its title, and a dot while it works or waits on the person
(maintainer decision, 2026-11-25). There is no chip row above the prompt. The
prompt's text stays `#[Title]`, so a copy, a queued message and the provider
read what they always did. The caret and deletion treat a chip as one unit, and
a cut and paste or an undo that brings the text back brings its thread back.
Chips whose threads share a title keep their own places through an edit, so
deleting one removes that thread and not the other; deleting the chip stops the
mention, and Remove takes the chip and its text together.

Hovering a chip opens the thread's card; pressing it, by pointer, touch or key,
opens the same card with focus in it. The card is the
[sidebar row's](workspace.md#sidebar): title, age, live state,
Project, checkout, provider and model. Below a rule it says what the turn gets:
"This turn reads up to its last 12 messages, read-only.", or that a mentioned
Chat can receive a message. Its actions are **Open thread**, **Side Chat** where
the composer offers it, and **Remove**. Pull requests and issues read there as
facts, not links. Hovering never moves focus from the prompt.

The card's facts are the threads the host already lists to the window, read by
thread id, so drawing it asks the host for nothing. A worker the sidebar leaves
out (Show workers off) is listed all the same, as it is for Needs you and
search. A thread the window does not list shows what the host's search said of it (title,
mode and Project) and no Open thread. A thread the host refused is outlined and
shows its reason and no other fact, even where the window lists it.

Each hit of the `#` list shows the same facts in a row: the Project's mark, the
title, the live state or the age, the provider and model, and the mode and
Project. A phone's row leaves out the model.

A sent message keeps its chips. The turn stores the mentioned ids and nothing
else of their threads ([Architecture](../architecture.md#modes-chat-work-and-code)),
in the order the text shows them. A message with exactly one chip text per id
pairs them in that order, renamed threads included; otherwise an id takes the
text its thread's title reads as now, unless an unlisted or renamed thread could
stand there instead. A chip only ever opens a thread the message mentioned.
A mention of a thread the window does not list, text no id
claims, and a message sent before ids were stored stay the text they were. A
side task's receipt opens the same card from the title of the thread it
started, while the window lists that thread.

Rejected: opening the thread on a press, which would leave a half-written prompt
by accident and leave touch with no way to the card.

## Subagents in a thread

A thread's subagents sit in a card attached above the composer's message
surface, edge to edge with it so the two read as one stack. The card
participates in normal layout so expansion cannot cover the preceding task list
or transcript. Cross-context notices share the same flow;
they never hide failed children or results needing review. The card starts
collapsed and remembers the viewer's fold choice. Its head names every state
the children are in as counts of that state ("1 failed · 1 to review · 1
working · 2 done"), attention states first, with no unexplained total. A result
counts as to review only while a person can still act on it: one the host has
already delivered to the parent, or the parent consumed through its own tool,
is done, because it sits in the thread as a child-result card. A truncated list
says earlier children are not retained. While a Chat thread's host cannot be
reached the card dims and withholds Stop; the thread's connection notice says why.
Task-plan completion is never counted as child completion. View all opens the
full Agents list even when every child has finished. Expansion previews at most
three active or unresolved children; longer history stays in Environment and
Agents. While the card is folded, no child needs attention (nothing failed,
waiting, stopped, of unknown status or to review) and at least one child is
working, its head reads one line in place of the counts, "Waiting on <A>, <B>
and N others" ("and 1 other" for one more; "Waiting on <A>" or "Waiting on <A>
and <B>" for one or two). The names are the longest-working children's task
first lines, oldest first, cut with an ellipsis to fit, each a link-styled
button that opens that child as the rows do. The head keeps its height and one
line, so swapping it for the counts moves nothing; expanded, or with anything
needing attention, the head shows the counts. Compact rows show task, semantic status, recorded model and available
activity. Each row also shows how long the child has run, measured from its request (or
first sight of a provider's own) to its last update and ticking while it works,
the same rule as the transcript's row, at the trailing edge in a slot of fixed
width: a finished child's time stops where it stopped. Raw identifiers and
workspace paths belong in details. Rows open the child in Agents. Only managed active children offer
Stop; Stop all asks first and names its managed scope. Headers and rows wrap at
narrow widths, disclosures work with the keyboard and retain visible focus,
and expanded lists have bounded height.

Each subagent also shows in the transcript, under the activity of the turn
that started it, as one quiet row like a tool row: its provider's logo, the
task's first line, its latest line (an observed child's own progress, a
managed run's result once it has one, else its state), the model and effort as
the picker names them ("Sonnet 5.5 High"; nothing when the run reported no
model), how long it has run (from its request or first sight to its last
update, ticking while it works), and its state mark at the trailing edge, in a
slot that keeps its width so nothing moves when a run finishes. The row is one
button that opens the child in Agents, as the card's rows do: Enter or Space on
it opens too, its name is the task and its state, and it keeps its look on
hover and press. A subagent
belongs to the turn that was running when it started, because the host links
a subagent to its thread and not to a turn: a turn owns the span from its start
to the next turn's. The rows and the composer's card read one shared summary
for the pane (maintainer request, 2026-11-17).

A result the host delivers into the parent thread is a turn the person did
not write, so it never renders as their right-aligned bubble. It is a
left-aligned child-result card in the thread's measure: a status mark and
"<Role> subagent finished" (or the state it stopped in), the provider and
model, the task in meta ink, then the reply as Markdown, folded after about
eight lines behind Show full result. A child that finished is not drawn as that
card at rest: its delivered result reads as one quiet centred line, "<Role>
subagent finished · worked 48s" (the run time by the rows' rule, left out when
no times are known), with the reply behind Show result, a disclosure that opens
the card in place and works from the keyboard. A subagent that stopped or
failed keeps the full card and gives the host's recorded reason in place of a
reply. Run ID, generation and provider ID sit behind a Details disclosure in
the opened card. The card is one component in Chat, Work and
Code; a delivery the card cannot read is shown as its text under a plain
"Subagent result" head.

Subagents the provider runtime started itself are rows in the same card,
counted and previewed by the same rules as managed runs, finished ones
included, each reading "Started by <provider>" with its model or "Model
unknown". Their detail shows reported activity, observation timing, available
lineage and explicit partial, truncated or conflicting history. They have no
managed conversation, workspace authority or result acknowledgement; their one
control is Stop, offered only where the running turn can stop that subagent
alone, and a stop request leaves the reported state until the provider reports
the subagent finished. Its detail shows the final summary (folded) and token
usage where the runtime reports them, "Usage not reported" otherwise. Every
row, managed or not, names its provider.

A result steered into the parent's running turn shows as the same child-result
line or card after that turn's reply, headed "Delivered into the running turn".

Managed result previews identify their execution generation and recorded model.
The result detail leads with the reported summary, files, checks and blockers;
exact run, parent, provider and workspace attribution is available in a separate
disclosure. Earlier generations keep their own attribution and evidence. Missing
or truncated results stay explicit. Provider-reported files remain unverified;
recorded tool output is inspectable without claiming that tool completion means
a check passed. A recorded Code generation offers Review changes and links its
captured paths into the existing Review surface. The saved comparison identifies
the child, generation, workspace and capture time; its partial and binary content
states stay explicit. It offers no staging, discard or parent-checkout editor
controls. Unavailable capture stays unavailable. Evidence references are disclosed
on request rather than presented as unsupported navigation links.

## Suggested follow-ups

A reply's suggested follow-ups sit as cards at the foot of the thread, just
above the composer, so the next task reads as the last thing the agent offered.
Each card is the radius-md bordered card on the surface fill: a small meta line
naming where it would run ("New task", "New task · own worktree", "Next step
here"), a dismiss control, the title at medium weight, two clamped lines of the
prompt in secondary ink, and one outline **Start…** (or **Use here…**) button.
Start… expands that card into a preview sentence of exactly what it would
create, with Cancel and **Start** (or **Use prompt**); nothing is created
before that. The same open suggestions also stand in a "Suggested tasks" card
at the top of the thread's Environment panel, without a second border, so an
offer the conversation has scrolled past stays in reach; it shows only while a
suggestion is open. A thread started from a suggested task nests one step in
under the thread that suggested it in the sidebar, joined by a thin hairline
elbow, even when it runs on its own worktree; the host remembers that link
past later replies and restarts, and answers it to a window only for threads
its sidebar already lists. A task whose parent is not in the same list stays
where it is. A thread started from a side task joins the same nesting: the
host replays the journaled start into the same link a suggested follow-up
carries. Side-task offers stack above them as hairline cards: a target icon
(branch for a worktree, new-message otherwise), the title, a dismiss control,
the one-line reason, a collapsed "Prompt" disclosure, and one primary
**Start in new worktree** / **Start in new thread** button. Once started, the
receipt names where the work went and, beside its Open link, the child
thread's live state in the sidebar rows' own vocabulary — **Working**,
**Needs you**, or **Finished** — read from the same navigation facts those
rows use, so receipt and row never disagree. A child the window cannot read
shows no state rather than a guessed one.

## Turn figures and plan usage

A thread's turn figures sit at the top of its Thread info panel, not under the
composer: with the row of controls and the line of figures under the box, plus a
card, the composer read as four stacked layers. A thread's composer
carries no plan usage and no strip of figures, so the box holds only the message
and its controls. The figures are one compact block of the 12px meta step in the meta
ink, separated by middle dots, with no hue on any number and no fill: the
thread's turns, input and output tokens, thinking tokens when the provider
reported them (part of the output), the cache hit, speed, first token, and cost.
The turn count never stands alone. The block wraps rather than scrolling, and a
figure that is approximate carries a leading tilde and a dotted underline that
explains it on hover; a figure the provider did not report is absent, never
zero. Its Turn details link, like Turn details in the context meter's popover,
opens the per-turn detail dialog, a plain definition list of tokens, timing, and
cost with Previous and Next turn controls. There is no hide control and no
setting: the panel is closed until asked for, so the figures cost the page
nothing.

**Plan meters.** Remaining plan usage shows in the rail's usage rings (the
account menu where no rail shows), on a start screen as the [plan usage line](start-screen.md#plan-usage-line)
at the end of the context-chip row above the card, and in Settings › Usage. It
does not stand beside a thread's composer, and the Environment panel's Usage row
shows the thread's own tokens and cost, not the plan. Its form is the start
screen's line: each window's share left and its reset, no bar (the bar meters
went with the Inbox card and the Usage bars setting, maintainer request,
2026-11-18). The line describes the provider the composer will send to (a start
screen follows the model menu's choice) and reads the same host observation as
the rail's rings. A provider that reports
no window shows none. The row under the box
([The row under the box](../../DESIGN.md#composer-row)) keeps its controls: the
approval mode is its shield icon alone, the model button names the model with a
chosen effort in muted ink and no chevron, the microphone sits just before send,
and send is the 28px icon button with an up arrow, with the control corner: the quiet secondary tile until there is something to send, then the accent primary (see [DESIGN.md: Composer row](../../DESIGN.md#composer-row)).

## Composer behavior

Work follow-up composers use the same attached context strip as Code, showing
the project and working folder instead of Git controls. Full paths require a
matching project binding revision; missing metadata never borrows another root.
The strip stays mounted while metadata loads, and full paths are available in
tooltips. Code retains its checkout, branch, diff, and pull-request controls.
Pane headers show thread titles without repeated project labels.

Start-screen composers ask in plain words ("Ask anything…"); a thread's
follow-up composer says "Reply…" in Chat, Work, and Code, and shows no rotating
tip. When the latest reply predicted the person's next message, or suggested a
next message for this thread ("Next step here"), the empty follow-up composer
shows it in place of "Reply…", with a quiet Tab key cap at its top-right, and a
bare Tab puts it in the draft (a "Next step here" suggestion is then marked
used). The prediction leads when there are both, because it is written as the
person would type it; it has no card, and it leaves the composer once the
person sends anything. Once anything is typed, or with a modifier held, Tab
keeps its ordinary meaning. Settings › General › Composer turns this off
everywhere or per mode ([Settings](settings.md)); off, the composer says
"Reply…" and Tab offers nothing, while the suggestion cards stay.

A start-screen composer in a window that reaches more than one computer shows
a computer picker. The thread is made on the computer it names, in one of that
computer's Projects, with its providers, models and defaults, and never on
this one in its place (maintainer decision, 2026-11-19). Built for a
computer the window paired directly: the pane shows that computer's own Code
start screen and threads, with the picker kept on top. Until the window can
route a create for any other computer, one aimed there is refused with a
sentence;
[Hub and spokes: the hub coordinates](hub-and-spokes.md#the-hub-coordinates-each-member-runs-its-own-work)).

Attachment and model controls sit on the left; access, context usage and send
stay together at the right edge even when the controls wrap. Menus use compact
interface text, and model choices stay in a bounded scrollable popup.
Sent messages do not repeat an access caption; the underlying history remains
authoritative.

In desktop and web composers, staged file chips show a 12px file-type glyph
beside the filename in Chat, Work, and Code. Use the document, code,
spreadsheet, archive, or image glyph for known filename extensions and the
plain file glyph otherwise. Composers recognize the Code file explorer's
code, document, and image extensions. The generic glyph fills the same space
while the file-type glyph loads. An available image thumbnail takes the glyph's
place. Long filenames truncate within the chip so its remove control stays
reachable.

### Saved drafts

The desktop and web composer in Chat, Work, and Code offers **Stash draft** and
**Saved drafts** in its + menu, for both the first message and follow-ups. A
focused composer uses ⌘S or Ctrl+S by default, remappable under Keyboard
shortcuts in Settings › Keybindings. With content it stashes the draft. When empty it restores the only
compatible entry or opens the list. Save and restore can include a draft with
only attachments or selected context. The editor still handles Save in the
editor's own focus.

The stash keeps the text, caret, file bytes, and every typed selection with its
original provenance. Choosing a saved draft appends it to the current draft
when all of it fits. Files stage through the destination's usual attachment
path. A selection belonging to a source conversation, checkout, or provider
scope keeps that binding. A to-do link also keeps its original list, mode and
Project, and the to-do must still be open. A refusal identifies what could not
move and keeps the full stash available.

Stash clears the composer after the save commits. Restore consumes the saved
entry when the whole destination draft is recoverable. If you reopen the
composer in a new window, look in **Saved drafts** for a restored first
message you left in the closed window. The list orders entries by when the
draft was last saved or revised, including entries recovered from a closed
window. Both actions are separate from send and the host's message queue. The
list offers removal of an individual saved draft.

## Image preview

An image attached in a composer, and an image on a sent message, is a button
named "Preview <name>". It opens a modal lightbox on the shared dialog: one
frame 32px inside the window for every image, the image fitted inside it, its
filename and size beneath, with "n of m" when the message has several. Arrow
keys step between the images of that message or composer; Escape or a press
outside closes it and returns focus to the thumbnail. Stepping never resizes
the frame. The lightbox loads when a thumbnail is available. If it fails to
load, opening the thumbnail shows a message with how to try again.

## Model picker

The compact model picker is one float with 12px corners. From the top: a row
of icon tabs (Favorites, Recent, then one tab per provider showing its mark;
the current tab has a quiet filled square behind its icon, and a tooltip names
each); the shared filled 32px search field, with no edge of its own; the model rows;
a hairline and the Reasoning row; a hairline and the service-tier row. Sub-provider
grouping stays as catalog chips under the search where a provider fronts several
catalogs. The picker of a thread whose model can no longer
change (a completed Work thread, which passes `locked`) keeps the name in the
ordinary meta ink (the blanket disabled opacity left it at 2.11:1) and looks
unpressable by its dimmed chevron, default cursor and absent hover; a picker
disabled for any other reason, such as a running turn or no ready provider,
keeps the ordinary disabled look.

A row is the menu's 28px row (44px with the account under the model): the
provider's mark, the model name, and at the end the ⌘ digit as quiet meta text
in a fixed right-aligned column, with the current model's check just before
it. The current row carries a check, never a fill (maintainer request,
2026-11-16); a row's star shows on hover, on focus,
or once it is on. A mixed list (Favorites, Recent, a search) names the account
under the model, since two accounts of one provider share a mark. The first
nine choosable rows show "⌘1" to "⌘9", and while the picker is open that chord
chooses the row; nothing is bound while it is closed. Typing a letter anywhere
in the picker goes to the search field, the arrows walk the rows (Up from the
first returns to the search field), and Enter chooses. A provider with more
than five models shows the first five and a quiet "Show more" line (a search
shows every match, and the chosen model is never left behind the fold); the
list scrolls inside the frame.

The popup is one fixed frame, 360px wide
and 376px tall (shorter only when the window is; it holds the rail, the search,
five rows with "Show more" and the two controls with no blank band, and a
longer list scrolls), opening 4px above its
trigger with its edge aligned to the trigger's end: switching Favorites,
Recent or a provider, an empty or short list, Show more, a search, and
choosing a model or a setting never resize or move it or its trigger. The
Reasoning and service-tier rows are always there for a picker whose caller can
set model options, so the frame does not depend on the model. Reasoning is a
segmented control of the levels the model declares, least to most, whose
segments size to their words so six levels (Low to Ultra) all read in full, with the
chosen level in accent ink on a raised segment, "Reasoning" on the left and
the model's name on the right; pressing the chosen level again returns to the
provider's default, and a chosen level shows at once and never snaps back
while it saves. A model with no levels keeps the row, disabled, with one line
saying so. The tier row is a segmented "Standard | Fast" (the provider's own
names, with a bolt on the fast one); a model with no faster tier keeps the row
disabled with its reason. The mode menu and
the other composer-row menus open above their button and never over it.
Choosing a model keeps the menu open, since the
reasoning level beneath is often the next choice. Explicit model and reasoning choices are remembered
locally for new threads; model settings are keyed by provider/model and restored only
while supported. Existing thread selections remain authoritative. The same picker
shows every declared model setting in Chat, Work, and Code. Paired model families
show Lead and Sidekick selectors above the Reasoning row, drawn from available catalog entries; choosing
one preserves the other choice and carries still-supported explicit effort and
speed settings. Devin's Speed is the tier row, Standard and Fast where the CLI
supports Fast Mode. Any other declared choice is a select above the Reasoning row. The settings area
scrolls within the bounded popup at narrow or short viewport sizes.
Model choices and settings wait for an asynchronous model change to finish before
accepting another edit, so the next configuration choice uses the confirmed pairing.

## Context meter

The context meter is a circular composer control, not a dock tab: a 16px
gauge with a full track and a 2px round-capped arc filled clockwise from
twelve o'clock by the used share. It is the one composer mark that carries
colour in every style: the arc is the palette's amber with its track a faint
step of the same hue, and from 80% the ring turns red, so how full the window
is reads at a glance. It
opens an opaque 320px popover: a header with the used and
maximum figures and share, one 4px segmented bar whose empty track is the free
space, a breakdown folded behind a chevron each time the popover opens, the
provider's limits as a name, a reset countdown or weekday, the share left, and a thin
bar each, and a footer action to the fuller surface (the context inspector, or
Usage for a provider the host does not plan). The breakdown lists only the
parts the data attributes: planned threads show their manifest categories,
overhead, reserve, and free space; a provider-run window shows the parts its
runtime reported (system prompt, system and MCP tools, memory files, skills,
agents, messages), or, for a runtime that reported none, the parts Octant can
count itself (Octant instructions, Octant tools, skills, attachments), and in
either case one `Other (provider)` remainder so the parts add up to what the
window holds. When Octant sent instructions, skills or attachments it cannot
count (the runtime does not say what it keeps, it compacted, or a turn went
uncounted), a line under the key says why they are in the remainder. With no parts it shows used and
free. The thread's input and output totals stay apart because they are sums over
turns, not parts of the window. A part Octant counted is marked `Estimated`,
with its accuracy (the existing exact tokenizer, model-family estimate and
conservative estimate labels) in the part's tooltip and in a line under the key;
the remainder after an estimate is marked the same way. Counts (tools, MCP, memory
files, skills, agents) use the harness breakdown's row style; tools the runtime
knows but has not loaded read `N deferred` and take no share of the bar.

Categorical colour: the parts of a
context window are categorical data, so they carry hue in every style, Default
included, beside the context ring as the second colour exception in that
style. Each category has one tone, taken from the palette roles in seven hues
and a second, darker step of each (the same hue mixed toward the ink, which only
raises contrast against the panel in either theme), and keeps it wherever it
appears: the popover's bar and key, and the swatch on the context inspector's
entries. Categories are listed in one fixed order (the contract's category order
for a planned thread, a fixed part order for a provider-run window) and the
tones are chosen against that order, so neighbours differ clearly. A category
that is the same thing in both kinds of window (conversation and messages, MCP
and MCP tools, Octant tools and system tools, provider framing and system
prompt, a profile's instructions and Octant instructions, workspace context and
attachments, what nothing accounts for) shares one tone. Neighbour contrast is
measured, not judged by eye: every tone holds at least 5.2:1 against the popover
in light and dark, and every neighbouring pair stays clearly apart in OKLab.
Adjacent lightness ratios stay under 2:1, because seven hues that each clear 5:1
cannot also sit 3:1 from one another; the one-pixel gap and the name beside every
swatch carry the rest. `visualLanguageContract.test.ts` computes both from the
stylesheet and owns the enforced floors. Red is left to the ring's near-full warning. **Free space and Reserved stay
neutral**: no hue, the panel's ink mixed into its ground, with Free space drawn
as the bar's empty track. Every part is named beside its swatch and carries its
tokens and share, so hue never stands alone. The exception is scoped to these
segments in `visualLanguageContract.test.ts`: in `context.css` palette colour
may appear only on the tone rules, the ring and the limit bars. Limit bars fill
in blue, by the share left. A limit near its cap is marked on its row and in its bar's value text,
never by ink alone. Unknown or stale data is labeled as such and never rendered as zero.
Where a provider runtime compacts the session by itself and has said where, one
secondary line under the window bar reads `N until auto-compact` in the bar's
compact token format (the room between that point and the latest request's
fill, or `At the auto-compact threshold` once none is left). The line is
shown only for automatic compaction with a reported point, never derived from the
window, and it leaves the ring and the bar's colours alone.

## Plans and task lists

The task visualizer is a compact composer-adjacent chip backed by the thread's
journaled plan. It appears only when a real plan exists, shows proposed review
or `Step n / total`, and opens a popover with title, step states, evidence, and
start/finish/reopen/drop actions when approved. It must not invent progress from
assistant prose or display an empty plan form.

A Code thread without a current journaled plan offers Propose plan beside the
composer's attachment controls. It opens the existing plan form in a labeled
dialog, with keyboard focus restored on cancellation. Submission records a
proposed artifact and does not approve it or change execution access. The
entry returns after withdrawal; the dock stays artifact-only.

The provider's recorded task list is a separate group, drawn inside the turn
that recorded it in Chat, Work and Code alike (maintainer decision,
2026-11-24): Chat draws it in the reply before its answer, Work and Code at the
turn's end, and the turn's live line follows it. Code used to pin only the
newest list above the composer and drop it once the turn settled, so a
finished list left the transcript; its task rows are no longer drawn among the
turn's tool rows either. A reopened Code thread shows no past task lists yet,
because Code's conversation read carries none. It is open while the
turn that recorded it runs, so the step in hand reads without a click, and
folds to its header once the turn settles; a person's own open or fold wins
over both. The header keeps completed/total progress and failed or waiting
counts visible while folded. An unfinished list after a settled turn says
Incomplete; it does not claim that the agent is still running. The open list
shows the recorded ordered steps in a bounded, scrollable list: the running
step at Medium (500), finished steps struck through in secondary ink, and no
fill on any row. A task still marked running when its turn has stopped takes the
not-started mark and is read as "not finished", never a spinner. Each row ends
with its state in words for a screen reader, since the marks are drawn for
the eye only. A provider that words a task for while it runs (Claude's
`activeForm`: "Running the test suite" for "Run the test suite") has that
wording shown for the running task, and in the header when nothing failed or
waits, only while the turn is running; once the turn has stopped the task is
named plainly, so a stopped turn never reads as still working. A provider
without running wording (Codex) shows the plain wording throughout. The
running wording is untrusted provider text, bounded and redacted like the
plain one, optional in every journaled task so older journals replay
unchanged, and task rows never count as tool calls or steps.

A person who wants the list in view whatever they scroll to can open the
**Tasks** dock tool from More tools ([Workspace: Right dock and bottom
panel](workspace.md#right-dock-and-bottom-panel)). It is never opened for them.
It shows the thread's newest task list, the same one the transcript shows (read
from the thread's own view, so the two never disagree), kept open whether or
not the turn runs, with the same header and wording rules; a thread whose view
shows no list says "No task list yet". The Propose plan entry above still adds
nothing to the dock; the Tasks tool is the provider's list, not the plan. Neither this list nor the journaled plan borrows progress,
completion, or authority from the subagent group.

## Message queue and Stop

While a turn runs, its composer keeps a **Queue message**
action and shows a
**Stop turn** control beside it; that control stays disabled until the host has
admitted the turn. Accepted messages appear in the queue count. The idle action
sends normally when there are no pending messages or queue holds.

Accepted messages appear in a compact, initially collapsed queue above the
composer in Chat, Work and Code. Its header shows the message count and status;
expanding it reveals pending text, edit, move and remove controls, plus pause
and resume. A held reason remains visible when collapsed. Controls operate on the
host's current version; conflicting edits refresh the list and preserve the
person's unsent text. A failed enqueue leaves the draft and attachments in the
composer. Reopening a thread reads the accepted queue from the host without
resending it. Queue controls remain keyboard accessible and wrap at narrow
widths. There is no separate steering control: steering goes through the
queue's own send.

In Work and Code a message sent while the turn runs is steered into that
turn where its runtime steers (maintainer decision, 2026-11-21;
[Architecture](../architecture.md#persistence)): it passes through the queue,
leaves it once the runtime takes it, and shows inside the running turn, after
its reply, as the person's message headed "Sent while the turn ran", with its
time. The phone's Work and Code transcripts show it the same way, in the
person's message bubble under the same heading. The queue shows no separate
steered state, since its read lists only messages still waiting. While the
runtime has not yet taken it, that one message shows "Sending into the
running turn" and cannot be edited, removed or
moved; the rest of the queue stays usable. A transcript read afresh shows it
at once, and so does an open desktop Work transcript, which reads the running
turn again without losing the reply streamed so far; an open desktop Code
transcript shows it when the turn settles or is read again. A message the runtime does not take stays in the queue for
the next turn.

## Scheduled wake-ups

A Work or Code thread whose agent scheduled a wake-up shows one row per
waiting wake-up above the message queue, in the composer: an alarm-clock
icon, **Wakes** and the next fire time (weekday and local time), the
wake-up's prompt on one line (its full text on hover), and **Cancel**. A
wake-up that came due while Octant was not running reads **Missed** with its
time and "Octant was not running", in primary text, with **Run now** beside
Cancel; nothing runs it until the person chooses. With no waiting wake-up the
rows take no space. At a narrow width the prompt drops below the time so the
buttons never cover it. A refused change (the wake-up already fired or was
cancelled, or the thread is busy for Run now) shows the host's sentence under
the rows. The rows refresh on the thread's follow-up notices and on a slow
visible-page interval. The turn a wake-up starts opens with the host heading
`Wake-up you scheduled earlier in this thread:` above its prompt. The rules
are in [Architecture: wake-ups](../architecture.md#modes-chat-work-and-code).

## Live tasks

A Work or Code thread whose last turn completed while background work it
started (a dev server, a watch) still runs shows one row above the message queue, in
the composer: an activity icon, each task's command on one line in monospace
(its full text on hover, wrapping under each other at a narrow width),
**Running** or the count running, and **Stop**, which stops the session and
every task in it. With no live task, and while a turn holds the session (the
turn shows its own task rows), the row takes no space. A failed stop shows a
sentence under the row. The row refreshes on the thread's follow-up notices
and on a slow visible-page interval. A turn the runtime starts by itself on
the idle thread opens with the host's line `The agent started this turn by
itself after background work it was running reported.` in place of a
person's message. The rules are in
[Provider runtimes](provider-runtimes.md#background-commands-and-runtime-started-turns).

## Plan-mode asks

When a Work or Code thread's agent asks to plan first, the pending request
reads
**Plan first**: the agent's sentence, then "This turn ends; the next one
runs in Plan, read-only.", with **Switch to Plan** and **Keep working**.
When it asks to leave Plan, the request reads **Approve the plan**: the
plan in a bordered monospace block under the sentence, keyboard-focusable
and scrolling inside the card past 18rem so the buttons stay in reach, then
"This turn ends; the next one runs at" the level it returns to, with
**Approve plan ·** that level and **Keep planning**. The rules are in
[Provider runtimes](provider-runtimes.md#plan-mode-as-level-changes).

The phone draws the same block on a Work thread's screen, above the
thread's level: the label, the agent's sentence, the plan whole in a
bordered monospace block that scrolls inside the card past 18rem, the line
saying what happens to this turn, and the two answers with the desktop's
words. The phone reads the thread's pending requests from the host and
sends only yes or no with the version it read; the host applies the level
change and journals it as the device. Approving a plan, which widens what
the next turn may do, asks for the phone's own confirmation (Face ID, Touch
ID or passcode) first; switching to Plan and keeping the level do not. A
Code thread's level-change ask stays with the desktop, like the phone's
other Code approvals.

Every other request a Work agent waits on draws on the same screen, oldest
first, with the desktop's words: a tool call as **Provider approval** (the
action and what it does, **Approve** and **Deny**), a question as its prompt,
each offered answer and **Type your own answer** with **Submit**, and a
questionnaire as each question with its limits (**Choose one**, **Select
1–n options**, a **(Recommended)** option, **Write another answer**), the
optional **Anything to add?**, **Send answers** and **Dismiss**, which ends
the question unanswered as the desktop's does. Each sends the answer and the
version it read through the same request route a window uses, and the host
journals it as the device. Approving a tool call lets the agent act, so it
asks for the phone's own confirmation first; denying, answering a question
and dismissing do not. A refusal (answered elsewhere, its version moved, the
thread's permissions changed since it asked) shows the host's sentence under
the card, which stays; an answer holding a path or link, which Work request
text never carries, is refused on the phone before it is sent.

## Sessions started outside Octant

An empty Work or Code thread whose provider keeps sessions of its own for the
folder its turns run in and its account, begun outside Octant, shows one row above the
message queue: a history icon, how many sessions there are, and **Continue
one**, which opens a list of them in place. Each choice shows the session's
title (its name, or the provider's summary of it) on one line, then its
branch and when it was last written; **Continue in this thread** starts the
thread from the chosen one. A refusal shows the host's sentence under the
row. Once the thread has a message the row is gone. A thread started from a
session shows, in the same place, its details row: **Continues a session
started outside Octant**, the session's own id in monospace (cut with an
ellipsis at a narrow width, whole on hover), and **Copy**. The rules are in
[Provider runtimes](provider-runtimes.md#sessions-started-outside-octant).

## Credential requests

A one-use credential request appears inline at the end of the Code conversation.
It uses a compact rounded card with a small lock mark, the credential label,
visible destination and one-use scope, followed by one short explanation and a
masked input. A keyboard-accessible reveal control returns to masked on submit.
The footer has a quiet privacy disclosure and right-aligned Decline and primary
action controls, using the shared native-density recipes. At narrow pane widths
the actions wrap beneath the disclosure, even in a wide application window.
Submitting once authorizes only the displayed operation; no second confirmation
repeats it. There is no remember checkbox. Enter in the credential field submits
this bounded integration request, except during text composition. The input
clears on submission, decline or cancellation. Accepted submissions stay disabled
until the host publishes an outcome; busy labels do not resize the action.
An uncertain response never resends automatically. Host-settled requests collapse
to a quiet status row; an unavailable status disables entry rather than trusting
a stale card.
The card is not an administrator-password dialog and is not a saved sign-in.

### Secret cards

A request for a [thread secret](../architecture.md#thread-secrets) appears inline
at the end of a Code or Work conversation as a compact rounded card: its title and
reason; where the agent named a setup page, a button named **Open** and the page's
host, with its whole address under it in monospace; one row of the source picker,
the input with its show button, and **Save securely**; then a quiet line with a
shield that says what can read the secret and for how long, the **Keep for** picker
and **Decline**. With several fields their labelled inputs are stacked and Save
securely moves to the footer. An account password adds a warning that it unlocks
the whole computer and that Octant cannot fill in a system dialog. The source
picker shows only where there is a choice: a value, a 1Password item or a
remembered secret of the same name. A 1Password source takes a typed `op://`
address or the item picker at the input's trailing edge, which goes from vault to
item to field with a filter and Back, and a checkbox to read the item again at
each use. Choosing another source keeps nothing of the one before. A field the
agent marked not secret shows what is typed, except on an account password's card,
which masks every field.

Clicking the card, outside its controls and not to select text, focuses its first
empty input. Enter submits, except during text composition. What is typed is sent
exactly as typed, stays in the card alone, and leaves the input as it is sent; it
comes back only when the host says it took nothing. A pasted value of several lines
is kept exactly and shown as their number, with a control to clear it; one longer
than 4,096 characters is not pasted, and the card says so. An outcome that is not known
says so, and nothing is sent twice. A value too short to hide, if a command prints
it, says so before it is sent. A refusal stays on the open card with what to do.
An answered card becomes one quiet row with its title and **Saved securely** or
**Declined**, until its turn ends. At narrow widths the row and the footer wrap.
A card never times out. The phone's card has the same parts in the phone's own
controls, asks for the phone's confirmation before Save, takes a value of one line,
and offers no 1Password.

## Native Code approvals

Native Code approvals use a compact 216px surface above the composer, with a
scrollable action and scope description, collapsible authority details, and a
fixed Cancel/Allow row. Duration remains in the host description; the button
does not imply a one-shot grant when the action grants access for the session.
Enter never implicitly grants access.
The isolated host document draws the same compact notice anatomy (semantic
marker, heading, readable detail, quiet border, and dismissive safe action)
using the owning window's resolved palette. It retains its own host-owned
markup and IPC; shared renderer components never grant Code authority. Long
paths and scope details wrap within the scrollable region rather than being
silently clipped.

## Draft continuity and composer notices

A new-task composer keeps its identity while its Project binding changes.
Message text and local input state reset only for an explicit New task action.
A refused binding keeps the prior authorized Project and draft. A new Chat's
first-run composer stages chosen or captured files as removable chips before the
thread exists; they upload to the thread once it is created and leave with the
first message, as a Work draft's images do, and the server's attachment checks
apply to them unchanged. Cross-Project
notices appear once beside the active draft composer, with a separate-window
action when available, as one of the composer's notice cards above the box. A note that stays until
the person acts is a card too; only a state its surface marks as passing is the
quiet line.
A notice card is a small floating glass card in the box's width, a few pixels
above it: the float fill and corner, a faint hairline, a 16px tone icon on a
round tinted dot as its only colour, the message in the primary ink with a second
part (a reset time) in the secondary ink, a small secondary action at the
trailing edge, and a fade and a 4px rise on entry (none under reduced motion).
Its look is [DESIGN.md: OctantAlert](../../DESIGN.md#octantalert).
Authority confirmations appear beside the owning composer in a trusted surface
owned by the desktop main process;
ordinary notice content cannot issue an approval receipt.

When a local Code composer creates a managed worktree, show a compact
disclosure below the composer. Move it below the first prompt when the
thread opens. The rows show resolving the base (or fetching it), checking
out files, running the optional Project setup, and starting the agent. The
host supplies Git durations and the recorded recipe supplies its duration.
An absent recipe is skipped. **Setup details** opens the thread's Worktrees
dialog, and **Cancel setup** stops a running recipe through the same control.
A planner approval uses the same disclosure. Its confirmation reports the
checkout complete when it returns, with no intermediate Git timing.
A successful start folds the stages into **Worktree ready** for the rest of
the window session. When earlier messages are still paged out, the disclosure
stays at the end of the loaded transcript. A refusal leaves the stages visible
beside the draft or thread, with the existing composer error, prompt recovery,
and empty-thread setup options.

### Project trust prompt

Adding a Project, or an extra folder, is the person's trust decision for every
agent on its threads, so outside Strict no thread asks to trust its Project
(maintainer decision, 2026-11-18, replacing the one trust prompt per Project of
2026-11-14). When a Strict Work or Code thread opens and its Project holds Project
code for the thread's key provider that the person has not allowed, the composer
shows one quiet notice card above the box. It is the neutral card, announced as a
status rather than an alert, and names the provider and what Strict holds:
"Strict holds this Project's own Claude Code settings and MCP servers until you
allow this Project's code. Its instruction files, such as AGENTS.md, already
load." Its actions are **Allow Project code** (secondary) and **Not now** (ghost)
at the trailing edge. Allow sends the Project's trust command, the same one
Project settings' Trusted providers sends, listing every key provider, so one
confirmation covers the Project; the card goes once the Project lists the
provider. Not now hides it for that Project in this viewer's browser only;
Trusted providers in Project settings still offers the list. A window with no
Project controller shows the words and Not now without Allow, and the host
refuses the command from anyone but its own person. The card never shows outside
Strict, for a Project that lists the provider, a Project folder without that
provider's Project code, or a provider that is not a key provider. Every ACP
agent is a key provider, so the card names Gemini CLI, Goose, Kimi Code, and the
others for the Project files their launches hold until then, and Codex for
`.codex/config.toml`, which refuses its Strict thread until allowed. The host's
answer and the entries it reads are in
[Architecture: Key providers run as themselves](../architecture.md#providers).

## Turn menu panels

A panel a turn's menu opens inline (a checkpoint's name, the question before
files are restored) takes focus once the menu has closed, the safe answer
first, and hands focus back to that turn's More actions control when it ends.

## Thread recap and notes

A thread's Thread info panel has two rows after its others: **Recap** and
**Notes** (maintainer decision, 2026-11-14), in Chat, Work and Code alike.

The recap is read on request: opening the row asks the host, which reads the
thread's newest transcript window through the owning mode's own reader under
the same open authority as a mention or Side Chat (40 messages), and returns
what was asked first and last, the latest reply, whether the person's last
message still waits for one, how many asks and replies it read, and the time of
the last message it read, so a recap opened before newer turns says how far it
reaches. When older messages fell outside the window it says it read the newest
only, and "Asked first" becomes "Earliest ask read". **Refresh** reads it again.
It quotes the thread and adds nothing, is not stored, and changes nothing.

Rationale: the recap is assembled by the host, not written by the thread's
model. A model-written recap would either be a turn in the thread, which puts
a request the person did not make into the transcript and the next turn's
context, or a turn outside it, which has no path today that bills, accounts
and refuses the way a thread turn does. A recap that only quotes the transcript
costs nothing, sends nothing to any provider, and cannot claim more than the
thread said. Files changed and open approvals stay in their own surfaces (the
turn's changes, the Inbox) rather than a second copy here.

Notes are the person's own text, each up to 4,000 characters and up to 100 a
thread, kept on the host as journal events on the thread (`thread.note-added`,
`thread.note-edited`, `thread.note-deleted`) and rebuilt from them at start.
The person adds, edits and deletes them in the row. A note is never sent to the
agent by itself: **Insert in message** puts its text after the composer's
draft, and it goes only if the person sends that message. Only a person's
actor writes a note: the host refuses one from a thread's agent or from the
host itself, and a device paired for someone other than the host's person
keeps no notes. Every note event names its thread, so purging the thread
erases its notes with it; a deleted note leaves the panel at once and its
journaled text goes with the thread. Neither a recap nor a note changes the
thread's authority, level or Done.
