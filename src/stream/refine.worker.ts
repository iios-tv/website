/// <reference lib="webworker" />

// Refine worker. Continuously maintains a SeamMask the main thread applies
// to each rendered frame. Two layers of optimization vs the obvious design:
//
//   1. Energy is an *EMA* of single-frame gradients, maintained incrementally
//      across frames. The old ring-of-N-frames + per-cycle MAX rebuild made
//      a subject's recent positions linger as "ghost" energy that seams
//      steered around, so the mask took N cycles to forget you'd moved. EMA
//      with alpha ~0.25 has a ~4-frame half-life, both faster to react and
//      cheaper to maintain (no copy of N frames per cycle).
//
//   2. Carving runs on a *downscaled* refine grid (REFINE_SCALE). Seams
//      picked at half-res match full-res seam topology closely on camera
//      footage, but the DP + delete loops drop ~4x in work. The published
//      mask is upscaled to the full crop resolution before going to the
//      main thread, so the render path is unaware of the downsample.
//
// Per-frame handler (very cheap): downscale -> frameEnergyH/V into scratch
// -> EMA-blend into persistent energyH/V -> store latestFrame for boundary
// refresh during the next carve.
//
// Per-cycle loop: snapshot the EMA buffers (so the carve can mutate them
// independently of incoming frame messages), carve at refine res, repack
// source coords into a tight refine-res mask, upscale to full crop res,
// transfer to the main thread.

import {
  emaBlend,
  frameEnergyHFlat,
  frameEnergyVFlat,
  deleteSeamHFromCoords,
  deleteSeamHFromEnergy,
  deleteSeamHFromFrame,
  deleteSeamVFromCoords,
  deleteSeamVFromEnergy,
  deleteSeamVFromFrame,
  findLowEnergySeamHFlat,
  findLowEnergySeamVFlat,
  refreshEnergyFromFrameH,
  refreshEnergyFromFrameV,
} from './fast';
import { downscaleFrame, upscaleMask, type SeamMask } from './mask';
import type { ImageSize } from '../types';

declare const self: DedicatedWorkerGlobalScope;

type InitMsg = {
  type: 'init';
  inW: number;
  inH: number;
  outW: number;
  outH: number;
  // EMA blend factor in (0, 1]. Higher = follows motion faster, more flicker.
  alpha: number;
};
type FrameMsg = {
  type: 'frame';
  buffer: ArrayBuffer;
  width: number;
  height: number;
};
type SetTargetMsg = { type: 'setTarget'; outW: number; outH: number };
type StopMsg = { type: 'stop' };
type InMsg = InitMsg | FrameMsg | SetTargetMsg | StopMsg;

export type MaskPayload = {
  type: 'mask';
  inW: number;
  inH: number;
  outW: number;
  outH: number;
  sourceX: Int16Array;
  sourceY: Int16Array;
  generation: number;
  refineMs: number;
  // Reported back so the UI can show what scale + alpha the worker is
  // actually using (e.g. after init bounds-clamped them).
  refineScale: number;
  alpha: number;
};

// Refine at half resolution. The seams picked on the downsampled grid match
// full-res topology closely on camera footage. Bump toward 1.0 if details
// get coarse; drop toward 0.25 for more headroom on slower devices.
const REFINE_SCALE = 0.5;
const DEFAULT_ALPHA = 0.25;

// Crop dimensions from the main thread.
let inW = 0;
let inH = 0;
// Final mask dimensions the main thread expects (matches crop * size %).
let outW = 0;
let outH = 0;
// Refine-grid dimensions = floor(crop * REFINE_SCALE), with a floor of 8 so
// the DP search has room to work even on tiny crops.
let refineW = 0;
let refineH = 0;
let refineOutW = 0;
let refineOutH = 0;

let alpha = DEFAULT_ALPHA;
let running = false;
let generation = 0;
// True until the first frame has been blended in. We seed the EMA buffers
// to the first frame's energy directly (no blend) so the very first carve
// has a reasonable mask instead of starting from zeros.
let needsBootstrap = true;

// Most recent downscaled frame -- the source of truth between cycles.
// Frame messages overwrite this; the loop snapshots it into workingFrame at
// the start of each cycle so the carve can mutate pixels in lockstep with
// the energy / source coord buffers without racing the 'frame' handler.
let latestFrame: ImageData | null = null;

