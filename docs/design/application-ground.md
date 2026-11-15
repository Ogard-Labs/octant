# Application ground

The picture or drawn field behind the start screens, or behind every page, and how text is kept readable over it. It is chosen in Settings › Appearance › Background. The material rules it sits under are in [DESIGN.md: Depth and material](../../DESIGN.md#depth-and-material).

## The ground

The screen sits on the application ground, set as two plain
choices. What: one of the first-party Zen pictures, a person's photo, a field
of pulsing characters (the ASCII field), the pixel ground, a flowing colour field, or
the plain page. A fresh install starts on the ASCII field, behind the start
screens only: the glow it replaces competed with the heading. Soft glow, Graphite
and Sunset stay in the catalog as three Gradient pictures that each carry a light
and a dark print, so the ground follows the window's scheme; the stylesheet
swaps them by `data-octant-theme-mode`. A settings row written before the ground
existed replays as the plain page it showed. Effect: the picture is shown as it is, pixelated,
dithered, or in ASCII, at a chosen pixel size and colour count; an animated picture is
printed from its still frame. ASCII prints one character per cell from the
ramp ` .:-=+*#%@`, picked by the cell's luminance, each drawn as a 5×5 bitmap
glyph in the cell's sampled colour over that colour at half strength, so the
picture reads as a character mosaic. The glyph table is one pure table in
`@octant/domain`, which the desktop's canvas and the phone's shader both read,
because a GL shader has no font and a system font would differ between the
two. An ASCII cell is never smaller than 10 pixels (a 5×5 glyph below that
reads as a checker pattern on a phone), and choosing ASCII at a smaller saved
size starts it at 14; the ground at half the cell's colour keeps titles laid
over it readable. It has no
Colours dial. An ASCII print is always still: a wave pushing through
characters read as flicker, so it offers no Motion. Like every print,
increased contrast turns it off. Any other printed picture is still unless a person sets
its Motion to Wave: then a click on a start screen's empty space (never one on
a control or anywhere in the composer's box) pushes a ring outward
through its cells, each cell sampled from a little further in as the ring's
edge passes and lit toward the accent through the same dither, so the ring
stays in pixels; between clicks the print rests and draws nothing. A ground
saved with the retired dot pattern resolves to the plain page. The pixel ground
is the ASCII field's counterpart: a drawn ground of square cells, three CSS
pixels each by default, in the theme's primary ink at a few ordered-dither
levels (a 4×4 Bayer threshold, four shades by default), with the theme's accent
as one glow that dithers from accent into ink into nothing. It never carries
more than one accent colour. The ink is at most half opaque on a dark page, and
the accent at most about seven-tenths there; on a light page the ink is dark, at
most two-fifths opaque, and the glow stays about half as strong, so it stays
faint. A Scene chooses what it draws. Ridges is the one bold scene, a picture rather than a texture: five layered ridges from smooth noise, each a solid shape. The crest is a bright, crisp line two or three cells thick, at near full ink on the near layers and fainter on the far ones, and under it a dark dither that is clearly there at the crest and fades downward to black, so each layer occludes the one behind and reads as a shape. A round accent sun sits low toward one side, its core wholly inside the window within a wide soft dithered halo, with a valley cut under it, and the crests near it are rim-lit in the accent, fading with distance from it. The sky above is mostly empty, with a sparse haze near the horizon, and empty behind the heading and subtitle. Ridges carries its own peak opacities above the caps just given: ink up to 0.96 and the accent to full on a dark page, ink up to 0.8 and the accent to 0.72 on a light one, which stays a little lighter. Burst is a soft radial burst of about twenty rounded rays in the accent from
the top right corner, fading into dither, whose size breathes by a few per cent.
Drift is diagonal streaks in the ink, in loose bands that break up along their
length, with a few in the accent, sliding across the page. Your picture prints a
photo from the host's library in the same two tones: its brightness is stretched
to the photo's own range and printed in ink (dark ink on a light page, so shadows
take the ink there), and only its brightest warm cells take the accent, so a
sunset glows and a grey photo does not; it is read at the cell grid first, so it
costs no more memory than the grid. A ground saved before scenes existed has none
and draws Drift, the nearest to the drifting field it drew; a Picture scene
without a photo draws Drift too. Every scene is generated in code from a fixed
seed, so it looks the same each time, and none ships an image. Each scene is laid
out for what the window shows (a start screen that scrolls makes the ground as
tall as its content) and dimmed behind the start screen's content column, across its
full width and height, to a third of its strength (a quarter on a light page, where dark ink reads louder), back to full 140px past the
column's edge, so the brightest cells stay away from text. Ridges is the bold scene, so
it runs at full strength outside the text: its own sky is empty behind the heading and
subtitle, and the column calms it (to a fifth) only at the foot of the window, where the
composer and its chips sit. Under the sidebar, where a
ground runs there, every scene keeps a third. A ground whose scope is the start
screens is one layer in the window frame, a level under the sidebar, the title
band and the panes, and it is shown only while every pane holds a start screen
(a destination page hides it, and so does a thread beside a start screen, which
paints its own fill). It paints the page where the stage is and, on a wide
window, runs on under the sidebar over the sidebar's own width and the height of
the window below the title band, as the same picture: a scene is composed for the
stage and continues to the left, so no seam and no second composition shows at the
sidebar's edge, and the sidebar's translucent fill (94%) shows it softly. A drawn
ground dims itself to a third there; the picture grounds and Flowing take a third
through their mask. It is drawn under the sidebar only where that fill is
translucent: not on a phone, not with the sidebar collapsed, not under Glass, and
not under reduced transparency or increased contrast, which keep the sidebar
opaque and start the ground at the stage. On every other page the sidebar sits on
the plain frame. Ridges keeps the sky behind the heading
and its subtitle empty, so the sun sits low toward a corner and no cell lies under text. Motion is slow: ridges drift
a few cells a second, the sun and the burst breathe, the streaks slide. It runs at
fifteen frames a second, stops while the document is hidden or the ground is off
screen, caps its backing store at twice the display ratio, sets up in idle time,
and fades in over 1.2 seconds once it has drawn. Reduced motion, or Motion Still,
holds one frame. A click on a start screen sends the same pushing, accent-lit ring
through it at twenty-four frames a second for under two seconds. The effect
(Pixelate or Dither), cell size, shade count and scope are set as for any print,
and Settings › Appearance › Background lists the ASCII field and the Pixel ground
side by side, the latter with its scene; choosing it from another ground opens Ridges at four shades. Flowing is a drawn ground of large, soft, edgeless
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
lets the colour keep drifting. Reduced motion holds it still. The ASCII field (Pulsing characters) is the default drawn ground, and the one a start screen
shows on a fresh install: a canvas of small monospace letters and digits in the
theme's primary ink, at most 15% opaque, that shows only inside slowly drifting
patches and leaves the rest empty. Three patterns (round blotches, long
horizontal currents, rings) take turns every twenty seconds and cross-fade over
the last four. Behind the start screen's content column, across its full width and height, the field is dimmed to a third of its
strength (a quarter on a light page; and under the sidebar where it runs there), and comes back to full strength 140px past the column's
edge, so the heading, the cards and the composer stay on a calm page. The glyphs are painted once into a layer (a few per cent swap each
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
start screen every ground, the ASCII field and the dithered scenes included,
fades toward the foot of the window: full strength down to 55% of the stage,
then easing smoothly to the stage's own colour across the lower 45%, as a mask
on the ground layer under everything, so the composer and the lists under the
question always sit on a calm area. The ramp is the same in the light theme and
in the dark (the page colour under the mask is what the ground fades into), and
the dim behind the content column stays beside it, because the greeting and the
lists sit in that column. A person
may instead put the ground behind every page, from the workspace's leading
edge, and under the sidebar too when they ask for it (see [Depth and material](../../DESIGN.md#depth-and-material)). Every
surface that shows text or information softens it beneath one continuous
reading veil, the sheet colour at 94% (`--octant-reading-surface-keep`, also the
sidebar's fill; at 80% and 82% a photo still ran through the letters, maintainer
request 2026-11-15), so the ground is a whisper and agent replies remain bare prose: a thread, every other pane
(a Project's page, Settings, a file, a preview), and every destination page
(Inbox, Board, Archive, Review, Projects, Agents, Automations, Artifacts, Image
generator). A start screen (a welcome or a new thread) is the one exception and
stays open on the ground, but only its stage: a dock pane, the Environment
strip and the bottom panel opened beside it take the text surface at 94%
(`surface.css`, keyed on the start-only workspace). The veil is one rule in `surface.css` keyed on the
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
