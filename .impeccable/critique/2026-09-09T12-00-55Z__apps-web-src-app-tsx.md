---
target: "all surfaces: Chat, Work, Code, Settings, Zen (apps/web)"
total_score: 23
max_score: 40
na_heuristics:
p0_count: 2
p1_count: 6
target_identity: "file:/Users/henrik/Dev/Repos/octant/apps/web/src/App.tsx"
target_fingerprint: "sha256:2d786dd9f648d2a16e96fca5823d240a819db74605b78d6de837dbf83abe32a4"
target_path: /Users/henrik/Dev/Repos/octant/apps/web/src/App.tsx
timestamp: 2026-09-09T12-00-55Z
slug: apps-web-src-app-tsx
---

Method: dual-agent (A: design review · B: detector + measured evidence). Evidence: 31 headless Chromium captures of the live dev host at 1440x900 (dark, 2x) plus one 1180x720 Zen capture; DOM-measured type metrics; token contrast computed from source; detector run over apps/web/src. Light scheme was not captured (the capture script stopped before that step). Two threads were pinned into a Zen space to see the populated state and removed again afterwards.

## Design Health Score

| #         | Heuristic                       | Score     | Key issue                                                                                                            |
| --------- | ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status     | 2         | Unanswered user turns in Chat carry no state; Zen cards show a composer, not the thread's state                      |
| 2         | Match System / Real World       | 2         | "Authorized work on this Mac", "fail-closed", ISO timestamps and UUIDs in the Zen picker                             |
| 3         | User Control and Freedom        | 2         | Zen cards cannot be tiled; Remove has no undo; toast has no dismiss; bottom panel follows the window                 |
| 4         | Consistency and Standards       | 2         | Title Case in Zen and parts of Settings rail; mono card heads; two select recipes; three title sizes                 |
| 5         | Error Prevention                | 3         | Approval gating is honest; "Reset all usage" looks like Export; cards spawn on top of each other                     |
| 6         | Recognition Rather Than Recall  | 2         | Text-only Zen bar; identical truncated sidebar titles; lane counts far from labels                                   |
| 7         | Flexibility and Efficiency      | 3         | Keybindings, palette and focus-space shortcuts exist; Zen has no tile, snap or arrange                               |
| 8         | Aesthetic and Minimalist Design | 2         | Zen shows three pills, a toast and a panel at once; Files dock says "unavailable" three ways; three chips per PR row |
| 9         | Error Recovery                  | 3         | Checkout-changed notice has one clear action; Files has none; Zen composer error is clipped                          |
| 10        | Help and Documentation          | 2         | Zen empty state is blank; "Tests: Open this tool" placeholder                                                        |
| **Total** |                                 | **23/40** | **Needs work; strong bones in Settings and the start screens**                                                       |

## Design Specificity Verdict

**LLM assessment.** Category-interchangeable shell with authored pockets. The dither ground behind the start screens, the Settings page recipe (one title, quiet section captions, label left, control right, no cards), the dock launcher list and the fail-closed notices are authored and worth protecting. Chat/Work/Code thread views are the category defaults (rail, hero, raised composer, right-aligned bubbles). Zen collapses authorship entirely: dot grid instead of the dither, monospace card heads, Title Case text buttons, 44px panel titles, ISO timestamps and UUIDs.

**Deterministic scan.** `impeccable detect` over apps/web/src: exit 2, one finding. `layout-transition` at apps/web/src/context/context.css:219 (a width transition on a popover meter fill). Real but low impact. No other rule fired.

**Measured evidence.**

