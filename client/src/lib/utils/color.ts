// Simple color utils for RGB/hex conversions

export type RGB = [number, number, number];

export function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

export function hexToRgb(hex: string): RGB {
  const s = hex.replace(/^#/, "");
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    return [r, g, b];
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return [r, g, b];
}

export function rgbToHex([r, g, b]: RGB): string {
  return (
    "#" +
    clampByte(r).toString(16).padStart(2, "0") +
    clampByte(g).toString(16).padStart(2, "0") +
    clampByte(b).toString(16).padStart(2, "0")
  );
}