// Persistent buffers, reallocated when refine geometry changes.
let energyHEma: Float32Array | null = null;
let energyVEma: Float32Array | null = null;
let frameEnergyScratch: Float32Array | null = null;
// One working copy per axis. The carve loop mutates these in place (delete
// shifts cells); the persistent EMA buffers stay intact for the next cycle.
let workingEnergyH: Float32Array | null = null;
let workingEnergyV: Float32Array | null = null;
let dpEnergy: Float64Array | null = null;
let dpPrev: Int8Array | null = null;
let seamRowX: Int16Array | null = null;
let seamColY: Int16Array | null = null;
let sourceX: Int16Array | null = null;
let sourceY: Int16Array | null = null;
let downscaledFrame: ImageData | null = null;
// Per-cycle working copy of latestFrame that the carve shifts in lockstep
// with energy/source coords. `refreshEnergyFromFrameH/V` reads pixels from
// this (the post-carve frame) just like the static carve path does --
// reading from the un-carved latestFrame would feed the refresh wrong
// neighbour pixels, which over many cycles concentrates seam removal in
// one region of the image.
let workingFrame: ImageData | null = null;

function recomputeRefineGeometry(): void {
  refineW = Math.max(8, Math.floor(inW * REFINE_SCALE));
  refineH = Math.max(8, Math.floor(inH * REFINE_SCALE));
  // outW/outH may be 0 momentarily (e.g. init before user picked a size).
  refineOutW = outW > 0 ? Math.max(1, Math.min(refineW, Math.floor(outW * REFINE_SCALE))) : refineW;
  refineOutH = outH > 0 ? Math.max(1, Math.min(refineH, Math.floor(outH * REFINE_SCALE))) : refineH;
}

function ensureBuffers(): void {
  const px = refineW * refineH;
  if (!energyHEma || energyHEma.length !== px) {
    energyHEma = new Float32Array(px);
    energyVEma = new Float32Array(px);
    frameEnergyScratch = new Float32Array(px);
    workingEnergyH = new Float32Array(px);
    workingEnergyV = new Float32Array(px);
    dpEnergy = new Float64Array(px);
    dpPrev = new Int8Array(px);
    seamRowX = new Int16Array(refineH);
    seamColY = new Int16Array(refineW);
    sourceX = new Int16Array(px);
    sourceY = new Int16Array(px);
    downscaledFrame = new ImageData(refineW, refineH);
    workingFrame = new ImageData(refineW, refineH);
    latestFrame = null;
    needsBootstrap = true;
  }
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      inW = msg.inW;
      inH = msg.inH;
      outW = msg.outW;
      outH = msg.outH;
      alpha = clampAlpha(msg.alpha);
      generation = 0;
      recomputeRefineGeometry();
      ensureBuffers();
      if (!running) {
        running = true;
        void loop();
      }
      break;

    case 'frame': {
      if (msg.width !== inW || msg.height !== inH) {
        // Stale frame from a prior geometry. Drop it; the main thread will
        // reflect the new size next tick.
        break;
      }
      if (!downscaledFrame || !energyHEma || !energyVEma || !frameEnergyScratch) {
        break;
      }
      // Downscale the incoming crop into the refine grid.
      const fullFrame = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
      downscaleFrame(fullFrame, downscaledFrame);

      const refineSize: ImageSize = { w: refineW, h: refineH };

      // Compute single-frame H + V gradient energy from the downscaled
      // frame, then blend (or seed) into the persistent EMA buffers.
      frameEnergyHFlat(downscaledFrame, refineSize, frameEnergyScratch, refineW);
      if (needsBootstrap) {
        energyHEma.set(frameEnergyScratch);
      } else {
        emaBlend(energyHEma, frameEnergyScratch, alpha);
      }
      frameEnergyVFlat(downscaledFrame, refineSize, frameEnergyScratch, refineW);
      if (needsBootstrap) {
        energyVEma.set(frameEnergyScratch);
      } else {
        emaBlend(energyVEma, frameEnergyScratch, alpha);
      }
      needsBootstrap = false;
      latestFrame = downscaledFrame;
      break;
    }

    case 'setTarget':
      outW = msg.outW;
      outH = msg.outH;
      recomputeRefineGeometry();
      break;

    case 'stop':
      running = false;
      latestFrame = null;
      break;
  }
};

