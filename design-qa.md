# Projects sidebar design QA

## Evidence

- Source visual truth: `/var/folders/vb/jn90x_6d5s349fcjcv580w6w0000gn/T/codex-clipboard-34d82eea-eba7-4d3e-bbfb-38760043575f.png`
- Rendered implementation: `/Users/henrik/.codex/visualizations/2026/09/15/01a0a5c1-00cd-7091-93a0-bc8e558b059d/projects-option-3-sidebar-corrected.jpg`
- Shared-material verification: `/Users/henrik/.codex/visualizations/2026/09/15/01a0a5c1-00cd-7091-93a0-bc8e558b059d/projects-shared-material-corrected.jpg`
- Side-by-side material comparison: `/Users/henrik/.codex/visualizations/2026/09/15/01a0a5c1-00cd-7091-93a0-bc8e558b059d/projects-shared-material-comparison.jpg`
- Source pixels: 1487 × 1058.
- Implementation pixels and browser viewport: 800 × 902 at device pixel ratio 1.
- Shared-material capture: a 1487 × 1058 CSS app surface scaled to 0.53 inside a 1280 × 720 browser viewport at device pixel ratio 1.
- Normalization: the combined material comparison places the source and shared-material capture in equal `object-fit: contain` regions. The material capture is authoritative for the column backgrounds and hairlines; the production-component capture is authoritative for component density and typography.
- State: dark Code workspace, Projects selected, one available Code Project selected, recent threads visible, management rows collapsed.

## Full-view comparison

Both artifacts now show the same three-part shell: Octant's global navigation at the far left, a Projects collection pane beside it, and the selected Project detail in the main workspace. The collection remains outside the workspace in the DOM, but its fill now uses the workspace material rather than the sidebar material. A hairline separates collection and detail without making the middle pane look like another navigation sidebar.

The implementation retains Octant's semantic theme tokens and existing relink/archive actions instead of copying the mock's warmer one-off tint or speculative controls. It uses additional sample Projects and threads to prove collection density and truncation.

## Focused-region comparison

No separate crop was required. The combined image keeps the three shell boundaries, Projects heading, search and filters, selected Project row, detail heading, and recent-thread hierarchy legible. Those are the fidelity-sensitive regions for this correction; there are no logos, illustrations, photographs, or custom raster assets to compare.

## Required fidelity surfaces

- Fonts and typography: the implementation retains Octant's bundled Inter declarations, type scale, weights, and truncation. The isolated Vite harness fell back to the system sans face because its filesystem allow-list excluded the canonical checkout's font file; typography fidelity therefore relies on the earlier production-component capture and unchanged theme wiring, while this corrected capture verifies layout ownership.
- Spacing and layout rhythm: the desktop shell uses the saved global-sidebar width, a 320px Projects collection pane, and the remaining width for Project detail. At the captured 800px breakpoint the two left tracks compress while staying distinct; the workspace does not absorb the collection.
- Colors and visual tokens: the global sidebar keeps `--octant-sidebar-*`; the Projects collection and detail both use `--oct-bg` or the matching `--octant-workspace-translucent*` tier. Hairlines provide separation and the middle pane adds no shadow or elevation.
- Image quality and asset fidelity: the selected direction contains no required imagery. Visible icons use Octant's existing Lucide set; no generated image, handcrafted SVG, emoji, or placeholder substitutes a source asset.
- Copy and content: Projects, Search Projects, All/Chat/Work/Code, Recent threads, New thread, relink, archive, and availability labels are product-accurate. Mock-only sample values are not shipped.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- P3: the source uses a warmer graphite cast. The implementation intentionally inherits the active Octant theme rather than defining a Projects-only palette.
- P3: the source exposes a Canvas hand-off row. The implementation retains the existing compact Canvases disclosure because the public canvas inventory owns that data and interaction.

## Comparison history

1. The first implementation put the Projects collection in a master-detail grid inside the main workspace. This was a P1 information-architecture mismatch: Option 3 shows the collection as a sidebar entity.
2. The collection was moved into `ShellSidebar` as a dedicated sibling of the primary navigation pane. `ProjectOverview` now renders detail only, and `ShellFrame` expands the sidebar track while Projects is active.
3. The next comparison showed the middle pane inheriting sidebar material, which made it look like a newly added navigation sidebar. This was a P2 surface-hierarchy mismatch against the maintainer's reference.
4. The collection pane now follows the workspace's opaque, translucent, subtle, strong, and reduced-transparency material states while retaining hairline boundaries and no elevation.
5. The revised material comparison shows the middle and right regions sharing one fill. Automated DOM assertions also prove that the Projects navigation remains contained by the app sidebar and has no `.workspace-layer` ancestor.

## Interaction and runtime checks

- Automated interaction coverage exercises the Projects destination, mode filters, search, Project selection, Add Project, New thread, and Memory disclosure.
- The browser-rendered capture uses production components and styles. The corrected sidebar remained visible during responsive capture with no visible runtime error surface; the harness logged only its known font allow-list warning and a transient hot-reload root warning before the final full-page reload.
- Focused shell and Projects tests pass, including explicit sidebar ownership and workspace exclusion assertions.
- Native-window capture remains unavailable because the Mac display is locked; the browser-rendered shell and integration tests cover the changed React surface.

## Implementation checklist

- [x] Projects is a first-class global-sidebar destination.
- [x] Opening Projects adds a dedicated secondary Projects sidebar.
- [x] The complete Project collection is outside the main workspace.
- [x] Selecting a Project updates only the adjacent detail workspace.
- [x] Search, mode filters, selection, and Project creation remain interactive.
- [x] Recent threads remain the primary Project detail content.
- [x] The changed shell ownership is covered by integration and component tests.

final result: passed
