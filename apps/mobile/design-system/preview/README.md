# Mobile design preview

A standalone, clickable browser mockup. It uses fictional data, Octant's existing
mobile assets, and local SVG icons. It does not start the Expo app, pair with a
computer, call a provider, send notifications, or upload files.

From the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory apps/mobile
```

Open <http://127.0.0.1:8080/design-system/preview/>. No install or build is
required. Stop the server with Ctrl-C.

- Use the panel beside the device to switch theme, screen, device, and posture.
- **Full screen and Split view:** pick iPad, or unfold a foldable. Every in-app
  screen fills the window on its own and has a split button. Try Settings beside
  a thread, or Inbox beside a pull request: each pane navigates by itself, and
  the button's accent marks the selected pane.
- **Folding:** type a draft, choose **Simulate share from Photos**, scroll, then
  change posture. The selected pane, place, draft and staged items stay. Folded,
  the split button switches to the other pane. The frame sizes illustrate
  layouts; they are not device specifications.
- **Counts:** Home's Needs you, Working and To review open exactly the threads
  they count. **Nothing waiting** in the panel shows the empty lists.
- **Composer:** tick **On-screen keyboard while typing** and focus a composer.
- Some actions are placeholders. A successful preview interaction is not
  evidence of a native integration, host capability, or security check.

To review is an unread finished turn. In review is a pull request's review
status. Settled means out of the active list, not approved or Done, and whether
finished threads settle on their own is each computer's setting.

`index.html` defines the frame and controls. `panes.js` and `panes.css` hold the
panes, split view, folding and composer geometry. `app.js` holds the fixtures,
thread state, screens, and interactions. `styles.css` and `settings-review.css`
style the rest. `icons.js` contains SVG data from Lucide; its notice is in
`LICENSE-lucide.txt`. Nothing here is imported by the mobile runtime.
