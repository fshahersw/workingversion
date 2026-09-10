// Mounts the Slides renderer inside the platform. Mirrors src/renderer/main.tsx
// (screen tips, canvas font preload, theme, LocaleProvider) but renders into
// the route and scopes the renderer's global stylesheets to the time the
// editor is on screen (injected on mount, removed on unmount).
import { useEffect, useState } from "react";

import { htmlLang, type Lang } from "@genoffice/i18n";
import { installScreenTips } from "@genoffice/ui";

import tokensCss from "../../../writer/packages/ui/src/tokens.css?inline";
import screentipCss from "../../../writer/packages/ui/src/screentip.css?inline";
import colorPickerCss from "../../../writer/packages/ui/src/color-picker.css?inline";
import dropdownCss from "../../../writer/packages/ui/src/dropdown.css?inline";
import ribbonCollapseCss from "../../../writer/packages/ui/src/ribbon-collapse.css?inline";
import markdownCss from "../../../writer/packages/ui/src/markdown.css?inline";
import stylesCss from "../src/renderer/styles.css?inline";
import swSlidesCss from "../src/renderer/sw-slides.css?inline";
import { App } from "../src/renderer/App";
import { LocaleProvider, setModuleLang } from "../src/renderer/i18n/locale";
import type { UiTheme } from "../src/shared/ipc";

const SHEETS: Array<[string, string]> = [
  ["sw-slides-tokens", tokensCss],
  ["sw-slides-screentip", screentipCss],
  ["sw-slides-color-picker", colorPickerCss],
  ["sw-slides-dropdown", dropdownCss],
  ["sw-slides-ribbon-collapse", ribbonCollapseCss],
  ["sw-slides-markdown", markdownCss],
  ["sw-slides-styles", stylesCss],
  ["sw-slides-sw", swSlidesCss],
];

let installedOnce = false;

function applyTheme(theme: UiTheme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function mountStyles(): () => void {
  const nodes = SHEETS.map(([id, css]) => {
    const el = document.createElement("style");
    el.dataset["swSlides"] = id;
    el.textContent = css;
    document.head.appendChild(el);
    return el;
  });
  const previousTheme = document.documentElement.getAttribute("data-theme");
  const previousLang = document.documentElement.lang;
  return () => {
    for (const el of nodes) el.remove();
    if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", previousTheme);
    document.documentElement.lang = previousLang;
  };
}

// Canvas fillText never triggers @font-face downloads, so the bundled document
// fonts (Carlito <-> Calibri) must be loaded explicitly or Konva silently draws
// the fallback face.
async function loadDeckFonts(): Promise<void> {
  const loads: Promise<unknown>[] = [];
  for (const variant of ["", "bold ", "italic ", "italic bold "]) {
    for (const family of ["Carlito", "'Carlito GO'"]) {
      loads.push(
        document.fonts?.load?.(`${variant}16px ${family}`)?.catch(() => {}) ?? Promise.resolve(),
      );
    }
  }
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

export function SlidesMount() {
  const [ready, setReady] = useState(false);
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    const cleanupStyles = mountStyles();
    let cancelled = false;
    const boot = async () => {
      if (!installedOnce) {
        installScreenTips();
        installedOnce = true;
      }
      let nextLang: Lang = "en";
      let theme: UiTheme = "light";
      try {
        [nextLang, theme] = await Promise.all([
          window.slidesApi.getLanguage().catch(() => "en" as const),
          window.slidesApi.getTheme().catch(() => "light" as const),
        ]);
      } catch {
        /* host not installed: defaults */
      }
      if (cancelled) return;
      setModuleLang(nextLang);
      document.documentElement.lang = htmlLang(nextLang);
      applyTheme(theme);
      await loadDeckFonts();
      if (cancelled) return;
      window.slidesApi?.onThemeChanged(applyTheme);
      setLang(nextLang);
      setReady(true);
    };
    void boot();
    return () => {
      cancelled = true;
      cleanupStyles();
    };
  }, []);

  if (!ready) return null;
  return (
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>
  );
}