- Shipped default UI size is 13 (packages/contracts/src/theme.ts:264); this machine runs 14. At 13 the ladder is 11 / 12 / 13 / 14; at 14 it is 11.85 / 12.92 / 14 / 15.08. Transcript Medium is a fixed 13px.
- Share of visible text under 12px per surface: Chat welcome 22%, Code welcome 36%, Code board 34%, Pull requests 62%, Skills 66%, Zen picker 43%. 486 nodes total, mostly `--oct-text-xs` (sidebar age, PR chips, skills metadata, model picker label, Zen card heads, stepper suffix) and the 10px avatar initials.
- Contrast: meta `#8a8a8a` on control `#2b2b2b` = 4.10:1, below AA. Used by `.zen-el-head` (the Zen card title, at 11.85px mono), `.sheet` headers, `.palette-foot`, `.notif-group`, `.screen-bar`, github search. Meta on card = 4.55:1 (barely passes). `--oct-fg-2` and `--oct-muted` resolve to the same colour, so the system has three text strengths, not four.
- Focus: global `:focus-visible { outline: none }` (octant.css:430). Ghost/outline buttons, nav rows and menu items get a 7% fill; `default`, `secondary`, `destructive` and `link` button variants have no visible focus at all. Inputs go to a white border.
- Accessible names: every audited button and menu item has a text or aria-label name in source; the earlier live tree read that showed unnamed items is not reproducible from the DOM.
- Zen facts: pins spawn at x = 64 + 32n, y = 96 + 32n (apps/server/src/zen/zenService.ts:367), default 420x260, minimum 200x100, bar 52px, reduced motion honoured for animated backgrounds.

## Overall Impression

The workbench is calm and honest, and Settings is the best-crafted surface in the app. The gaps are in the places people spend minutes, not seconds: the transcript is the smallest primary text on screen, the meta layer is at or below the accessibility line, and Zen is a free-form whiteboard with thread-shaped windows rather than a focus zone. The single biggest opportunity is rebuilding Zen as a tiled reading wall that shows thread state at a glance.

## What's Working

- The start screens (Chat, Work, Code welcome): greeting, shared 768px composer, "This computer" band, "Continue" list. Restrained and specific.
- Settings: one title, quiet captions, label/description left, control right, scheme thumbnails, font-size stepper, JSON behind disclosures. Keybindings is finished as is.
- Honest states: "Repository checkout changed" with one action; approval gating in the composer; the board lanes as monitors of real threads.

## Priority Issues

1. **[P0] Zen card body is a composer with zero transcript.** A supervision card that shows nothing being supervised fails the brief. Fix: default pin geometry 560x420 or larger; body renders the last assistant turn and the transcript tail; composer collapses to one line and expands on focus. `/impeccable shape`
2. **[P0] Every pin lands on the same cascade origin, so cards stack.** Two overlap now; six are unusable. Fix: automatic tiling (one fills, two split, three to four quarter, five to six thirds), reflow on remove; free placement and zoom only behind an explicit Arrange mode. `/impeccable layout`
3. **[P1] Default type is too small for long reading.** Shipped UI size 13 gives 11px meta and 13px transcript under 13px chrome. Fix: ship UI 14, Transcript Medium 14 and Large 16, meta floor 12px, avatar initials 11px; update DESIGN.md to match the build. `/impeccable typeset`
4. **[P1] Meta text on the control surface fails AA (4.10:1).** The Zen card title is the least legible label in the app. Fix: lift `--octant-text-muted` dark to about `#949494` (5.0:1 on control) or stop pairing meta with the control surface; give `--oct-fg-2` its own value so there are four honest strengths. `/impeccable audit`
5. **[P1] Keyboard focus is invisible on default, secondary, destructive and link buttons.** Fix: one quiet focus recipe for every control (fill lift plus a 1px hairline in `--octant-border-strong`, no accent ring), applied through the button recipe rather than per-surface rules. `/impeccable harden`
6. **[P1] Bottom panel notice follows the window onto Board, Pull requests and Inbox.** Takes 28% of a reader route with no thread. Fix: scope the bottom panel to the pane that owns the tool; close on reader routes, restore when the thread returns. `/impeccable polish`
7. **[P1] Zen picker prints ISO timestamps, provider UUIDs and raw model ids.** Fix: row = title, "Ferie · Chat · 2h ago · Codex CLI", Pin. Drop the instance id. `/impeccable clarify`
8. **[P1] Zen bar has nine Title Case text items.** Fix: five items, icon plus sentence-case label (Threads, Add, Spaces, Appearance, Exit); fold the spaces pill in; move Ask Navigator to the palette. `/impeccable distill`
9. **[P2] Zen card chrome is 11px mono meta grey with mono text buttons.** Fix: Inter 13 primary title, mode mark, one status token ("working 2m", "waiting on approval", "idle 15h"), one overflow menu; mono only for a path. `/impeccable typeset`
10. **[P2] Zen panels use a 44px title, cards inside cards, overflowing inputs and clipped chips, and overlap the zoom cluster.** Fix: one right-edge sheet using the Settings row recipe with a 20px title and a bottom inset clearing the bar. `/impeccable layout`
11. **[P2] Files dock states absence three times; "Tests: Open this tool" placeholder.** Fix: one sentence and no filter field when the checkout is unavailable; a real description for Tests. `/impeccable clarify`
12. **[P2] PR rows carry red, amber and green chips together plus seconds-precision timestamps and three refresh controls.** Fix: one state chip (the blocking one), "Mergeable" as neutral text, relative time, one refresh. `/impeccable quieter`
13. **[P3] Two select recipes (ghost vs bordered), "Reset appearance" three times, destructive Usage actions styled as exports, mixed Title Case in the Settings rail, identical truncated sidebar titles, green dot meaning both In progress and Done, sliders without a readout.** `/impeccable polish`
14. **[P3] Width transition on the context meter fill (context.css:219).** Animate a transform or clip instead. `/impeccable animate`

