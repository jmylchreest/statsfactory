/**
 * Deterministic colour assignment for dimension values.
 *
 * Uses djb2 XOR hash for even distribution and OKLCH colour space
 * for perceptual uniformity — equal hue distance = equal visual
 * difference, unlike HSL where blues cluster together.
 *
 * The same dimension value always produces the same colour, across
 * all components (map donuts, bar charts, treemaps, pills).
 */

/**
 * djb2 XOR hash — good distribution for short strings like
 * dimension values ("Windows", "Chrome", "NZ", etc).
 */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // unsigned 32-bit
}

/**
 * Get a deterministic colour for a dimension value string.
 *
 * Returns an `oklch()` CSS colour string. OKLCH is supported in all
 * modern browsers (~96% support). For contexts that need hex (like
 * inline SVG fill attributes), use `dimColorHex()` instead.
 */
export function dimColor(value: string): string {
  const hue = djb2(value) % 360;
  return `oklch(0.65 0.18 ${hue})`;
}

/**
 * Convert an OKLCH hue to an approximate hex colour.
 *
 * This is a rough approximation that maps the OKLCH hue wheel to
 * HSL (same hue, fixed S=75% L=55%) then converts to hex. It won't
 * be pixel-identical to the oklch() CSS value but is close enough
 * for SVG fills and canvas rendering where oklch() isn't supported.
 */
export function dimColorHex(value: string): string {
  const hue = djb2(value) % 360;
  return hslToHex(hue, 75, 55);
}

/**
 * Get the raw hue for a dimension value (0-359).
 * Useful when you need to construct your own colour from the hue.
 */
export function dimHue(value: string): number {
  return djb2(value) % 360;
}

// ── HSL → Hex conversion ───────────────────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
