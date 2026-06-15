import { describe, expect, it } from 'vitest';

import {
  aggregateEnergyHFlat,
  aggregateEnergyVFlat,
  deleteSeamHFromEnergy,
  deleteSeamHFromFrame,
  deleteSeamVFromEnergy,
  deleteSeamVFromFrame,
  emaBlend,
  frameEnergyHFlat,
  frameEnergyVFlat,
  refreshEnergyFromFrameH,
  refreshEnergyFromFrameV,
} from './fast';
import type { ImageSize } from '../types';

// Small RGBA-gradient frame with deterministic per-pixel values, fully
// opaque (avoids the alpha-gating branch so we're testing the gradient
// math itself). Width-major ordering: r increases with x, g with y.
function gradientFrame(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      data[i + 0] = (x * 37) & 0xff;
      data[i + 1] = (y * 53) & 0xff;
      data[i + 2] = ((x + y) * 19) & 0xff;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

describe('frameEnergyHFlat', () => {
  it('matches aggregateEnergyHFlat on a single frame (the inner branch with N=1)', () => {
    const frame = gradientFrame(8, 6);
    const size: ImageSize = { w: 8, h: 6 };

    const aggregate = new Float32Array(8 * 6);
    aggregateEnergyHFlat([frame], size, aggregate, 8);

    const single = new Float32Array(8 * 6);
    frameEnergyHFlat(frame, size, single, 8);

    // MAX over a one-element set is the element itself.
    expect(Array.from(single)).toEqual(Array.from(aggregate));
  });

  it('respects stride > size.w (write to logical region only)', () => {
    const frame = gradientFrame(8, 4);
    const stride = 8;
    const energy = new Float32Array(8 * 4).fill(-1); // sentinel
    // Only write to the top-left 5x4 logical region.
    frameEnergyHFlat(frame, { w: 5, h: 4 }, energy, stride);
    for (let y = 0; y < 4; y += 1) {
      // Logical region populated (will not equal the sentinel).
      for (let x = 0; x < 5; x += 1) {
        expect(energy[y * stride + x]).not.toBe(-1);
      }
      // Trailing stride cells untouched.
      for (let x = 5; x < stride; x += 1) {
        expect(energy[y * stride + x]).toBe(-1);
      }
    }
  });
});

describe('frameEnergyVFlat', () => {
  it('matches aggregateEnergyVFlat on a single frame', () => {
    const frame = gradientFrame(8, 6);
    const size: ImageSize = { w: 8, h: 6 };

    const aggregate = new Float32Array(8 * 6);
    aggregateEnergyVFlat([frame], size, aggregate, 8);

    const single = new Float32Array(8 * 6);
    frameEnergyVFlat(frame, size, single, 8);

    expect(Array.from(single)).toEqual(Array.from(aggregate));
  });
});

describe('emaBlend', () => {
  it('converges to a constant input within ~log_(1-a)(epsilon) iterations', () => {
    const target = new Float32Array(64);
    const sample = new Float32Array(64).fill(100);
    const alpha = 0.5;
    // (1 - 0.5)^20 ~= 1e-6 of the residual, well under tolerances below.
    for (let i = 0; i < 20; i += 1) emaBlend(target, sample, alpha);
    for (let i = 0; i < target.length; i += 1) {
      expect(target[i]).toBeCloseTo(100, 3);
    }
  });

  it('first blend is exactly target * (1 - a) + sample * a', () => {
    const target = new Float32Array([10, 20, 30, 40]);
    const sample = new Float32Array([100, 200, 300, 400]);
    emaBlend(target, sample, 0.25);
    // (1 - 0.25) * 10 + 0.25 * 100 = 7.5 + 25 = 32.5
    expect(target[0]).toBeCloseTo(32.5, 6);
    expect(target[1]).toBeCloseTo(65, 6);
    expect(target[2]).toBeCloseTo(97.5, 6);
    expect(target[3]).toBeCloseTo(130, 6);
  });

  it('alpha = 1 replaces target with sample exactly', () => {
    const target = new Float32Array([1, 2, 3]);
    const sample = new Float32Array([99, 100, 101]);
    emaBlend(target, sample, 1);
    expect(Array.from(target)).toEqual([99, 100, 101]);
  });

  it('iterates only min(target.length, sample.length) entries', () => {
    const target = new Float32Array([1, 1, 1, 1]);
    const sample = new Float32Array([10, 10]); // shorter
    emaBlend(target, sample, 0.5);
    expect(target[0]).toBeCloseTo(5.5, 6);
    expect(target[1]).toBeCloseTo(5.5, 6);
    expect(target[2]).toBe(1); // untouched
    expect(target[3]).toBe(1);
  });
});

describe('refreshEnergyFromFrameH', () => {
  it('reconciles seam-neighbour cells to a full rebuild on the post-shift frame', () => {
    // Setup: build a frame at (w=6, h=4), compute single-frame H energy
    // (ground truth A). Pretend we deleted a vertical seam at x=3 in each
    // row; physically shift both frame and energy left from that column,
    // then call refresh on the shifted state. The result must match a
    // from-scratch rebuild on the shifted frame at the new logical size.
    const w = 6;
    const h = 4;
    const stride = w;
    const frame = gradientFrame(w, h);
    const sizeOrig: ImageSize = { w, h };

    const originalEnergy = new Float32Array(w * h);
    frameEnergyHFlat(frame, sizeOrig, originalEnergy, stride);

    const seamRowX = new Int16Array(h);
    for (let y = 0; y < h; y += 1) seamRowX[y] = 3;

    // Shift in lockstep, then shrink the logical width.
    deleteSeamHFromFrame(frame, seamRowX, sizeOrig, stride);
    const workEnergy = new Float32Array(originalEnergy);
    deleteSeamHFromEnergy(workEnergy, seamRowX, sizeOrig, stride);
    const sizeShifted: ImageSize = { w: w - 1, h };

    // Ground truth: from-scratch rebuild on the shifted frame.
    const groundTruth = new Float32Array(w * h);
    frameEnergyHFlat(frame, sizeShifted, groundTruth, stride);

    // Sanity: before refresh, at least the seam-adjacent cells should
    // *differ* from the ground truth. Otherwise the test isn't actually
    // exercising refresh.
    let anyMismatch = false;
    for (let y = 0; y < h; y += 1) {
      if (workEnergy[y * stride + 2] !== groundTruth[y * stride + 2]) anyMismatch = true;
      if (workEnergy[y * stride + 3] !== groundTruth[y * stride + 3]) anyMismatch = true;
    }
    expect(anyMismatch).toBe(true);

    refreshEnergyFromFrameH(frame, workEnergy, seamRowX, sizeShifted, stride);

    for (let y = 0; y < sizeShifted.h; y += 1) {
      for (let x = 0; x < sizeShifted.w; x += 1) {
        expect(workEnergy[y * stride + x]).toBe(groundTruth[y * stride + x]);
      }
    }
  });
});

describe('refreshEnergyFromFrameV', () => {
  it('reconciles seam-neighbour cells to a full rebuild on the post-shift frame', () => {
    const w = 4;
    const h = 6;
    const stride = w;
    const frame = gradientFrame(w, h);
    const sizeOrig: ImageSize = { w, h };

    const originalEnergy = new Float32Array(w * h);
    frameEnergyVFlat(frame, sizeOrig, originalEnergy, stride);

    const seamColY = new Int16Array(w);
    for (let x = 0; x < w; x += 1) seamColY[x] = 3;

    deleteSeamVFromFrame(frame, seamColY, sizeOrig, stride);
    const workEnergy = new Float32Array(originalEnergy);
    deleteSeamVFromEnergy(workEnergy, seamColY, sizeOrig, stride);
    const sizeShifted: ImageSize = { w, h: h - 1 };

    const groundTruth = new Float32Array(w * h);
    frameEnergyVFlat(frame, sizeShifted, groundTruth, stride);

    refreshEnergyFromFrameV(frame, workEnergy, seamColY, sizeShifted, stride);

    for (let y = 0; y < sizeShifted.h; y += 1) {
      for (let x = 0; x < sizeShifted.w; x += 1) {
        expect(workEnergy[y * stride + x]).toBe(groundTruth[y * stride + x]);
      }
    }
  });
});
