# Design system assessment

Date: 8 September 2026

## Overall assessment

Octant has a coherent foundation: a neutral default palette, shared typography,
compact navigation, flat working regions, and a small set of owned controls.
The main source of inconsistency is the accumulation of feature-specific
styles and older rules alongside that foundation. A new visual system would
add another layer to maintain. Continuing to consolidate the existing one is
the better direction.

This pass improves the high-frequency surfaces while preserving themes,
backgrounds, mode navigation, saved profiles, and task data. The default design
language is monochrome; optional tinted themes, provider identity, diffs,
errors, and meaningful warning states remain distinct.

## Evidence and limits

The assessment covers `DESIGN.md`, the theme package, renderer fallback and
bridge, shared control recipes, shell, composers, Settings, model pickers,
Environment, activity preview, thread navigation, and pull request surfaces.
It also uses the supplied screenshots and the native inspection performed
before the Mac was locked.

A follow-up rendered review on 8 September covered all 17 available Settings
destinations in the local browser client, including expanded provider and
profile forms. That review found and corrected full-page model catalogs in
Chat/Navigator, inherited scroll on page navigation, and boxed harness slots.
Native transparency and physical title-bar clicks remain separate native QA;
this Settings pass does not establish those results.

## Settings follow-up

- Settings uses a centred 800px reading measure, quiet section captions, and
  consistent section spacing. The saved sidebar width remains shared with the
  main window until the narrow navigation drawer takes over.
- Ready providers open onto model visibility controls. Search, shown counts,
  and shared switches form a bounded list; routine connection diagnostics and
  capabilities remain available through a separate disclosure. Setup guidance
  and authentication problems remain visible.
- The account menu aligns with the leading edge of the identity row. Settings
  navigation distinguishes soft hover/focus from the selected destination.
- Shared preference sections and inline provider editors now use the flat page
  ground, a common reading edge, and hairline rows. Compact Save buttons retain
  provider-specific accessible names. Theme previews and actual review dialogs
  keep their meaningful boundaries.
- Model visibility is available after expanding a provider. It remains
  reversible, and hiding the last model no longer triggers automatic discovery
  and a Settings remount.
- Chat and Navigator use the shared compact chooser, rather than rendering the
  entire model catalog inside the page.
- Settings navigation resets only on a section change; model updates preserve
  the current scroll, while deep links retain their focused destination.
- All original Settings capabilities, user themes, backgrounds, and profiles
  remain available. Destructive and permission-related controls were not used
  during visual review.

## Settings stability assessment

The 8 September follow-up applied the frontend-design and production UX skill
criteria to all 17 available Settings destinations at 1280 × 720. Linear was
plugin-gated and inspected in source and component tests. The established
neutral palette, 800px measure, sentence-case hierarchy, and common control
edge fit a desktop workspace. Precision and predictable editing matter more
here than additional decoration or page animation.

| Surface               | Assessment                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General               | Shared row grammar; no unsolicited movement observed.                                                                                                                     |
| Appearance            | Consistent but dense; error feedback now has reserved space. User-triggered font expansion keeps its scroll anchor.                                                       |
| Keybindings           | Compact; the editor disclosure is an intentional compound control.                                                                                                        |
| Navigator             | Bounded model chooser and clear empty state.                                                                                                                              |
| Voice                 | Consistent endpoint groups; long guidance wraps within the reading column.                                                                                                |
| Image Generation      | Empty and disabled states retain ordinary field geometry.                                                                                                                 |
| Chat                  | Saved revisions update untouched values while retaining active drafts and focus. Manual textarea resizing remains available.                                              |
| Code                  | Saved defaults no longer remount the editor form; unfinished editor fields survive revisions.                                                                             |
| Providers & Models    | Fixed metadata columns, bounded model catalog, reserved feedback, and presentation-only model facts during checks. Authoritative eligibility still clears during probing. |
| Agents                | Sparse and consistent with the shared field recipe.                                                                                                                       |
| Octant Harness        | Aligned slot rows; long but navigable with the same page structure.                                                                                                       |
| Skills & Extensions   | Refresh retains installed controls; initial loading remains a distinct state. A failed refresh identifies the retained snapshot as the last loaded settings.              |
| GitHub                | Existing ready content remains mounted during refresh.                                                                                                                    |
| Usage                 | Existing data and filters remain visible during refresh.                                                                                                                  |
| Host                  | Data inventory is disclosed under Stored data; health stays visible. The follow-up document measures about 2,730px, down from about 6,700px.                              |
| Advanced              | Consistent maintenance and diagnostics fields.                                                                                                                            |
| Linear (plugin-gated) | Refresh retains the workspace and advanced draft; failure is shown inline. Verified by component regression, not a live authenticated integration.                        |

