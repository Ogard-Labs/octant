# Thread view

How a thread reads in Chat, Work, and Code: the turn header, the transcript, what a turn shows of its work, the composer's thread-specific parts, and the controls that sit beside it. The shared composer shape and row are in [DESIGN.md: Composer row](../../DESIGN.md#composer-row); behavior of panes and tools is in [Workspace](workspace.md).

## Turn header

Every assistant reply in Chat, Work, and Code opens with the same line: who
answered (provider and model as the picker names them), how the turn stands
(Working…, Waiting for approval, Completed with how long it took, Failed with
the host's sanitized reason on the line below), and when it last changed at the
right edge. It is set in the interface face at the detail size; only the status
word carries colour. `TurnHeader` in `apps/web/src/transcript/` is the one
recipe; a mode maps its own lifecycle onto its vocabulary and adds nothing of
its own.

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
continuous reading veil below the title band: the sheet colour at 80%, so the
ground stays faintly visible behind the transcript. Replies remain bare prose, including on translucent
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
does not count as a tool call. A Code turn that changed files ends with one card, the only card in a reply: "N files changed while this ran", then a 28px row per path with the folder in the meta ink, the name in the primary ink, and the added and removed line counts in the diff inks at the right. It folds after five rows, says "Showing n of N" when the record is incomplete rather than summing rows it never saw, and never says who wrote a file. A turn paused on the person uses a neutral composer-adjacent request row with
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
  shut. This is the transcript as it was before the setting.
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
second) and "Thinking" otherwise.

The folded "tool calls" group says what ran in marks, not only a count: an icon
and a number per kind, most frequent first ("terminal 4, file 5, pencil 2"), at
most four kinds and then "+n" for the rest. Its accessible name carries the
total and the words ("11 tool calls: 5 reads, 4 commands, 2 edits"). Opened,
each call is one row of fixed height: the kind icon, the name, a one-line
preview in the meta ink (a command's first line, a file's name, a search's
query) clipped with an ellipsis, the call's duration when the host recorded one,
and the status slot. The preview is drawn, not read: the detail under the row
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
level shows no menu (today a paired browser; not built yet: a paired device
changes it as a local window does).

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
route, which a window on the host reaches (a paired device too by maintainer
decision, 2026-11-12; not built yet); it is not part of any thread's
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

The displayed partial answer coalesces updates on a fifty-millisecond beat, or
one hundred milliseconds for long answers (at least sixteen thousand text
units). The first content, a replacement and the finished answer appear
immediately. Coalescing happens before parsing the whole answer, so Markdown
references and code fences keep their document-wide meaning; it does not delay
provider data, journal writes or copy/export.

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
Agents. Compact rows show task, semantic status, recorded model and available
activity. Age is explicitly time since the last update or first observation,
never inferred execution duration. Raw identifiers and workspace paths belong
in details. Rows open the child in Agents. Only managed active children offer
Stop; Stop all asks first and names its managed scope. Headers and rows wrap at
narrow widths, disclosures work with the keyboard and retain visible focus,
and expanded lists have bounded height.

A result the host delivers into the parent thread is a turn the person did
not write, so it never renders as their right-aligned bubble. It is a
left-aligned child-result card in the thread's measure: a status mark and
"<Role> subagent finished" (or the state it stopped in), the provider and
model, the task in meta ink, then the reply as Markdown, folded after about
eight lines behind Show full result. A subagent that stopped gives the host's
recorded reason in place of a reply. Run ID, generation and provider ID sit
behind a Details disclosure. The card is one component in Chat, Work and
Code; a delivery the card cannot read is shown as its text under a plain
"Subagent result" head.

Provider-observed children remain separate from managed runs. Their detail shows
reported activity, observation timing, available lineage and explicit partial,
truncated or conflicting history. An unknown model stays unknown. Observations
have no managed conversation, execution controls, workspace authority or result
acknowledgement.

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
where it is. Side-task offers stack above them as hairline cards: a target icon
(branch for a worktree, new-message otherwise), the title, a dismiss control,
the one-line reason, a collapsed "Prompt" disclosure, and one primary
**Start in new worktree** / **Start in new thread** button.

## Turn figures and plan meters

A thread's turn figures sit at the top of its Thread info panel, not under the
composer: with the row of controls and the line of figures under the box, plus a
card, the composer read as four stacked layers. Above the box, one strip holds
where the thread runs (Project and branch) on the left and the plan meters
described below on the right, so the box holds only the message and its
controls. The figures are one compact block of the 12px meta step in the meta
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

