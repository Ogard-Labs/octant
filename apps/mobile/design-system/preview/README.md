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
- To try attachment forwarding, choose **Simulate share from Photos**, then a
  thread or bot. The example items appear in its composer without sending.
- To try a fold transition, open a thread, enter a draft, and change posture.
  The frame sizes illustrate layouts; they are not device specifications.
- Some actions are placeholders. A successful preview interaction is not
  evidence of a native integration, host capability, or security check.

`index.html` defines the frame and controls. `app.js` holds the fixtures,
navigation, and interactions. `styles.css` and `settings-review.css` style the
preview. `icons.js` contains SVG data from Lucide; its notice is in
`LICENSE-lucide.txt`. Nothing here is imported by the mobile runtime.
