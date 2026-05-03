import { describe, expect, it } from 'vitest';

import { scaleAllFrames, scaleFrame } from './resize';
import { pixelAt } from './test-utils/synth';

// Build a tiny ImageData by listing per-pixel RGBA tuples row-major.
function imageOf(w: number, h: number, pixels: Array<[number, number, number, number]>): ImageData {
  if (pixels.length !== w * h) {
    throw new Error(`imageOf expected ${w * h} pixels, got ${pixels.length}`);
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    const [r, g, b, a] = pixels[i];
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return new ImageData(data, w, h);
}

const T: [number, number, number, number] = [0, 0, 0, 0];

describe('scaleFrame', () => {
  // Regression for commit eb14f18 (premultiplied bilinear). The smoking-gun
  // case: a 2x2 source with a single opaque red corner and three fully-
  // transparent neighbours (RGB stored as 0,0,0). Scale up to 4x4 and check
  // pixel (1,1), which is the bilinear blend of all 4 source corners.
  //
  // With *premultiplied* bilinear the transparent neighbours contribute 0
  // to the RGB sum (their alpha=0 weights them out), so the un-premultiplied
  // RGB stays at the corner's true colour (~255 red). Alpha drops because
  // alpha *is* the linear-weighted sum.
  //
  // With *per-channel* bilinear the transparent neighbours' stored RGB
  // (zeros) get mixed in, dragging interpolated red toward black -- you'd
  // see ~64 red here. That regression would fire this test.
  it('preserves opaque-pixel RGB when interpolating against transparent neighbours', () => {
    const src = imageOf(2, 2, [
      [255, 0, 0, 255], T,
      T,                T,
    ]);
    const out = scaleFrame(src, { w: 2, h: 2 }, { w: 4, h: 4 });

    // (0,0) is exactly the source corner.
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 255]);

    // (1,1) is the most-mixed interior pixel. Premul keeps R near 255;
    // per-channel would drop it to ~64. Alpha is the standard linear blend.
    const [r, g, b, a] = pixelAt(out, 1, 1);
    expect(r).toBeGreaterThanOrEqual(250);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // Standard bilinear weight for a corner-aligned 2->4 upscale at (1,1)
    // is (2/3)*(2/3) = 0.444; alpha = 255 * 0.444 ≈ 113.
    expect(a).toBeGreaterThanOrEqual(110);
    expect(a).toBeLessThanOrEqual(116);
  });

  it('returns a fully transparent output when every source pixel is transparent (no NaN from div-by-zero)', () => {
    const src = imageOf(2, 2, [T, T, T, T]);
    const out = scaleFrame(src, { w: 2, h: 2 }, { w: 4, h: 4 });
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect(pixelAt(out, x, y)).toEqual([0, 0, 0, 0]);
      }
    }
  });

  it('preserves a uniform opaque colour exactly (premul should match per-channel here)', () => {
    const colour: [number, number, number, number] = [120, 200, 40, 255];
    const src = imageOf(2, 2, [colour, colour, colour, colour]);
    const out = scaleFrame(src, { w: 2, h: 2 }, { w: 8, h: 8 });
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        expect(pixelAt(out, x, y)).toEqual(colour);
      }
    }
  });

  it('treats srcSize == dstSize as identity (no resampling shifts)', () => {
    const src = imageOf(2, 2, [
      [10, 20, 30, 40],   [50, 60, 70, 80],
      [90, 100, 110, 120], [130, 140, 150, 160],
    ]);
    const out = scaleFrame(src, { w: 2, h: 2 }, { w: 2, h: 2 });
    expect(pixelAt(out, 0, 0)).toEqual([10, 20, 30, 40]);
    expect(pixelAt(out, 1, 0)).toEqual([50, 60, 70, 80]);
    expect(pixelAt(out, 0, 1)).toEqual([90, 100, 110, 120]);
    expect(pixelAt(out, 1, 1)).toEqual([130, 140, 150, 160]);
  });

  it('respects ImageData stride > srcSize.w (carving keeps full-width buffers and shrinks the logical region only)', () => {
    // Real-world layout from pipeline.ts: the underlying buffer is sized to
    // the *original* input width, but the meaningful region after carving
    // is a smaller (srcSize.w x srcSize.h) box at the top-left. scaleFrame
    // must use src.width as the row stride, not srcSize.w.
    const stride = 4;
    const data = new Uint8ClampedArray(stride * 2 * 4);
    // Top-left 2x2 (the "live" region): an opaque red dot at (0,0), rest T.
    data[0] = 255; data[1] = 0; data[2] = 0; data[3] = 255;
    // Junk in the trailing columns -- carving leaves stale bytes here, but
    // scaleFrame must not read into them.
    for (let i = 8; i < stride * 4; i += 4) {
      data[i + 0] = 99;
      data[i + 1] = 99;
      data[i + 2] = 99;
      data[i + 3] = 255;
    }
    const src = new ImageData(data, stride, 2);
    const out = scaleFrame(src, { w: 2, h: 2 }, { w: 4, h: 4 });
    // If scaleFrame mistakenly used srcSize.w as the stride, the "junk"
    // pixels would bleed into the interpolation. Top-left output pixel
    // must be the pure red corner.
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 255]);
    // Mid-output should still see only the live 2x2 region.
    const [r, g, b] = pixelAt(out, 1, 1);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // r must come from the red corner alone, not a mix with the 99-greys.
    expect(r).toBeGreaterThanOrEqual(250);
  });
});

describe('scaleAllFrames', () => {
  it('maps scaleFrame across every frame and preserves count', () => {
    const a = imageOf(2, 2, [[255, 0, 0, 255], T, T, T]);
    const b = imageOf(2, 2, [T, [0, 255, 0, 255], T, T]);
    const out = scaleAllFrames([a, b], { w: 2, h: 2 }, { w: 4, h: 4 });
    expect(out).toHaveLength(2);
    expect(pixelAt(out[0], 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out[1], 3, 0)).toEqual([0, 255, 0, 255]);
  });
});
