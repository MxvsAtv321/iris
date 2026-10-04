// The garden's whole look comes from here. Colors are read from the CSS
// custom properties on .garden at the top of garden.css, so the 2D overlay and the 3D
// scene always match, and swapping in the shared Figma tokens means editing
// garden.css only. Use hex or rgb() values there, since the 3D side can't
// parse oklch() or color-mix().

export type Theme = {
  dusk: string; // night sky, page background
  duskDeep: string; // behind an open moment, panels
  mist: string; // body text
  glow: string; // leaf violet: the wordmark, focus rings
  pollen: string; // blossom gold: a found moment, primary buttons
};

// Only used if garden.css somehow didn't load.
const FALLBACK: Theme = {
  dusk: "#0a0918",
  duskDeep: "#07060f",
  mist: "#dcd6f0",
  glow: "#b9a4ff",
  pollen: "#f4c56e",
};

const CSS_NAMES: Record<keyof Theme, string> = {
  dusk: "--dusk",
  duskDeep: "--dusk-deep",
  mist: "--mist",
  glow: "--glow",
  pollen: "--pollen",
};

let cached: Theme | null = null;

/** The tokens live on .garden, so read them from a .garden element (a hidden one if none is mounted yet). */
function readGardenStyle(): { css: CSSStyleDeclaration; cleanup: () => void } {
  const existing = document.querySelector<HTMLElement>(".garden");
  if (existing) return { css: getComputedStyle(existing), cleanup: () => {} };
  const probe = document.createElement("div");
  probe.className = "garden";
  probe.style.display = "none";
  document.body.appendChild(probe);
  return { css: getComputedStyle(probe), cleanup: () => probe.remove() };
}

export function getTheme(): Theme {
  if (cached) return cached;
  const { css, cleanup } = readGardenStyle();
  const theme = { ...FALLBACK };
  let found = false;
  for (const key of Object.keys(CSS_NAMES) as (keyof Theme)[]) {
    const value = css.getPropertyValue(CSS_NAMES[key]).trim();
    if (value) {
      theme[key] = value;
      found = true;
    }
  }
  cleanup();
  if (found) cached = theme; // don't lock in fallbacks if the stylesheet isn't applied yet
  return theme;
}

// Fonts for text inside the 3D scene. The 3D renderer needs .woff, .ttf or
// .otf files (not .woff2), served from web/public/fonts. The 2D font is set
// by --font in garden.css and the font link in index.html.
export const FONT_REGULAR = "/fonts/literata-latin-400-normal.woff";
export const FONT_BOLD = "/fonts/literata-latin-600-normal.woff";