**Plan meters.** Remaining plan usage stands beside the composer, right-aligned on
the same row as where the work runs: the row under a thread's box, and on a
start screen the end of the context-chip row above the card (it drops to its
own right-aligned line when the chips leave no room). A meter is a bar and the
share **left**: `▬▬▬ 28%`. The bar is a 56px groove 6px tall with a raised
fill (the pressed-control inset on the track, the bevel's highlight on the
fill); the figure is in the primary ink at medium weight, in tabular numerals,
at the 12px meta step, with no fill behind the row. One meter carries no name:
the bar and its figure say what it is, and its tooltip and accessible name say
which window ("7-day limit, 28% left"). When a provider reports two windows
the shortest and the longest stand side by side, and only then does each lead
with a quiet name in words, `5h ▬▬▬ 85%  week ▬▬ 43%`, because two bare
figures cannot be told apart. (The single meter read `wk ▬ 28%`: a code to
look up beside a hairline.) They describe the
provider the composer will send to (a start screen follows the model menu's
choice) and read the same host observation as the rail's rings, picked by window
length (`windowSpan`). A provider that reports no window gets no meters, never
an empty bar. The fill is the theme's accent role (`--oct-accent`, the ink under
Mono); a window with a fifth or less left takes the warning ink and
a spent one the danger ink. The Appearance setting **Usage bars** (`usageBars`,
Settings › Appearance › Reading) chooses the bar: **Smooth** (default) is a
three-pixel rounded line; **Pixelated** is a 17 × 3 grid of 2px square cells with
1px gaps, lit in the same accent, whose last four columns thin out in steps (two
thirds, a checker, a third, a stipple) so the fill dissolves at its leading edge.
Neither animates, so reduced motion needs no variant. The row under the box
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
keeps its ordinary meaning.

Attachment and model controls sit on the left; access, context usage and send
stay together at the right edge even when the controls wrap. Menus use compact
interface text, and model choices stay in a bounded scrollable popup.
Sent messages do not repeat an access caption; the underlying history remains
authoritative.

## Image preview

An image attached in a composer, and an image on a sent message, is a button
named "Preview <name>". It opens a modal lightbox on the shared dialog: one
frame 32px inside the window for every image, the image fitted inside it, its
filename and size beneath, with "n of m" when the message has several. Arrow
keys step between the images of that message or composer; Escape or a press
outside closes it and returns focus to the thumbnail. Stepping never resizes
the frame.

## Model picker

The compact model picker is one float with 12px corners. From the top: a row
of icon tabs (Favorites, Recent, then one tab per provider showing its mark;
the current tab has a quiet filled square behind its icon, and a tooltip names
each); a borderless search field with a 1px accent underline; the model rows;
a hairline and the Reasoning row; a hairline and the service-tier row. Sub-provider
grouping stays as catalog chips under the search where a provider fronts several
catalogs. The picker of a thread whose model can no longer
change (a completed Work thread, which passes `locked`) keeps the name in the
ordinary meta ink (the blanket disabled opacity left it at 2.11:1) and looks
unpressable by its dimmed chevron, default cursor and absent hover; a picker
disabled for any other reason, such as a running turn or no ready provider,
keeps the ordinary disabled look.

A row is about 40px: the provider's mark, the model name, a small check right
after the name for the current model, and a hint chip at the right edge. The
current row carries the selected wash; a row's star shows on hover, on focus,
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
and 440px tall (shorter only when the window is), opening 8px above its
trigger with its edge aligned to the trigger's end: switching Favorites,
Recent or a provider, an empty or short list, Show more, a search, and
choosing a model or a setting never resize or move it or its trigger. The
Reasoning and service-tier rows are always there for a picker whose caller can
set model options, so the frame does not depend on the model. Reasoning is a
segmented control of the levels the model declares, least to most, with the
chosen level in accent ink on a raised segment, "Reasoning" on the left and
the model's name on the right; pressing the chosen level again returns to the
provider's default, and a chosen level shows at once and never snaps back
while it saves. A model with no levels keeps the row, disabled, with one line
saying so. The tier row is a segmented "Standard | Fast" (the provider's own
names, with a bolt on the fast one); a model with no faster tier keeps the row
disabled with its reason. The mode menu and
the other composer-row menus open 8px above their button and never over it.
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

The provider's recorded task list is a separate group. It is open while the
turn that recorded it runs, so the step in hand reads without a click, and
folds to its header once the turn settles; a person's own open or fold wins
over both. The header keeps completed/total progress and failed or waiting
counts visible while folded. An unfinished list after a settled turn says
Incomplete; it does not claim that the agent is still running. The open list
shows the recorded ordered steps in a bounded, scrollable list: the running
step at Medium (500), finished steps struck through in secondary ink, and no
fill on any row. Neither this list nor the journaled plan borrows progress,
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
widths. A running-turn steering control is separate and appears only where the
runtime supports it.

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
