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
  below checkout context. Code, Chat, and Work request rows use a neutral surface
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

## Remaining findings

### Provider identity uses a shared asset catalogue

Settings and the model picker now use the same bundled provider logos, with
per-asset source metadata and distribution notices. Generic endpoints retain a
generic mark because the endpoint can represent more than one provider. Black Forest Labs
and Ideogram now use sourced SVG marks as well, replacing the remaining
image-provider placeholders.

### Feature styles still duplicate shared control appearance

The stylesheet baseline currently records 387 control-repaint exceptions
across 22 files, 12 off-scale font-size exceptions, 12 literal-motion
exceptions, nine `!important` exceptions, and 12 heavier-weight exceptions.
These are tracked migration debt, not 432 independently verified visual bugs.
The checks prevent growth but do not mean every existing surface conforms.

Consolidate these when a surface is next changed: move appearance into the
existing recipe, retain feature layout rules, and lower the baseline. Avoid a
large stylesheet move during a functional fix.

### Secondary text has an extra implementation tier

The written language describes three text strengths, while
`octant-bridge.css` also derives `--oct-fg-2` from primary text at 90%.
This makes some secondary labels stronger than labels using the actual
secondary token. A later, visually verified pass should choose one consistent
secondary role and check light/dark contrast before changing all consumers.

### Profiles need a product decision, not an accidental removal

Personal profile and execution profiles describe different concepts. The
execution-profile workflow still has saved data, editing, and resolution
behavior. This pass reduces its visual weight without deleting it. Decide
whether to retain and clearly name that capability or deliberately retire it
with a data-preservation plan.

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
