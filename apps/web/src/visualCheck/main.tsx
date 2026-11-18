import { DEFAULT_THEME_SETTINGS, type ThemeSettings } from "@octant/contracts/theme";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { followInputModality } from "../lib/inputModality";
import { ThemeSettingsProvider } from "../theme/ThemeSettingsProvider";
import { ThemeTypographyProvider } from "../theme/TypographyProvider";
import { IconDefaults } from "../ui/IconDefaults";
import { SCENES, sceneById } from "./scenes";
import "../styles.css";
import "../styles/shell.css";
import "../styles/dock.css";
import "../styles/panels.css";
import "../styles/environment.css";
import "../styles/settings.css";
// The shared component/material layer loads last, as it does in the app.
import "../styles/components.css";
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
      await document.fonts.ready;
      // Let effects, popups and polled fixtures settle before the picture.
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      // StrictMode runs this effect twice; only the live run may click.
      if (cancelled) return;
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
  const settings: ThemeSettings = {
    ...DEFAULT_THEME_SETTINGS,
    mode: props.scheme,
    // The plain ground: no glass washes and no background picture.
    reducedTransparency: true,
  };
  return (
    <ThemeSettingsProvider rememberMode={false} settings={settings}>
      <style>{STILL}</style>
      <IconDefaults>
        <ThemeTypographyProvider typography={settings.typography}>
          <div className="visual-check">{scene.render()}</div>
        </ThemeTypographyProvider>
      </IconDefaults>
    </ThemeSettingsProvider>
  );
}

// Reached only through the dev server's `visual-check.html`, which the
// production build does not take as an input; this guard keeps the module
// inert if a bundler ever reaches it anyway.
if (import.meta.env.DEV) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Octant root element is missing");
  const query = new URLSearchParams(window.location.search);
  followInputModality();
  createRoot(root).render(
    <StrictMode>
      <Scene
        id={query.get("scene") ?? ""}
        scheme={query.get("scheme") === "light" ? "light" : "dark"}
      />
    </StrictMode>,
  );
}
