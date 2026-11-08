/**
 * Video palette derived from the shipped application tokens so motion graphics
 * and real UI footage read as one product. Keep in sync with
 * apps/web/components/product/*.module.css when the app theme changes.
 */
export const theme = {
  background: "#f7f4ec",
  surface: "#fffdf7",
  ink: "#17382f",
  inkSoft: "#52635b",
  line: "#c9d6cf",
  teal: "#176c57",
  tealDeep: "#174f42",
  tealWash: "#e8f1ea",
  urgent: "#702d1c",
  urgentWash: "#fbe6df",
  gold: "#bb7900",
  captionBackground: "rgba(16, 38, 31, 0.92)",
  captionText: "#fdfbf4",
} as const;

export const typography = {
  display: "Manrope, 'DM Sans', ui-sans-serif, system-ui, sans-serif",
  body: "'DM Sans', Manrope, ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Delivery format shared by the manifest, timeline and renderer. */
export const delivery = { width: 1920, height: 1080, fps: 30 } as const;