## Persona Red Flags

**Alex (power user supervising six threads):** Zen cannot hold six cards (same-origin spawn, no tiling, composer-only bodies). No working/waiting/idle token on a card. Board says "Waiting 4" while Inbox says "No thread is waiting on you". Board status line clipped without an ellipsis. Three refresh controls on Pull requests.

**Jordan (first-timer):** Zen opens as a blank dot grid with nine buttons and no sentence. "Authorized work on this Mac. A pinned card keeps its original authority.", "fail-closed", "Delivery evidence is stale or ambiguous", "invalid-skill-name: Skill package is unavailable for context." Two approval controls in one composer. Code welcome buries "Continue" under five suggestion cards and an indefinite "Checking what is assigned to you...". Unlabeled folder / plus / filter cluster in the Work and Code sidebars.

**Sam (low vision, 1.25x text):** Zen bar is already 1260px wide at 1x. Zen Appearance chips and Widgets inputs already clip at 1x. Card head at 11px mono meta on the control surface is below AA. Lane counts 280px from their labels. Six sliders with a 12px thumb and no readout. Green dot for both In progress and Done. Seconds-precision mono timestamps will wrap every PR row.

## Minor Observations

- Sentence-case rule breaks: "Zoom to Fit", "Hide Navigator Bar", "Side Chat", "Image Generation", "Octant Harness", "Skills & Extensions".
- Greeting uses the full name; the first name reads as a greeting.
- The "..." overflow in the Chat title band sits on its own row.
- Hover card overlaps the transcript instead of anchoring beside the rail.
- The pink avatar and the green send are the only saturated colours in the shell; the avatar reads as status.
- Timestamps use four formats: "16h", "1d ago", "1.9.2026, 02:42:37", ISO in Zen.
- Scheme thumbnails carry a green dot on every card including unselected ones.
- Zen toast repeats the card it announces.
- `.zen-el` uses raised elevation; tiled cards should be hairline-ringed and flat.
- Zen picker titles are bold on every entry, against the one-bold rule.

## Questions to Consider

- What if Zen had no canvas at all, just a wall that tiles itself, and "Arrange" was the exception?
- What would a card look like if its head showed only what a supervisor needs: name, state, elapsed?
- Does the app need two background systems (Settings Appearance and Zen Appearance), or one ground with a per-space dim?
- If the transcript is the text people read longest, why is it the smallest?
