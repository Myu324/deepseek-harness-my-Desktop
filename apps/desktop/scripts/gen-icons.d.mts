/** Type declarations for the deterministic icon generator (gen-icons.mjs). */

/**
 * Encode one RGBA buffer as a PNG.
 * @param size - square side length in pixels.
 * @param pixels - `size * size * 4` RGBA bytes.
 * @returns the PNG file bytes.
 */
export function encodePng(size: number, pixels: Buffer): Buffer

/**
 * Generate the placeholder icon PNG at one size.
 * @param size - square side length in pixels.
 * @returns the PNG file bytes.
 */
export function generateIconPng(size?: number): Buffer

/**
 * Wrap PNG bytes in a Vista-style ICO container (one 256x256 entry).
 * @param png - the embedded PNG bytes.
 * @returns the ICO file bytes.
 */
export function generateIconIco(png: Buffer): Buffer
