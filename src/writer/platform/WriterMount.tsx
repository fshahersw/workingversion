// Mounts the Writer renderer inside the platform. Mirrors renderer/main.tsx
// (language, theme, screen tips, LocaleProvider) but renders into the route
// instead of a standalone root, and scopes the Writer's global stylesheets to
// the time the editor is on screen: they are injected as <style> elements on
// mount and removed on unmount, so the rest of the platform never inherits
// the Writer's html/body rules.
import { useEffect, useState } from "react";

import { htmlLang, type Lang } from "@genoffice/i18n";
import { installScreenTips } from "@genoffice/ui";

import tokensCss from "../packages/ui/src/tokens.css?inline";
import screentipCss from "../packages/ui/src/screentip.css?inline";
import colorPickerCss from "../packages/ui/src/color-picker.css?inline";
import dropdownCss from "../packages/ui/src/dropdown.css?inline";
import ribbonCollapseCss from "../packages/ui/src/ribbon-collapse.css?inline";
import markdownCss from "../packages/ui/src/markdown.css?inline";
import stylesCss from "../renderer/styles.css?inline";
import fontsCss from "../renderer/fonts/fonts.css?inline";
import swWriterCss from "../renderer/sw-writer.css?inline";
import { App } from "../renderer/App";
import { LocaleProvider, setModuleLang } from "../renderer/i18n/locale";
import type { UiTheme } from "../shared/ipc";

const SHEETS: Array<[string, string]> = [
  ["sw-writer-tokens", tokensCss],
  ["sw-writer-screentip", screentipCss],
  ["sw-writer-color-picker", colorPickerCss],
  ["sw-writer-dropdown", dropdownCss],
  ["sw-writer-ribbon-collapse", ribbonCollapseCss],
  ["sw-writer-markdown", markdownCss],
  ["sw-writer-styles", stylesCss],
  ["sw-writer-fonts", fontsCss],
  ["sw-writer-sw", swWriterCss],
];

let screenTipsInstalled = false;

function applyTheme(theme: UiTheme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

/** Inject the Writer stylesheets; returns the cleanup that removes them. */
function mountStyles(): () => void {
  const nodes = SHEETS.map(([id, css]) => {
    const el = document.createElement("style");
    el.dataset["swWriter"] = id;
    el.textContent = css;
    document.head.appendChild(el);
    return el;
  });
  const previousTheme = document.documentElement.getAttribute("data-theme");
  const previousLang = document.documentElement.lang;
  document.body.classList.add("office-body");
  return () => {
    for (const el of nodes) el.remove();
    document.body.classList.remove("office-body");
    if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", previousTheme);
    document.documentElement.lang = previousLang;
  };
}

export function WriterMount() {
  const [ready, setReady] = useState(false);
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    const cleanupStyles = mountStyles();
    let cancelled = false;
    const boot = async () => {
      let nextLang: Lang = "en";
      let theme: UiTheme = "light";
      try {
        [nextLang, theme] = await Promise.all([
          window.desktop.getLanguage().catch(() => "en" as const),
          window.desktop.getTheme().catch(() => "light" as const),
        ]);
      } catch {
        /* adapter not installed: defaults */
      }
      if (cancelled) return;
      setModuleLang(nextLang);
      document.documentElement.lang = htmlLang(nextLang);
      applyTheme(theme);
      window.desktop?.onThemeChanged(applyTheme);
      if (!screenTipsInstalled) {
        installScreenTips();
        screenTipsInstalled = true;
      }
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