Direct pointer checks disproved the apparent scroll jumps produced by locator
clicks: the test tool had scrolled targets before clicking. No global scroll
restoration listener was added. Page navigation and deep-link focus keep their
existing behavior. Initial loading, explicit section expansion, textarea
resizing, and typing additional lines can legitimately change document height.

Provider connection forms retain their explicit revision reset when the
underlying instance configuration changes. These forms contain authentication
attempt state and uncontrolled configuration fields; this pass does not replace
that lifecycle with a generic draft cache. Model visibility updates belong to
the separate defaults revision and preserve the provider row and filter.

The density follow-up keeps interface typography and host health visible,
places specialist fonts and the host data inventory behind named disclosures,
and bounds installed-skill and collision lists. Their capabilities and drafts
remain available through the same controls. The audit
found no brass default surface. Semantic warning colours and provider identity
marks remain intentional.

The final follow-up composer was checked in a separate local headless browser
at 1280 × 900 and 760 × 720 after the Mac locked. Neither viewport overflowed
horizontally. With a simulated long feedback message, its measured frame stayed
at 520 × 134px at the same position. Provider discovery and list bounds also
remained unchanged across the sampled scan interval. Native checkout facts were
unavailable in that browser session; component tests cover the attached context
strip. Native transparency remains outside this evidence.

## Rendered follow-up evidence

- All 17 available Settings destinations were inspected in the local browser
  client. General profile fields, provider configuration, model lists, and
  narrow navigation were checked in expanded states.
- The shared picker held its bounds while switching between small and large
  catalogs and while searching. Its fixed viewport-based height leaves room for
  the trigger in short windows. At 760 × 720, both catalogs stayed inside the
  viewport and the Settings navigation used its drawer.
- A live model hide/restore preserved the expanded provider and its filter text.
  The model was restored. A separate regression covers focus preservation while
  discovery refreshes the provider registry.
- Changing Settings sections resets the content scroll to zero. Deep links
  retain their requested row, and ordinary model updates do not reset scroll.
- Access summaries and menus use the same posture wording across composers,
  Settings, profiles, Agents, and Automation. The former per-composer file-input
  hiding rules were removed after the shared attachment control took ownership.
- Thread context menus now use aligned icons, compact 26 px rows, a 248 px
  width, and grouped Copy actions. The rendered main menu is approximately
  323 px high for the current thread; submenus reuse its row recipe.
- Message timestamp and copy controls reveal together on hover or keyboard
  focus, preserving a 28 px reserved row. Touch and increased-contrast layouts
  keep them visible. Code calls its secondary action Copy message; Chat calls
  its combined turn/attachment/citation copy Copy turn with sources.
- Provider marks are bundled with source metadata and distribution notices.
  Generic compatibility endpoints remain generic. Background and theme options
  remain available, including explicitly selected tinted presets.

- Pending Code provider approvals and questions sit immediately above the input,
  above the attached checkout context. Code, Chat, and Work request rows use a neutral surface
  and muted icon without the old warning stripe; approval actions retain their
  existing authority checks.

## Surface assessment

