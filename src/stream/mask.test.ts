import { describe, expect, it } from 'vitest';

import { applyMask, downscaleFrame, identityMask, upscaleMask, type SeamMask } from './mask';
import { pixelAt } from '../test-utils/synth';

function imageOf(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i + 0] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return new ImageData(data, w, h);
}

describe('downscaleFrame', () => {
  it('halves a 4x4 two-cell checkerboard into a 2x2 one-cell checkerboard', () => {
    // 4x4 source: 2x2 white block top-left, 2x2 black top-right, etc.
    //   WW BB
    //   WW BB
    //   BB WW
    //   BB WW
    const src = imageOf(4, 4, (x, y) => {
      const cellX = Math.floor(x / 2);
      const cellY = Math.floor(y / 2);
      const white = (cellX + cellY) % 2 === 0;
      return white ? [255, 255, 255, 255] : [0, 0, 0, 255];
    });

    const dst = new ImageData(2, 2);
    downscaleFrame(src, dst);

    // Center-pixel sampling lands on src(1,1)=W, src(3,1)=B, src(1,3)=B, src(3,3)=W.
    expect(pixelAt(dst, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(dst, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(dst, 0, 1)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(dst, 1, 1)).toEqual([255, 255, 255, 255]);
  });

  it('preserves a uniform colour exactly', () => {
    const colour: [number, number, number, number] = [50, 150, 200, 255];
    const src = imageOf(6, 6, () => colour);
    const dst = new ImageData(3, 3);
    downscaleFrame(src, dst);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        expect(pixelAt(dst, x, y)).toEqual(colour);
      }
    }
  });

  it('identity-copies when src and dst have matching dimensions', () => {
    const src = imageOf(3, 2, (x, y) => [x * 80, y * 120, 33, 255]);
    const dst = new ImageData(3, 2);
    downscaleFrame(src, dst);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        expect(pixelAt(dst, x, y)).toEqual(pixelAt(src, x, y));
      }
    }
  });

  it('non-integer downscale ratios still produce in-bounds sampling', () => {
    const src = imageOf(10, 10, (x, y) => [x * 25, y * 25, 0, 255]);
    const dst = new ImageData(3, 3);
    downscaleFrame(src, dst);
    // All output pixels should be valid (alpha 255 from source).
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        expect(pixelAt(dst, x, y)[3]).toBe(255);
      }
    }
  });
});

describe('upscaleMask', () => {
  it('produces an identity full-res mask from an identity refine-res mask (same scale x/y)', () => {
    const refine = identityMask(2, 2, 7);
    const full = upscaleMask(refine, 4, 4, 4, 4);
    expect(full.inW).toBe(4);
    expect(full.inH).toBe(4);
    expect(full.outW).toBe(4);
    expect(full.outH).toBe(4);
    expect(full.generation).toBe(7);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const i = y * 4 + x;
        expect(full.sourceX[i]).toBe(x);
        expect(full.sourceY[i]).toBe(y);
      }
    }
  });

  it('translates a refine-res column swap into a full-res column-block swap', () => {
    // Refine mask: 2x2 with columns swapped (output col 0 reads source col 1
    // and vice versa).
    const refine: SeamMask = {
      inW: 2,
      inH: 2,
      outW: 2,
      outH: 2,
      sourceX: new Int16Array([1, 0, 1, 0]),
      sourceY: new Int16Array([0, 0, 1, 1]),
      generation: 0,
    };
    const full = upscaleMask(refine, 4, 4, 4, 4);

    // Apply both to a controlled full-res frame and check the output
    // matches a column-block swap (left 2 cols swapped with right 2 cols).
    const src = imageOf(4, 4, (x, y) => [x * 60, y * 60, 0, 255]);
    const dst = new ImageData(4, 4);
    applyMask(src, full, dst);

    // Output column 0 should mirror source column 2 (the left of the right
    // block); column 1 should mirror source column 3; columns 2,3 should
    // mirror source columns 0,1.
    for (let y = 0; y < 4; y += 1) {
      expect(pixelAt(dst, 0, y)).toEqual(pixelAt(src, 2, y));
      expect(pixelAt(dst, 1, y)).toEqual(pixelAt(src, 3, y));
      expect(pixelAt(dst, 2, y)).toEqual(pixelAt(src, 0, y));
      expect(pixelAt(dst, 3, y)).toEqual(pixelAt(src, 1, y));
    }
  });

  it('handles asymmetric scaling (refine smaller in one axis only)', () => {
    // Refine 2x4 -> full 4x4 (x-axis is 2x, y-axis is 1x).
    const refine = identityMask(2, 4, 0);
    const full = upscaleMask(refine, 4, 4, 4, 4);
    expect(full.inW).toBe(4);
    expect(full.inH).toBe(4);
    // Identity in y, doubled in x.
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const i = y * 4 + x;
        expect(full.sourceX[i]).toBe(x);
        expect(full.sourceY[i]).toBe(y);
      }
    }
  });

  it('clamps source coords to fullIn bounds (no out-of-range writes)', () => {
    // Pathological mask whose source coords sit right at the refine edge;
    // after the inScale multiplication + subX they could exceed fullIn-1
    // without clamping.
    const refine: SeamMask = {
      inW: 2,
      inH: 2,
      outW: 2,
      outH: 2,
      sourceX: new Int16Array([1, 1, 1, 1]),
      sourceY: new Int16Array([1, 1, 1, 1]),
      generation: 0,
    };
    const full = upscaleMask(refine, 4, 4, 4, 4);
    for (let i = 0; i < full.sourceX.length; i += 1) {
      expect(full.sourceX[i]).toBeGreaterThanOrEqual(0);
      expect(full.sourceX[i]).toBeLessThanOrEqual(3);
      expect(full.sourceY[i]).toBeGreaterThanOrEqual(0);
      expect(full.sourceY[i]).toBeLessThanOrEqual(3);
    }
  });
});