async function loop(): Promise<void> {
  while (running) {
    if (
      !latestFrame ||
      !workingFrame ||
      !energyHEma ||
      !energyVEma ||
      !workingEnergyH ||
      !workingEnergyV ||
      !dpEnergy ||
      !dpPrev ||
      !seamRowX ||
      !seamColY ||
      !sourceX ||
      !sourceY ||
      outW <= 0 ||
      outH <= 0 ||
      outW > inW ||
      outH > inH
    ) {
      await waitMs(20);
      continue;
    }

    const t0 = performance.now();
    const stride = refineW;
    const targetW = refineOutW;
    const targetH = refineOutH;
    const size: ImageSize = { w: refineW, h: refineH };

    // Identity source coords on the refine grid. The carve shifts these
    // in lockstep with the energy buffers; the top-left (targetW x targetH)
    // after carving becomes the refine-resolution mask.
    for (let y = 0; y < refineH; y += 1) {
      const rowBase = y * stride;
      for (let x = 0; x < refineW; x += 1) {
        sourceX[rowBase + x] = x;
        sourceY[rowBase + x] = y;
      }
    }

    // Snapshot EMAs and the latest frame into working copies. The carve
    // mutates the working buffers (delete shifts pixels, energy, source
    // coords in lockstep); the persistent EMA + latestFrame stay intact
    // for the next cycle (latestFrame keeps being overwritten by 'frame'
    // messages, the EMA keeps blending in any frames that arrive between
    // cycles).
    workingEnergyH.set(energyHEma);
    workingEnergyV.set(energyVEma);
    workingFrame.data.set(latestFrame.data);

    // --- Width pass: delete vertical seams (carve columns) ---
    // Pixels, H energy, V energy, and source coords all shift left in
    // lockstep. The V EMA at a surviving position remains correct after
    // a column shift (vertical neighbours of surviving columns don't
    // change), so V energy carries through without rebuilding.
    for (let i = 0; i < refineW - targetW; i += 1) {
      findLowEnergySeamHFlat(workingEnergyH, size, stride, dpEnergy, dpPrev, seamRowX);
      deleteSeamHFromFrame(workingFrame, seamRowX, size, stride);
      deleteSeamHFromCoords(sourceX, sourceY, seamRowX, size, stride);
      deleteSeamHFromEnergy(workingEnergyH, seamRowX, size, stride);
      deleteSeamHFromEnergy(workingEnergyV, seamRowX, size, stride);
      size.w -= 1;
      // Refresh only the cells whose H-gradient neighbours actually
      // changed (two per row), reading from the *carved* workingFrame
      // so the new neighbour pixels are the right ones. Reading from
      // the un-carved latestFrame here was a real bug: refresh would
      // pull pixels from across the deleted column, gradually corrupt
      // the energy map, and end up concentrating all seam removal in
      // one region of the image (causing visible flicker and a carve
      // that ignores half the input).
      refreshEnergyFromFrameH(workingFrame, workingEnergyH, seamRowX, size, stride);
    }

    // --- Height pass: delete horizontal seams (carve rows) ---
    for (let i = 0; i < refineH - targetH; i += 1) {
      findLowEnergySeamVFlat(workingEnergyV, size, stride, dpEnergy, dpPrev, seamColY);
      deleteSeamVFromFrame(workingFrame, seamColY, size, stride);
      deleteSeamVFromCoords(sourceX, sourceY, seamColY, size, stride);
      deleteSeamVFromEnergy(workingEnergyV, seamColY, size, stride);
      size.h -= 1;
      refreshEnergyFromFrameV(workingFrame, workingEnergyV, seamColY, size, stride);
    }

    // Pack the (targetW x targetH) top-left of source coords into a tight
    // refine-resolution mask, then upscale to full crop res before publishing.
    const refineSourceX = new Int16Array(targetW * targetH);
    const refineSourceY = new Int16Array(targetW * targetH);
    for (let y = 0; y < targetH; y += 1) {
      const srcRow = y * stride;
      const dstRow = y * targetW;
      for (let x = 0; x < targetW; x += 1) {
        refineSourceX[dstRow + x] = sourceX[srcRow + x];
        refineSourceY[dstRow + x] = sourceY[srcRow + x];
      }
    }

    const refineMask: SeamMask = {
      inW: refineW,
      inH: refineH,
      outW: targetW,
      outH: targetH,
      sourceX: refineSourceX,
      sourceY: refineSourceY,
      generation: generation + 1,
    };
    const fullMask = upscaleMask(refineMask, inW, inH, outW, outH);

    const refineMs = performance.now() - t0;
    generation += 1;

    const payload: MaskPayload = {
      type: 'mask',
      inW: fullMask.inW,
      inH: fullMask.inH,
      outW: fullMask.outW,
      outH: fullMask.outH,
      sourceX: fullMask.sourceX,
      sourceY: fullMask.sourceY,
      generation,
      refineMs,
      refineScale: REFINE_SCALE,
      alpha,
    };

    self.postMessage(payload, [fullMask.sourceX.buffer, fullMask.sourceY.buffer]);

    await waitMs(0);
  }
}

function clampAlpha(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ALPHA;
  if (value > 1) return 1;
  return value;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
