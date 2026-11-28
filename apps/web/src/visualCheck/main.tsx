import { DEFAULT_THEME_SETTINGS, type ThemeSettings } from "@octant/contracts/theme";
import { GEIST_UI_FAMILY } from "@octant/theme";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { followInputModality } from "../lib/inputModality";
import { ThemeSettingsProvider } from "../theme/ThemeSettingsProvider";
import { ThemeTypographyProvider } from "../theme/TypographyProvider";
import { IconDefaults } from "../ui/IconDefaults";
import { SCENES, sceneById } from "./scenes";
import "../styles.css";
import "../styles/canvas-forms.css";
import "../styles/canvas-design-player.css";
import "../styles/canvas-inline.css";
import "../styles/files-viewer.css";
import "../styles/code-thread.css";
import "../styles/thread-goal.css";
import "../styles/thread-plan.css";
import "../styles/ship-panel.css";
import "../styles/environment-details.css";
import "../styles/browser-feedback.css";
import "../styles/local-servers.css";
import "../linkedThread/parallel-runs.css";
import "../styles/unified-diff.css";
import "../styles/work-list.css";
import "../styles/github.css";
import "../styles/linear-issues.css";
import "../styles/preview.css";
import "../styles/inbox.css";
import "../styles/review.css";
import "../styles/debug.css";
import "../styles/canvas-dashboard.css";
import "../styles/remote-pairing.css";
import "../styles/remote-shell.css";
import "../styles/artifacts.css";
import "../styles/code-overview.css";
import "../styles/chat-project-overview.css";
import "../styles/project-memory.css";
import "../styles/work-overview.css";
import "../styles/project-overview.css";
import "../styles/board.css";
import "../styles/provider-settings.css";
import "../styles/shell.css";
import "../styles/dock.css";
import "../styles/panels.css";
import "../styles/environment.css";
import "../styles/thread-move-computer.css";
import "../styles/prepare-to-shut-down.css";
import "../styles/settings.css";
// The shared component/material layer loads last, as it does in the app.
import "../styles/zen.css";
import "../styles/browser-workspace.css";
import "../styles/folder-picker.css";
import "../context/context.css";
import "../context/context-health-warning.css";
import "../styles/components.css";
import "../styles/thread-search.css";
import "./visualCheck.css";

/**
 * The visual check's page: one named scene at a time, drawn by the real
 * components under the shipped stylesheets and theme tokens, with no host
 * behind it. Development only; see `visual-check.html`. The check reads
 * `data-visual-ready` on the root element and screenshots once it is set.
 */
/**
 * Nothing moves, blinks or fades in a picture, so two runs of the same code
 * draw the same one. Injected here rather than written in the stylesheet,
 * where `ui:check` keeps `!important` out of product CSS.
 */
const STILL = `*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}`;

function Scene(props: { readonly id: string; readonly scheme: "light" | "dark" }) {
  const scene = sceneById(props.id);
  useEffect(() => {
    let cancelled = false;
    const finish = async () => {
      // The bundled faces, asked for by name: a face nothing has used yet is
      // not loaded, and `ready` would not wait for it.
      // `load` of a family nobody declared resolves to no faces, and `check`
      // then says true, so a broken font import must be caught here.
      for (const font of [
        "400 14px 'Geist Variable'",
        "500 14px 'Geist Variable'",
        "600 14px 'Geist Variable'",
        "400 13px 'Geist Mono Variable'",
      ]) {
        const faces = await document.fonts.load(font);
        if (faces.length === 0 || faces.some((face) => face.status !== "loaded"))
          throw new Error(`The bundled face for ${font} did not load.`);
      }
      await document.fonts.ready;
      await scene?.settled?.();
      // Let effects, popups and polled fixtures settle before the picture.
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      // StrictMode runs this effect twice; only the live run may click.
      if (cancelled) return;
      if (scene?.scrollTo !== undefined) {
        const target = document.querySelector<HTMLElement>(scene.scrollTo);
        if (target === null) throw new Error(`Scene ${props.id} has no ${scene.scrollTo}.`);
        target.scrollIntoView({ block: "center" });
      }
      if (scene?.open !== undefined) {
        const trigger = document.querySelector<HTMLElement>(scene.open);
        if (trigger === null) throw new Error(`Scene ${props.id} has no ${scene.open} to open.`);
        trigger.click();
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (!cancelled) document.documentElement.dataset.visualReady = "true";
    };
    void finish();
    return () => {
      cancelled = true;
    };
  }, [props.id, scene]);
  if (scene === undefined) {
    return <p>{`Unknown scene "${props.id}". Scenes: ${SCENES.map((s) => s.id).join(", ")}`}</p>;
  }
  const plain: ThemeSettings = {
    ...DEFAULT_THEME_SETTINGS,
    mode: props.scheme,
    // The plain ground: no glass washes and no background picture.
    reducedTransparency: true,
    // The platform face differs by system, so the picture is drawn in the
    // bundled Geist, the face Appearance offers, and looks the same everywhere.
    typography: {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: GEIST_UI_FAMILY },
    },
  };
  const settings = scene.theme?.(plain) ?? plain;
  return (
    <ThemeSettingsProvider rememberMode={false} settings={settings}>
      <style>{STILL}</style>
      <IconDefaults>
        <ThemeTypographyProvider typography={settings.typography}>
          <div
            className={
              scene.desktop === "glass" ? "visual-check visual-check--desktop" : "visual-check"
            }
          >
            {scene.render()}
          </div>
        </ThemeTypographyProvider>
      </IconDefaults>
    </ThemeSettingsProvider>
  );
}

/**
 * A fixed stand-in for `Math.random` (mulberry32), so a scene that asks for it
 * draws the same random choices on every run.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Reached only through the dev server's `visual-check.html`, which the
// production build does not take as an input; this guard keeps the module
// inert if a bundler ever reaches it anyway.
if (import.meta.env.DEV) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Octant root element is missing");
  const query = new URLSearchParams(window.location.search);
  const id = query.get("scene") ?? "";
  const scene = sceneById(id);
  if (scene?.seededRandom === true) Math.random = seededRandom(20_260_818);
  // What the desktop app writes on the root: that a native host holds the
  // window, and, once the host reports its glass applied, that too. The
  // shell's glass rules key off these and nothing else.
  if (scene?.desktop !== undefined) document.documentElement.dataset.octantNativeHost = "true";
  if (scene?.desktop === "glass") document.documentElement.dataset.octantHostVibrancy = "active";
  followInputModality();
  createRoot(root).render(
    <StrictMode>
      <Scene id={id} scheme={query.get("scheme") === "light" ? "light" : "dark"} />
    </StrictMode>,
  );
}
