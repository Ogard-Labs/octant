# Application ground

The picture or drawn field behind the start screens, or behind every page, and how text is kept readable over it. It is chosen in Settings › Appearance › Background. The material rules it sits under are in [DESIGN.md: Depth and material](../../DESIGN.md#depth-and-material).

## The ground

The screen sits on the application ground, set as two plain
choices. What: one of the first-party Zen pictures, a person's photo, a field
of pulsing characters, a field of dithered pixels, a flowing colour field, or
the plain page. A fresh install starts on Pulsing characters, behind the start
screens only: the glow it replaces competed with the heading. Soft glow, Graphite
and Sunset stay in the catalog as three Gradient pictures that each carry a light
and a dark print, so the ground follows the window's scheme; the stylesheet
swaps them by `data-octant-theme-mode`. A settings row written before the ground
existed replays as the plain page it showed. Effect: the picture is shown as it is, pixelated, or
dithered, at a chosen pixel size and colour count; an animated picture is
printed from its still frame. A printed picture is still unless a person sets
its Motion to Wave: then a click on a start screen pushes a ring outward
through its cells, each cell sampled from a little further in as the ring's
edge passes and lit toward the accent through the same dither, so the ring
stays in pixels; between clicks the print rests and draws nothing. A ground
saved with the retired dot pattern resolves to the plain page. Dithered pixels
is a drawn ground of square cells in the theme's primary ink, at most about
two-fifths opaque, whose brightness drifts in slow overlapping waves at twelve
frames a second and prints through a 4×4 ordered dither (or plain pixels) at
the chosen pixel size and number of shades; a click on a start screen sends
the same pushing, accent-lit ring through it at twenty-four frames a second,
for under two seconds. Flowing is a drawn ground of large, soft, edgeless
colour that drifts like ink in water, and only when a person picks it. Four
stops are taken from the theme's accent in OKLCH — a near-black deep tone, a
dark saturated reading of the accent, a brighter accent tone, and a vivid glow
with a slight hue shift — so a change of accent recolours the field over about
600 ms. Dark mode is predominantly dark: near-black at the top-left, the dark
accent through the middle, and one luminous corner at the bottom-right, never
a pastel wash. Light mode inverts that ramp into a pale wash whose every stop
still clears WCAG AA against primary text. The field is painted in one GPU pass at about half
resolution and thirty frames a second, paused while the window is hidden or
the ground is off-screen, and falls back to a few blurred radial gradients
that use the same stops when that path is unavailable. A static grain at a few
percent of opacity and a quiet vignette sit on top of either path so the wash
does not band. It answers no clicks. Motion Still holds it on one frame; Wave
lets the colour keep drifting. Reduced motion holds it still. Pulsing characters is the default drawn ground, and the one a start screen
shows on a fresh install: a canvas of small monospace letters and digits in the
theme's primary ink, at most 15% opaque, that shows only inside slowly drifting
patches and leaves the rest empty. Three patterns (round blotches, long
horizontal currents, rings) take turns every twenty seconds and cross-fade over
the last four. The middle of the page (of what the window shows, when the screen scrolls) is dimmed to 45% and comes back to full
strength at 30% of the page's size out, so the heading and the composer stay on
a calm page. The glyphs are painted once into a layer (a few per cent swap each
frame), and a frame only rewrites one alpha value per cell, so the cost does not
grow with the number of glyphs. It runs at about fifteen frames a second, and
stops while the document is hidden or the field is off screen. Its backing store
is capped at twice the display ratio and at about five million pixels, and its
setup waits for idle time. It fades in over 1.2 seconds once it has
drawn, sits behind the content with no pointer events and is hidden from
assistive technology. Reduced motion, or Motion Still, holds it on one still
frame and takes no rings. A click on empty ground (not on a control, a menu or a
dialog, and not the end of a drag or of a text selection) sends an uneven ring of
glyphs out across the field in the theme's accent, whose edge wobbles as it
grows, trailed by a fainter echo; about one click in six draws a heart instead.
The cells a ring crosses take the accent at the ring's strength (up to 90%
opaque) and scramble their glyphs faster, and the ring fades within two seconds.
Under the whole shell the field answers only a click on a start screen, never one
in a thread or a list. While a ring is alive the field runs at about forty frames
a second, and falls back to fifteen once it is gone. A saved choice always wins: only a fresh install and Reset take this default. Behind a
start screen every other ground is masked away behind the composer and fades out
below it, so the prompt and the recent-thread list read on the plain page; in the
light theme it fades out sooner, because dark text over a pale picture has
less contrast headroom than light text over a dark one. A person
may instead put the ground behind every page, from the workspace's leading
edge, and under the sidebar too when they ask for it (see [Depth and material](../../DESIGN.md#depth-and-material)). Every
surface that shows text or information softens it beneath one continuous
reading veil, the sheet colour at 80%, so it shows at about a fifth of its
strength and agent replies remain bare prose: a thread, every other pane
(a Project's page, Settings, a file, a preview), and every destination page
(Inbox, Board, Archive, Review, Projects, Agents, Automations, Artifacts, Image
generator). A start screen (a welcome or a new thread) is the one exception and
stays open on the ground. The veil is one rule in `surface.css` keyed on the
pane kind and the destination layers, never a colour per screen; a page drawn
over the panes clears their veil so the two never stack. Increased contrast turns the ground off; reduced motion
shows an animated picture's still frame. It is chosen in Settings ›
Appearance › Background. The phone shares the same pictures and print effect under
Appearance › Background.
When the ground runs behind everything, a start screen's reading column
carries a soft wash of the page colour that fades out before the edges (under
Glass the ground steps down instead, and the question and its hint carry a
thin glow in the page colour), and a
conversation pane's title rail shares the conversation's reading surface, so
no text sits straight on a busy photo.
