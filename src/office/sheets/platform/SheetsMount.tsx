// Mounts the Sheets renderer inside the platform. Mirrors src/renderer/main.tsx
// (screen tips, canvas font fallback, cell fonts, theme, LocaleProvider) but
// renders into the route and scopes the renderer's global stylesheets to the
// time the editor is on screen (injected on mount, removed on unmount).
import { useEffect, useState } from "react";

import { htmlLang, type Lang } from "@genoffice/i18n";
import { installScreenTips } from "@genoffice/ui";

import tokensCss from "../../../writer/packages/ui/src/tokens.css?inline";
import screentipCss from "../../../writer/packages/ui/src/screentip.css?inline";
import colorPickerCss from "../../../writer/packages/ui/src/color-picker.css?inline";
import dropdownCss from "../../../writer/packages/ui/src/dropdown.css?inline";
import ribbonCollapseCss from "../../../writer/packages/ui/src/ribbon-collapse.css?inline";
import markdownCss from "../../../writer/packages/ui/src/markdown.css?inline";
import univerCoreCss from "@univerjs/preset-sheets-core/lib/index.css?inline";
import stylesCss from "../src/renderer/styles.css?inline";
import swSheetsCss from "../src/renderer/sw-sheets.css?inline";
import { App } from "../src/renderer/App";
import {
  installCanvasFontFallback,
  registerCellFontAliases,
} from "../src/renderer/cell-font-fallback";
import { LocaleProvider, setModuleLang } from "../src/renderer/i18n/locale";
import type { UiTheme } from "../src/shared/desktop-api";

const SHEETS: Array<[string, string]> = [
  ["sw-sheets-tokens", tokensCss],
  ["sw-sheets-screentip", screentipCss],
  ["sw-sheets-color-picker", colorPickerCss],
  ["sw-sheets-dropdown", dropdownCss],
  ["sw-sheets-ribbon-collapse", ribbonCollapseCss],
  ["sw-sheets-markdown", markdownCss],
  ["sw-sheets-univer-core", univerCoreCss],
  ["sw-sheets-styles", stylesCss],
  ["sw-sheets-sw", swSheetsCss],
];

let installedOnce = false;

function applyTheme(theme: UiTheme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function mountStyles(): () => void {
  const nodes = SHEETS.map(([id, css]) => {
    const el = document.createElement("style");
    el.dataset["swSheets"] = id;
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

// Canvas fillText never triggers @font-face downloads, so the bundled Carlito
// faces must be loaded before Univer's first skeleton measures text with them.
async function loadCellFonts(): Promise<void> {
  const loads: Promise<unknown>[] = [registerCellFontAliases()];
  for (const variant of ["", "bold ", "italic ", "italic bold "]) {
    for (const family of ["Calibri", "Aptos", "'Aptos Narrow'", "Carlito"]) {
      loads.push(
        document.fonts?.load?.(`${variant}16px ${family}`)?.catch(() => {}) ?? Promise.resolve(),
      );
    }
  }
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

export function SheetsMount() {
  const [ready, setReady] = useState(false);
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    const cleanupStyles = mountStyles();
    let cancelled = false;
    const boot = async () => {
      if (!installedOnce) {
        installScreenTips();
        installCanvasFontFallback();
        installedOnce = true;
      }
      let nextLang: Lang = "en";
      let theme: UiTheme = "light";
      try {
        [nextLang, theme] = await Promise.all([
          window.desktopApi.getLanguage().catch(() => "en" as const),
          window.desktopApi.getTheme().catch(() => "light" as const),
        ]);
      } catch {
        /* host not installed: defaults */
      }
      if (cancelled) return;
      setModuleLang(nextLang);
      document.documentElement.lang = htmlLang(nextLang);
      applyTheme(theme);
      await loadCellFonts();
      if (cancelled) return;
      window.desktopApi?.onThemeChanged(applyTheme);
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
