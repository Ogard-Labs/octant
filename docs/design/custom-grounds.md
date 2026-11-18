# Custom grounds

Status: Building (slice 2 of 3)
Size: Full — it changes a wire contract, the renderer, Settings, the theme file and the plugin seam
Owner: maintainers · Started: 2026-11-18 · Approved: 2026-11-18, maintainers ("go with your recommendations")

This is a working plan. When a slice lands, its rules move into their owners,
[Application ground](application-ground.md) and
[Decisions and requirements](decisions.md), in the same PR, as the repository
requires.

## 1. Requirements

### Sources

| ID  | Location                                    | What it contributes                                                                                   |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| S1  | Maintainer, 2026-11-17                      | "Is there an easy way for users to make their own themes, backgrounds etc (like the ascii patterns)?" |
| S2  | Maintainer, 2026-11-18                      | Approved the three-step direction: own character field, grounds in theme files, plugin grounds        |
| S3  | [Application ground](application-ground.md) | Readability rules: ink cap, column dim, foot fade, contrast and motion settings win                   |
| S4  | `AGENTS.md`, plugin rules                   | Plugin-shaped, data only; install, trust and enable stay separate; extend a seam in its own change    |
| S5  | `DESIGN.md` principle 7                     | Nothing moves on click, hover, load or typing (controls stay put while the field changes)             |

### Requirements

| ID    | Requirement                                                                           | Priority | Acceptance criterion                                                                                                                                                                                   | Sources |
| ----- | ------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| FR-1  | A person chooses the characters the character field draws                             | Must     | Given Characters is the ground, when the person types `01` into Characters, then the field draws only `0` and `1`; Reset brings back the default letters and digits                                    | S1, S2  |
| FR-2  | A person chooses how much of the field shows (density)                                | Must     | At the highest density more cells are lit than at the default, and at the lowest fewer, for the same time and seed                                                                                     | S1      |
| FR-3  | A person chooses how fast the field drifts and its characters change (speed)          | Must     | At speed 0 the field holds one frame, like Motion Still; at the highest speed the patches move twice as far per second as today                                                                        | S1      |
| FR-4  | A person chooses the pattern: blotches, currents, rings, or all three in turn         | Should   | Picking Rings draws only the ring pattern and never cross-fades                                                                                                                                        | S1      |
| FR-5  | Changes show live in the real ground while the person edits                           | Must     | Typing or dragging updates the field before the setting is saved; leaving Settings keeps the saved value                                                                                               | S2      |
| FR-6  | The readability rules hold for any characters, density and speed                      | Must     | With `█` at the highest density, the field's average ink stays at or below the default field's; increased contrast turns it off; reduced motion holds one frame                                        | S3      |
| FR-7  | A theme file carries the whole ground, and importing one never leaves a broken ground | Must     | Export, then import on a computer without that theme's photo: the theme loads, the ground falls back to the plain page, and a note says the photo is not on this computer                              | S2      |
| FR-8  | A plugin can offer character grounds as data only                                     | Should   | An installed, trusted, enabled plugin's grounds appear in the Background picker; disabling the plugin removes them from the list; a manifest with code, images or a capability for a ground is refused | S2, S4  |
| NFR-1 | No added cost per frame                                                               | Must     | A frame still writes one alpha value per cell; changing the set repaints the glyph layer once                                                                                                          | S3      |
| NFR-2 | Old settings rows replay unchanged                                                    | Must     | A row without the new fields draws exactly today's field (existing replay tests pass unchanged)                                                                                                        | S3      |
| NFR-3 | The character text is safe to store and draw                                          | Must     | Control, format (bidi) and emoji characters are refused; at most 64 characters; whitespace is dropped                                                                                                  | S4      |

### Traceability

