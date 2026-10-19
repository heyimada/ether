import { colord, extend, type Colord } from "colord";
import a11yPlugin from "colord/plugins/a11y";

extend([a11yPlugin]);

export const DEFAULT_ACCENT = "#0b7285";

export const ACCENT_PRESETS = [
  { name: "Teal", hex: DEFAULT_ACCENT },
  { name: "Blue", hex: "#0969da" },
  { name: "Violet", hex: "#8250df" },
  { name: "Pink", hex: "#bf3989" },
  { name: "Orange", hex: "#d4560b" },
  { name: "Slate", hex: "#57606a" },
];

// The surfaces each theme paints; tokens must stay legible on the hardest of them.
const THEMES = {
  light: { surfaces: ["#ffffff", "#f6f8fa", "#eef1f4"], darkText: "#1f2328", nudge: (c: Colord, by: number) => c.darken(by) },
  dark: { surfaces: ["#0d1117", "#161b22", "#010409"], darkText: "#0d1117", nudge: (c: Colord, by: number) => c.lighten(by) },
};

const minContrast = (c: Colord, surfaces: string[]) => Math.min(...surfaces.map((s) => c.contrast(s)));

// Moves a colour away from the theme's background, keeping its hue, until it reaches the ratio.
function untilReadable(c: Colord, surfaces: string[], ratio: number, nudge: (c: Colord, by: number) => Colord) {
  let out = c;
  for (let i = 0; i < 40 && minContrast(out, surfaces) < ratio; i++) out = nudge(out, 0.025);
  return out;
}

function tokens(hex: string, theme: keyof typeof THEMES) {
  const t = THEMES[theme];
  // Fills (buttons, bars, the active tab) need 3:1 against the page; link text needs 4.5:1.
  let fill = untilReadable(colord(hex), t.surfaces, 3, t.nudge);
  // Mid-lightness fills can hold neither a white nor a dark label at 4.5:1; keep moving the
  // same way, which only increases contrast with the page, until one of them does.
  const labelContrast = (c: Colord) => Math.max(c.contrast("#ffffff"), c.contrast(t.darkText));
  for (let i = 0; i < 40 && labelContrast(fill) < 4.5; i++) fill = t.nudge(fill, 0.025);
  const link = untilReadable(fill, t.surfaces, 4.5, t.nudge);
  const onFill = fill.contrast("#ffffff") >= fill.contrast(t.darkText) ? "#ffffff" : t.darkText;
  // Hover moves the fill further from its label so the label only gets more readable.
  const hover = onFill === "#ffffff" ? fill.darken(0.06) : fill.lighten(0.06);
  return {
    "--accent": fill.toHex(),
    "--accent-hover": hover.toHex(),
    "--accent-soft": fill.alpha(0.16).toRgbString(),
    "--accent-text": onFill,
    "--link": link.toHex(),
    "--focus": link.toHex(),
  };
}

const block = (selector: string, vars: Record<string, string>) =>
  `${selector} { ${Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ")} }`;

const STYLE_ID = "ether-accent";
const CACHE_KEY = "ether-appearance";

export type Theme = "light" | "dark" | null;

// Overrides the stylesheet's accent tokens for the signed-in user, or restores the defaults.
// Returns the CSS it installed so it can be cached for the next page load.
export function applyAccent(hex: string | null): string | null {
  document.getElementById(STYLE_ID)?.remove();
  if (!hex || !colord(hex).isValid()) return null;
  const dark = tokens(hex, "dark");
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    block(":root", tokens(hex, "light")),
    `@media (prefers-color-scheme: dark) { ${block(':root:not([data-theme="light"])', dark)} }`,
    block(':root[data-theme="dark"]', dark),
  ].join("\n");
  document.head.appendChild(style);
  return style.textContent;
}

export function applyTheme(theme: Theme) {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}

// Applies the account's appearance and remembers it so PREPAINT can restore it next time
// before the session check returns.
export function applyAppearance({ accent, theme }: { accent: string | null; theme: Theme }) {
  applyTheme(theme);
  const css = applyAccent(accent);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ theme, css }));
  } catch {}
}

export function clearAppearance() {
  applyTheme(null);
  applyAccent(null);
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

// Runs inline in <head> before first paint; must stay dependency-free.
export const PREPAINT = `try{var a=JSON.parse(localStorage.getItem(${JSON.stringify(CACHE_KEY)})||"null");if(a){if(a.theme)document.documentElement.setAttribute("data-theme",a.theme);if(a.css){var s=document.createElement("style");s.id=${JSON.stringify(STYLE_ID)};s.textContent=a.css;document.head.appendChild(s)}}}catch(e){}`;