| Area                      | Current direction and changes                                                                                                                                                                                                                        | Verification still needed                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Default palette           | Runtime defaults are neutral. The base stylesheet also uses neutral surfaces, glass, shadows, and routine completion fills. Routine Waiting marks use neutral ink; warnings retain their semantic role. The optional brass preset remains available. | Compare neutral light/dark defaults and tinted presets at normal and increased contrast.                    |
| Typography                | Page titles and subtitles use shared roles. Generic section headings use the display weight instead of a global 600-weight override.                                                                                                                 | Check hierarchy in Settings, PR detail, and dense dock sections at all interface sizes.                     |
| Workspace shell           | Main and Settings navigation use the same saved sidebar width. The native leading controls reserve space when the sidebar is collapsed; split close controls stay at the pane's trailing edge.                                                       | Physical close clicks with one and several panes, collapsed sidebar, and narrow windows.                    |
| Materials and backgrounds | Main and Settings sidebars follow the host-resolved material. Explicit opaque and reduced-transparency fallbacks remain. Background and theme controls are preserved.                                                                                | Confirm native translucency and readability with maximum background intensity and a custom photo.           |
| Composer                  | Shared attachment behavior, one chip-removal treatment, consistent posture wording, and compact control rows reduce variation across modes.                                                                                                          | Keyboard, paste, drop, unsupported-image feedback, and narrow composer wrapping.                            |
| Model picker              | Provider refresh preserves the active rail. The popup anchors to the trigger's trailing edge, uses a smaller stable frame, and scrolls internally. Select lists do not cover their own trigger with the selected item.                               | Open near every viewport edge; switch short/long catalogs, search, resize, and reopen after changing model. |
| Model visibility          | Provider model lists have a filter and reversible Shown/Hidden controls. Visibility persists across discovery. Existing task bindings remain usable.                                                                                                 | Hide, refresh, reopen, restore, and verify the all-hidden new-task state in the live app.                   |
| Settings                  | Shared title/subtitle roles, open sections, aligned rows, and scoped alerts replace several local treatments. Saved profiles remain visible while the long execution-context chooser is disclosed on demand.                                         | Check control alignment and error/loading states across every Settings page.                                |
| Environment               | The surface stays flat in the dock. Facts, actions, and disclosures share a compact rhythm. Server counts distinguish the checkout from elsewhere. Delivers controls have consistent icon spacing.                                                   | Expand/collapse every group at narrow width; verify long branch/path labels and zero states.                |
| Activity preview          | The preview belongs over the conversation. Environment contains the visibility control, not the preview itself.                                                                                                                                      | Position, resizing, keyboard controls, stop/approval controls, and multiple panes.                          |
| Thread list and menus     | Provider identity stays leading; one trailing status slot combines working, attention, snooze-ended, and unread states. Activity view uses the same symbols. Hover details and menus remain compact.                                                 | Long titles, active/unread/pinned states, pointer hover, keyboard opening, and dismissal.                   |
| Pull requests             | The main list uses shared page and section headers, regular rows, and responsive metadata.                                                                                                                                                           | Empty/error/loading states and long titles in both the list and dock reader.                                |
| Permission states         | Failed or interrupted turns clear unusable approvals. Browser grants are scoped to an isolated session and revoked on cancellation.                                                                                                                  | Complete an approved live browser turn and verify denial, stop, and expiry through the rendered UI.         |

## Findings and follow-up status

### Provider identity uses a shared asset catalogue

Settings and the model picker now use the same bundled provider logos, with
per-asset source metadata and distribution notices. Generic endpoints retain a
generic mark because the endpoint can represent more than one provider. Black Forest Labs
and Ideogram now use sourced SVG marks as well, replacing the remaining
image-provider placeholders.

### Feature styles still duplicate shared control appearance

The stylesheet baseline currently records 384 control-repaint exceptions
across 22 files, 12 off-scale font-size exceptions, 12 literal-motion
exceptions, nine `!important` exceptions, and 12 heavier-weight exceptions.
These are tracked migration debt, not 429 independently verified visual bugs.
The checks prevent growth but do not mean every existing surface conforms.

Consolidate these when a surface is next changed: move appearance into the
existing recipe, retain feature layout rules, and lower the baseline. Avoid a
large stylesheet move during a functional fix.

### Secondary text now follows the theme role

`--oct-fg-2` now aliases `--octant-text-secondary` directly, removing the
primary-at-90% implementation tier. Neutral light/dark secondary text measures
8.19:1 and 7.41:1 against the workspace; the retained tinted preset measures
5.58:1 and 6.12:1. These meet the normal-text contrast floor.

### Execution profiles retired from Settings

The execution-profile page and command-palette selection are removed because
profile resolution no longer supplies new-thread defaults. Provider, model,
and access choices belong to the composer. Saved records remain available to
existing thread labels and the automation catalog.

### Density and refresh follow-up

- Shared Settings disclosures retain mounted fields and drafts, and deep links
  reveal their enclosing details before focusing a control.
- Appearance shows interface typography first; code and terminal fonts remain
  available through named disclosures. The obsolete Focus ring color control
  is removed; imported theme compatibility values are preserved.
- Host keeps identity, health, lifecycle, and backup controls visible. The data
  inventory is under Stored data. A failed status refresh retains the page and
  an unfinished backup label while showing the failure.
- Installed skills and name collisions use bounded lists. Search, counts, and
  Show all stay reachable, and the collision summary remains visible.
- Redundant Settings input and navigation radii have been removed in favour of
  the shared controls, lowering the stylesheet repaint baseline.

### Follow-up verification

At 1280 × 720, the local browser measured total content height of 2,491px for
Appearance, 2,732px for Host, and 1,033px for Skills & Extensions. The previous
Host and Skills measurements were about 6,700px and 2,900px. The 480px Skills
layout had no horizontal overflow. Opening Code typography left the scroll
position at 411px before and after the pointer action.