| Source statement                                        | Disposition                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| S1 "make their own themes"                              | Colour themes already exist (custom theme, import, export); out of this work |
| S1 "backgrounds … like the ascii patterns"              | FR-1 to FR-6                                                                 |
| S2 step 2 "backgrounds in theme files"                  | FR-7 (the file already carries the ground; see Codebase deltas)              |
| S2 step 3 "plugins contribute backgrounds as data only" | FR-8                                                                         |
| S3 readability, motion, contrast                        | FR-6, NFR-1                                                                  |
| S4 seam rule                                            | Slice 3 is its own PR                                                        |
| S5 nothing moves                                        | Settings rows keep fixed sizes; only the ground changes                      |

## 2. Scope

- In: FR-1 to FR-8, NFR-1 to NFR-3.
- Out: code-drawn grounds (shaders or scripts from a person or a plugin), uploaded fonts, colours chosen per ground (the field always uses the theme's ink and accent). Ruled here, by S4 and S3.
- Later: the same custom controls for the Pixel ground's scenes (Q-3); the phone drawing the character field, which it does not draw today (Q-4); sharing one ground on its own as a file.

## 3. Conceptual design

### Purpose

Let a person shape the character field they already see on the start screen,
keep that look in the theme file they share, and let plugins offer ready-made
fields, without weakening the rules that keep text readable.

### Context map

- The person edits in Settings (renderer). The choice is part of `ThemeSettings`,
  which the server validates and journals; every window and the phone read it back.
- A theme file comes from outside: untrusted input, decoded by the strict schema.
- A plugin manifest comes from outside: untrusted, decoded by `@octant/plugin-api`,
  listed only through effective activation (installed, trusted, enabled).
- Top threats: a character string that breaks layout or reading order (bidi
  controls), a colour emoji that ignores the theme's ink, a dense heavy set that
  drowns text, and a plugin smuggling code or images through a ground.

### Capabilities

| Capability                          | FR                     |
| ----------------------------------- | ---------------------- |
| Shape the character field           | FR-1, FR-2, FR-3, FR-4 |
| Preview while editing               | FR-5                   |
| Keep it readable whatever is chosen | FR-6, NFR-1, NFR-3     |
| Carry the ground in a theme file    | FR-7                   |
| Offer grounds from plugins          | FR-8                   |

### Components

| Component                                                                           | Responsibility                                                                              | Requirements               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| Ground contract (`packages/contracts/src/theme.ts`)                                 | Four optional fields on the ground's tuning                                                 | FR-1 to FR-4, NFR-2, NFR-3 |
| Character policy (`packages/domain/src/themePolicy.ts`)                             | Clean and check the character text; map density and speed to the field's numbers            | FR-1 to FR-3, NFR-3        |
| Character field (`apps/web/src/theme/appBackdropAscii.ts`)                          | Draw from the chosen characters, density, speed and pattern; scale ink by measured coverage | FR-1 to FR-4, FR-6, NFR-1  |
| Background Settings (`apps/web/src/settings/AppBackgroundSettings.tsx`)             | A "Customize" fold under Characters: text field with starter sets, Density, Speed, Pattern  | FR-1 to FR-5               |
| Theme file (`packages/theme/src/import.ts`)                                         | Import falls back when a photo is missing                                                   | FR-7                       |
| Ground contribution (`packages/contracts/src/extensions.ts`, `packages/plugin-api`) | A data-only ground declaration                                                              | FR-8                       |

### Domain concepts

- **Character set**: the cleaned list of characters the field picks from.
- **Density**: 0 to 100; how much of the field the drifting patches light.
- **Speed**: 0 to 100; 50 is today's field, 0 is still, 100 is twice as fast.
- **Pattern**: `cycle` (today), `blotches`, `currents` or `rings`.
- **Coverage**: the share of a cell a glyph inks, measured once when the glyph layer is painted.

## 4. Logical design

### Component contracts

| Component           | Provides                                                                                                                                                                                       | Guarantees                                                                                                        | Depends on             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Ground contract     | `characterSet?: string`, `characterDensity?: 0–100`, `characterSpeed?: 0–100`, `characterPattern?: "cycle" \| "blotches" \| "currents" \| "rings"` in `AppBackgroundTuning`                    | Absent fields decode and mean today's field; values outside range are refused                                     | Effect Schema          |
| Character policy    | `cleanCharacterSet(text) → { status: "ok", characterSet } \| { status: "refused", reason }`; the density and speed maths live in the field (`patchThresholds`, `meanStrength`), not the domain | Pure; refuses controls, format characters, emoji presentation; drops whitespace; at most 64 graphemes, at least 1 | none                   |
| Character field     | Draws with the four values                                                                                                                                                                     | Peak ink ≤ 15% × coverage scale; column dim and foot fade unchanged; one alpha write per cell                     | Character policy       |
| Background Settings | The Customize fold                                                                                                                                                                             | Rows have fixed heights; edits go to the theme draft, then save                                                   | Theme controller draft |
| Theme file          | `importThemeSettings`                                                                                                                                                                          | A photo ground whose photo is not in this host's library becomes `none`, and the import reports it                | Image library listing  |
| Ground contribution | `ExtensionGroundDeclaration` (name + the four values), its own component kind                                                                                                                  | No entry point, no capability, no content reference; refused otherwise                                            | plugin-host activation |

### Domain model

The ground stays one `AppBackground` value inside `ThemeSettings`. The four new
values live in the shared tuning, like `effectCell` and `motion`, so switching to
another ground and back keeps what the person set.

### Data ownership

| Datum                                    | Owner                                                            | Readers                               |
| ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| The person's ground, new fields included | Server theme settings (journal and projection)                   | Every window, the phone, theme export |
| A plugin's ground definitions            | That plugin's manifest, through plugin-host effective activation | Background Settings picker            |
| Measured glyph coverage                  | The character field, per glyph layer, in memory                  | The character field only              |

### Scenario walkthroughs

1. **Shape the field.** Person opens Settings › Appearance › Background, Characters,
   Customize, types `·•●` (Settings) → theme draft updates → `AppBackdrop` passes the
   values to the field → policy cleans the text → the field repaints its glyph layer
   and measures coverage → next frame draws the new set (FR-1, FR-5, FR-6) → the
   controller saves the draft → server decodes with the strict schema and journals →
   other windows redraw (NFR-2, NFR-3).
2. **Move a theme.** Export on computer A (the file already holds `appBackground`) →
   import on computer B → the photo id is not in B's library → ground becomes `none`
   and the import says so; everything else in the theme applies (FR-7).
3. **Plugin ground.** A plugin declares a ground component → plugin-api decodes it,
   refusing any code or capability → effective activation lists it while installed,
   trusted and enabled → person picks it → its four values are copied into the
   person's own ground (D-3) → disabling the plugin removes it from the list; the
   person's copy stays (FR-8).

### NFR mechanisms

| NFR   | Mechanism                                                                                                                                                     | Arithmetic                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-1 | A new set repaints the glyph layer once, as a resize already does; a frame still writes one alpha per cell. Coverage is measured on one 7 × 13 cell per glyph | Measuring 64 glyphs reads 64 × 91 = 5,824 pixels once; the per-frame work is unchanged                                                                                                                                                                                                                                       |
| FR-6  | Ink scale = min(1, coverage of default set ÷ coverage of chosen set)                                                                                          | Peak scale = min(1, coverage(default) ÷ coverage(set)) × min(1, `meanStrength`(50) ÷ `meanStrength`(density)); coverage is the mean alpha of a cell, `meanStrength` the mean patch strength over a fixed 120 × 48 grid at fixed times. Average ink never exceeds the default field at density 50; peak ink never exceeds 15% |
| NFR-2 | Every new field is `Schema.optional`; absent means today's constants                                                                                          | Existing replay tests run unchanged                                                                                                                                                                                                                                                                                          |

### Risk register

| Risk                                                   | Mitigation                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| A font lacks a chosen character and shows a box        | The system monospace stack falls back per glyph; the starter sets use characters every macOS and Windows monospace font has |
| A heavy set still feels loud even at equal average ink | Coverage scale plus the existing column dim; check on the mini with `█▓▒░` before merging slice 1                           |
| Settings grows long                                    | Everything sits in a folded "Customize" row, shown only when Characters is chosen                                           |
| Theme file from an older build lacks the fields        | They are optional; it imports as today's field                                                                              |

## 5. Decisions

### D-1: The new values live in the shared tuning (Accepted, 2026-11-18)

Context: the existing tuning travels with every ground kind so switching keeps what a person set.
Options: (a) fields on the Characters kind only; (b) fields in `AppBackgroundTuning`.
Choice: (b), matching `effectCell`, `motion` and `scene`, which only one kind reads too.
Consequences: other kinds carry and ignore them, as they already do for `scene`.

### D-2: Readability by measured coverage, not by a list of allowed characters (Accepted, 2026-11-18)

Context: FR-6 must hold for any characters; an allow-list would block many good sets.
Options: (a) allow-list; (b) measure each glyph's ink once and scale the peak ink.
Choice: (b), plus refusing only what cannot follow the ink colour or breaks text (emoji, controls).
Consequences: the scale is computed in the renderer at glyph-layer time; a unit test pins the formula.

### D-3: A plugin ground is copied when picked (Accepted, 2026-11-18)

Context: a saved reference to a plugin would dangle when it is disabled or removed.
Options: (a) save a reference to the plugin's ground; (b) copy its values into the person's ground.
Choice: (b). The choice never depends on a plugin's state; nothing needs a fallback.
Consequences: a plugin update does not change a ground already picked; the picker shows the plugin's current version.

### D-4: Plugin grounds are their own component kind (Accepted, 2026-11-18)

Context: a ground could ride on the theme declaration or stand alone.
Options: (a) an optional `ground` on `ExtensionThemeDeclaration`; (b) a new data-only `ground` component kind.
Choice: (b), so a plugin can offer a field without changing colours, and a theme can still name one later.
Consequences: one new kind in plugin-api and plugin-host activation, in its own PR (S4).

## 6. Coverage

| Requirement                                       | Component                         | Slice |
| ------------------------------------------------- | --------------------------------- | ----- |
| FR-1, FR-2, FR-3, FR-5, FR-6, NFR-1, NFR-2, NFR-3 | Contract, policy, field, Settings | 1     |
| FR-4                                              | Field, Settings                   | 2     |
| FR-7                                              | Theme file                        | 2     |
| FR-8                                              | Ground contribution, Settings     | 3     |

## 7. Build plan

| Slice | What it delivers                                                                                                               | Requirement IDs                                   | Status       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------ |
| 1     | Characters, density and speed end to end: contract, policy, field, Customize fold with starter sets, live preview, spec update | FR-1, FR-2, FR-3, FR-5, FR-6, NFR-1, NFR-2, NFR-3 | Done (#2655) |
| 2     | Pattern choice; theme import falls back for a missing photo                                                                    | FR-4, FR-7                                        | Building     |
| 3     | Plugin grounds as a data-only component kind (own PR, extends the seam)                                                        | FR-8                                              | Planned      |

Each slice gets a rendered check on the mini and a new visual-check scene for the Customize fold (with the `design change` label).

## 8. Open questions

| ID  | Question                                                                     | Blocks      | Asked of    |
| --- | ---------------------------------------------------------------------------- | ----------- | ----------- |
| Q-3 | Should the Pixel ground get custom controls too, later?                      | Nothing now | Maintainers |
| Q-4 | Should the phone draw the character field? It shows no character field today | Nothing now | Maintainers |

Answered 2026-11-18 (maintainers, "go with your recommendations"): Q-1, plugin
grounds are their own component kind (D-4); Q-2, emoji are refused (NFR-3).

## 9. Detailed design

### Slice 1

**Contract** (`packages/contracts/src/theme.ts`, `AppBackgroundTuning`):

```ts
characterSet: Schema.optional(AppBackgroundCharacterSet),       // 1–64 code points
characterDensity: Schema.optional(AppBackgroundPercent),        // 0–100, absent = 50
characterSpeed: Schema.optional(AppBackgroundPercent),          // 0–100, absent = 50
```

`AppBackgroundCharacterSet` is a string filtered by
`/^[^\p{C}\p{Z}\p{M}\s\p{Extended_Pictographic}]{1,64}$/u`: one code point is one
cell, so no controls, format or bidi characters, separators, whitespace,
combining marks or emoji. Literal example of a stored ground:
`{ "kind": "characters", "characterSet": "·•●", "characterDensity": 70, "characterSpeed": 30 }`.
Pattern (`characterPattern`) waits for slice 2.

**Policy** (`packages/domain/src/themePolicy.ts`): `cleanCharacterSet(text)`
drops whitespace and repeats, then returns `{ status: "ok", characterSet }` or
`{ status: "refused", reason: "empty" | "too-long" | "unsupported" }`, using the
same pattern as the contract. The resolved ground carries `characterSet`
(default the letters and digits), `characterDensity` and `characterSpeed`
(default 50).

**Field** (`apps/web/src/theme/appBackdropAscii.ts`): `runAsciiField` takes
`{ characterSet, density, speed }`.

- Density shifts the patch thresholds: `low = 0.52 + (50 − d) × 0.004`,
  `high = 0.82 + (50 − d) × 0.004` (d = 0 gives 0.72 / 1.02, d = 100 gives 0.32 / 0.62).
- Speed scales time and the glyph swap share by `s / 50`; speed 0 runs the
  still path (one frame, no rings), as Motion Still does.
- Coverage: each glyph is drawn once in a 7 × 13 cell at ratio 1; coverage is
  the mean alpha of the cell's pixels (alpha ÷ 255 summed), averaged over the
  set; glyphs are drawn with a maximum width of one cell. Peak ink =
  `0.15 × min(1, coverage(default) ÷ coverage(set)) × min(1, meanStrength(50) ÷ meanStrength(d))`,
  where `meanStrength(d)` is the patch strength averaged over a fixed 120 × 48
  grid of cells at a few fixed times, so a denser field draws fainter.
- A change of set repaints the glyph layer once; density and speed change only
  the frame maths.

**Settings** (`AppBackgroundSettings.tsx`): with Characters chosen, one folded
row "Customize". Open, it shows Characters (a text field and a menu of starter
sets: Letters and digits, Binary `01`, Dots `·•●`, Shades `░▒▓█`, Lines `─│┼╱╲`),
Density and Speed sliders, and Reset. Edits preview in the theme draft, so the
ground changes while typing or dragging, and are saved once on commit: slider
release, the text field's blur or Enter, a starter-set pick, or Reset; a refused text keeps the last good set, and the row's hint gives
way to "Emoji and spaces are left out." (shorter than the hint, so the row
never grows). Rows keep fixed heights, so nothing moves while editing.

**Failure modes**: a refused text never reaches the server (the contract would
refuse it anyway); a font without a glyph draws the system fallback, and the
coverage measure includes whatever was drawn.

**Tests for slice 1**:

- contracts: the three fields decode; a row without them decodes unchanged;
  emoji, a control character, a bidi override, a space and 65 characters are refused.
- domain: `cleanCharacterSet` cases; the resolver's defaults.
- field: density 100 lights more cells than 50, and 0 fewer (`patchStrength` at a fixed `t`);
  speed 0 draws one frame; the ink scale for `█` is below the default's and for the default is 1.
- Settings: typing `01` updates the draft; an emoji shows the note and keeps the set; Reset clears the three fields.
- Visual check: the Appearance scene with Customize open, committed with the `design change` label.

### Slice 2

**Pattern** (FR-4). Contract: `characterPattern: Schema.optional(Schema.Literal("cycle", "blotches", "currents", "rings"))` in `AppBackgroundTuning`; absent = `cycle`, today's field. The resolver carries it on `characters`. The field draws only the chosen pattern with no cross-fade, or cycles as now. `meanStrength` takes the pattern too, so the density scale (FR-6) holds for each pattern: one cached value per pattern and density. Settings: a Pattern select in Customize, between Characters and Density ("All in turn", "Blotches", "Currents", "Rings"), saved on pick; Reset clears it too. Example row: `{ "kind": "characters", "characterPattern": "rings" }`.

**Theme file with a missing photo** (FR-7). `importThemeSettings(input, { photoIds })` in `packages/theme/src/import.ts` stays pure: given the ids in this host's photo library, it returns `{ settings, missing: ReadonlyArray<"background-photo" | "sidebar-photo"> }`. A `photo` ground whose id is not listed becomes `{ kind: "none" }` with the same tuning; a Pixels ground's Picture photo is dropped (the Picture scene without a photo already draws Drift); a sidebar photo falls back to the sidebar's default. Without `photoIds` (no library read yet) nothing is changed, as today. The web import reads the library listing the shell already loads (`/api/theme/sidebar-backgrounds`) and shows one line after import: "The theme's photo is not on this computer, so the background is plain." (or "…the sidebar keeps its own look.").

**Tests**: contract decode and refusal of an unknown pattern; the field draws only rings for `rings` (no cross-fade at the pattern change time); `meanStrength` per pattern keeps FR-6; import with and without `photoIds`, for the ground, the Picture scene and the sidebar; the Settings select saves once; the web import shows the note.

### Slice 3

**Contract** (`packages/contracts/src/extensions.ts`): a new component kind `ground` and `ExtensionGroundDeclaration`:

```ts
{ characterSet, characterDensity?, characterSpeed?, characterPattern? }
```

with the same field schemas as the ground's tuning (imported from the theme contract, not copied). A `ground` component must carry `ground`, and must not carry an entry point, a configuration or content reference, or any declared capability; a `ground` on another kind is refused. Example component:
`{ "id": "dots", "kind": "ground", "displayName": "Night dots", "declaredCapabilities": [], "ground": { "characterSet": "·•●", "characterDensity": 60 } }`.

**Activation** (`packages/plugin-host`): `ground` is a renderer kind like `theme`; a pure `groundContributions(states)` lists the grounds of effective components only (installed, trusted, enabled), as `themeContributions` does for themes.

**Settings**: when any are listed, the Customize fold's starter menu gains a "From plugins" group with each ground's display name and plugin name. Picking one copies its values into the person's ground and saves once (D-3); disabling the plugin removes it from the menu and leaves the copy. A plugin can never set colours, motion past Speed 100, or anything outside the four values.

**Specs**: the plugin component table in `docs/architecture.md` (extensions and skills), `application-ground.md`, `decisions.md`.

**Tests**: plugin-api decodes a ground manifest and refuses one with an entry point, a capability, a content reference, colours, an emoji set, or a `ground` on another kind; activation lists only effective grounds; Settings shows them, a pick copies and saves once, and a disabled plugin's ground leaves the menu while the copy stays.

## 10. Verification

| Criterion                                                                             | Test                                                                                                                                                                                                          | Result       | Change      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------- |
| FR-1 Typing `01` draws only `0` and `1`; Reset restores the default                   | `AppBackgroundSettings.test.tsx`: updates the ground as a person types their own characters; resets the characters, density and speed to the default field                                                    | Pass         | #2655       |
| FR-2 Higher density lights more cells, lower fewer                                    | `appBackdropAscii.test.ts`: lights more cells at the highest density than at the default, and fewer at the lowest                                                                                             | Pass         | #2655       |
| FR-3 Speed 0 holds one frame                                                          | `appBackdropAscii.test.ts`: holds one frame at speed zero, however long it runs; `themePolicy.test.ts`: gives the character field the default set, density and speed, and carries a person's own              | Pass         | #2655       |
| FR-5 Edits preview live and save once                                                 | `AppBackgroundSettings.test.tsx`: previews slider and typing changes and saves once when the person lets go                                                                                                   | Pass         | #2655       |
| FR-6 Average ink never above the default field's                                      | `appBackdropAscii.test.ts`: never inks more on average than the default field, at any density or set                                                                                                          | Pass         | #2655       |
| NFR-1 One alpha value per cell per frame; a set change repaints once                  | `appBackdropAscii.test.ts`: keeps the field running when the set changes, repainting its glyphs once                                                                                                          | Pass         | #2655       |
| NFR-2 Old rows draw today's field                                                     | `theme.test.ts`: keeps the character field's set, density and speed, and decodes older rows without them                                                                                                      | Pass         | #2655       |
| NFR-3 Unsafe characters are refused                                                   | `theme.test.ts`: refuses character sets that are emoji, controls, bidi overrides, spaces or too long; `themePolicy.test.ts`: cleans typed characters and refuses what the field cannot draw                   | Pass         | #2655       |
| FR-4 Rings draws only rings and never cross-fades                                     | `appBackdropAscii.test.ts`: draws a held pattern alone, with no cross-fade where the cycle blends two; redraws a still field in place when the pattern changes                                                | Pass         | This change |
| FR-4 Unknown pattern refused, absent means all in turn                                | `theme.test.ts`: keeps the character field's chosen pattern and refuses one it does not draw; `themePolicy.test.ts`: gives the character field the default set, density and speed, and carries a person's own | Pass         | This change |
| FR-4 Density scale holds for each pattern (FR-6)                                      | `appBackdropAscii.test.ts`: never inks more on average than the default field, for any held pattern and density                                                                                               | Pass         | This change |
| FR-4 The Pattern select saves once; Reset clears it                                   | `AppBackgroundSettings.test.tsx`: saves the chosen pattern once on pick, and shows all in turn when none is stored; resets the characters, density and speed to the default field                             | Pass         | This change |
| FR-7 Missing ground, Picture and sidebar photos fall back; no library means no change | `import.test.ts`: importing a theme file whose photos this computer lacks (five cases)                                                                                                                        | Pass         | This change |
| FR-7 The web import reads the library and shows one line                              | `ThemeAppearanceEditor.test.tsx`: importing a theme file whose photo is not on this computer (two cases)                                                                                                      | Pass         | This change |
| Visual: Customize row gains Pattern                                                   | Scene `settings-background-custom` changes by one row; baseline decided by the `design change` label in CI                                                                                                    | Not run here | This change |

## 11. Codebase deltas and change log

### Codebase deltas

| Where code and plan differ                                                                                                                                                                                                                                                                                                                                                                                                 | Ruling                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The Octant theme file (`serializeOctantTheme`) already holds the whole `ThemeSettings`, the ground included                                                                                                                                                                                                                                                                                                                | Step 2 of the plan shrinks to the missing-photo fallback (FR-7)                                            |
| Plugin themes already carry `patternPalette`, inks for the ground's dither                                                                                                                                                                                                                                                                                                                                                 | Kept; a plugin ground uses the theme's ink and accent, never its own colours                               |
| Today (before slice 2) a theme with a photo id this host lacks imports without complaint: the server's theme service never checks that a `backgroundId` exists, so the row is saved as it is. The ground's photo fetch then answers 404, the renderer catches it and draws nothing (the plain page), while the stored row keeps the dead id and Settings still reads as Photo. A sidebar photo's fetch path was not traced | Slice 2 replaces the dead id on import and says so (FR-7)                                                  |
| `importThemeSettings` returned the settings alone                                                                                                                                                                                                                                                                                                                                                                          | It returns `{ settings, missing }`; its one caller (the web import) and its tests follow                   |
| The density scale was referenced to the chosen pattern in the plan's wording                                                                                                                                                                                                                                                                                                                                               | Referenced to the default field (all in turn, density 50) so a held pattern never inks more than it (FR-6) |

### Change log

- 2026-11-18: first draft.
- 2026-11-18: approved; Q-1 and Q-2 answered; D-1 to D-4 accepted; slice 1 detailed design; NFR-1 arithmetic corrected (the glyph layer is the whole field, not an atlas).
- 2026-11-18: slice 2 built: pattern choice and the missing-photo fallback; section 10 records verification for slices 1 and 2.