Theme comparisons used temporary renderer token previews without saving user
preferences. The secondary text role passed the normal-text threshold on the
workspace in neutral light/dark and the retained tinted preset. This does not
establish native material contrast with every custom background. Native checks
remain unavailable while the Mac is locked.

The premium static audit reported two matches, both in test fixtures (an
intentionally inert mock button and a mock composer textarea), and no production
violations. Repository-owned UI checks remain the enforcement source.

## Full rendered audit follow-up

A fresh audit covered the native split Code window, Chat/Work/Code entry and
existing-thread surfaces, Inbox, both boards, PR list/detail, the utility dock,
all 17 available Settings destinations, Agents, Automations, Artifacts, Images,
Archive, theme switching, and narrow layouts.

It found and repaired issues that source-only assessment had missed:

- Dock overflow could sit under the window's bottom-panel control and trigger
  the wrong action. Actual hit tests now resolve More tools and Add tool to
  their own buttons; wider docks show additional tabs.
- PR selection opened Review invisibly behind the reader rule. The related
  detail now opens beside the list, and the list adapts to its pane width.
- PR detail inherited a compressed Delivery toolbar and oversized headings.
  It now has a dedicated compact layout and shared safe Markdown/code rendering.
- Image generator could retain an unrelated dock or remain layered over Archive.
  Global destinations now share one closing path.
- A Chat list reset erased the shared transcript gutter. New Chat also used a
  different context/control arrangement. Both now use the shared composition.
- Files briefly claimed no matches during loading. Settings drawer rows, select
  widths, early feedback spacing, and narrow surface headers also needed fixes.

Actual Light mode was checked and the original Dark/Obsidian selection restored.
No messages, generations, approvals, authentication changes, or destructive
settings actions were submitted. Temporary terminal views were opened for visual
inspection, no commands were entered, and their displayed sessions were stopped.

Initial native evidence confirmed matching sidebar widths and populated checkout
strips under both inputs. It also reproduced the main/Settings material mismatch.
After the Mac was unlocked, native verification exposed another override: the
application background replaced Strong sidebar vibrancy with Subtle while
Settings kept Strong. That fallback now applies only to opaque sidebars. The
native main and Settings materials match with the current Plum theme, Strong
vibrancy, and sidebar-covered background. Sidebar collapse/restore and dock
close/reopen passed, and the original layout was restored. The regression test
failed before the fix and all 40 window-chrome tests passed afterward. Native
traffic-light close/minimize/fullscreen actions were not exercised.

The follow-up implements local name resolution in both Usage surfaces, shorter
setup wording, and an explicit image-source/profile distinction. Full board
reason text is available through existing fact tooltips and detail views.
Historical tool rows use their parent turn's terminal status: an unresolved
call reads Unfinished with no spinner, never an invented success. Distinct
wrapper and nested tool events remain separate because they have separate ids.

The additional maintainer screenshots exposed Activity heading insets, cramped
secondary lines, and native document overscroll. Activity labels and titles now
share an inset, title contrast uses primary text, and project names have more
leading. The native root cannot scroll and Settings occupies a fixed viewport;
repeated end-of-page scrolling was checked in the unlocked app. Work's extra
toolbar is removed, with completion moved into its composer action menu. Chat
has no generic right or bottom utility region (0099).

Active agent/Picture in Picture, image-generation result, and authenticated
Linear states were unavailable. The provider configuration-isolation blocker
for the ordinary OpenCode browser flow remains separate from these UI fixes.

## Acceptance checklist for the unlocked app

1. Compare main and Settings sidebar widths after resizing, reopening, and
   switching modes; verify translucent and opaque host states.
2. Exercise split close controls with the sidebar open and collapsed using
   physical pointer clicks, then keyboard navigation.
3. Open the model picker above and below the composer, switch providers,
   filter, and resize; neither the page nor popup should jump.
4. Test model visibility across all picker surfaces, including an existing
   task on a hidden model and a new task with every model hidden.
5. Inspect Environment expanded and collapsed, with no servers, checkout
   servers, and servers elsewhere; the preview must remain over the conversation.
6. Check Settings, thread hover/menu, PR list/detail, and composers at narrow
   widths and large interface text. Confirm quiet visible keyboard cues.
7. Repeat the core views in neutral light/dark, a tinted preset, reduced
   motion/transparency, and with the custom background enabled.

The foundation is suitable for continued polish. Final acceptance should be
based on these rendered checks, with the preserved customization options
enabled, rather than on stylesheet checks alone.
