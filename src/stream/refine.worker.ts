/// <reference lib="webworker" />

// Refine worker. Continuously rebuilds a SeamMask using the last N sampled
// frames, posts the latest mask back to the main thread.
//
// Hot-path strategy:
//   * Working frames, energy map, DP table, seam buffers, and source-coord
//     arrays are all flat typed arrays, allocated once and reused.
//   * Energy is built once at the start of each pass and maintained
//     incrementally: after deleting a seam, only ~2 pixels per row/column
//     have neighbors that actually changed; everything else either is
//     untouched or is correctly carried by a row/column shift in the
//     energy map (mirroring the shift in pixel data).
//   * Seam deletion uses copyWithin for row shifts (memmove inside the
//     typed array) on H seams and a tight per-pixel loop on V seams.
//
// Carrying source coordinates through the carve:
//   sourceX/sourceY arrays start as identity at full input geometry. Each
//   seam removal applies the same shift to those arrays, so after the carve
//   the top-left (outW x outH) of those arrays maps each output pixel back
//   to its source pixel in the most recent frames.

import {
  aggregateEnergyHFlat,
  aggregateEnergyVFlat,
  deleteSeamHFromCoords,
  deleteSeamHFromEnergy,
  deleteSeamHFromFrame,
  deleteSeamVFromCoords,
  deleteSeamVFromEnergy,
  deleteSeamVFromFrame,
  findLowEnergySeamHFlat,
  findLowEnergySeamVFlat,
  refreshEnergyAfterSeamH,
  refreshEnergyAfterSeamV,
} from './fast';
import type { ImageSize } from '../types';

declare const self: DedicatedWorkerGlobalScope;

type InitMsg = {
  type: 'init';
  inW: number;
  inH: number;
  outW: number;
  outH: number;
  windowSize: number;
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
  windowFrames: number;
};

let inW = 0;
let inH = 0;
let outW = 0;
let outH = 0;
let windowSize = 8;
let ring: ImageData[] = [];
let running = false;
let generation = 0;

// Persistent buffers, reallocated when geometry changes.
let workingFrames: ImageData[] = [];
let energyBuf: Float32Array | null = null;
let dpEnergy: Float64Array | null = null;
let dpPrev: Int8Array | null = null;
let seamRowX: Int16Array | null = null;
let seamColY: Int16Array | null = null;
let sourceX: Int16Array | null = null;
let sourceY: Int16Array | null = null;

function ensureBuffers(): void {
  const px = inW * inH;
  if (!energyBuf || energyBuf.length !== px) {
    energyBuf = new Float32Array(px);
    dpEnergy = new Float64Array(px);
    dpPrev = new Int8Array(px);
    seamRowX = new Int16Array(inH);
    seamColY = new Int16Array(inW);
    sourceX = new Int16Array(px);
    sourceY = new Int16Array(px);
    workingFrames = [];
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
      windowSize = Math.max(1, msg.windowSize);
      ring = [];
      generation = 0;
      ensureBuffers();
      if (!running) {
        running = true;
        void loop();
      }
      break;
    case 'frame': {
      if (msg.width !== inW || msg.height !== inH) break; // stale frame from previous geometry
      const data = new Uint8ClampedArray(msg.buffer);
      ring.push(new ImageData(data, msg.width, msg.height));
      while (ring.length > windowSize) ring.shift();
      break;
    }
    case 'setTarget':
      outW = msg.outW;
      outH = msg.outH;
      break;
    case 'stop':
      running = false;
      ring = [];
      break;
  }
};

async function loop(): Promise<void> {
  while (running) {
    if (
      ring.length === 0 ||
      outW <= 0 ||
      outH <= 0 ||
      outW > inW ||
      outH > inH ||
      !energyBuf ||
      !dpEnergy ||
      !dpPrev ||
      !seamRowX ||
      !seamColY ||
      !sourceX ||
      !sourceY
    ) {
      await waitMs(20);
      continue;
    }

    const t0 = performance.now();

    // Snapshot the ring (callers may push more frames mid-cycle).
    const snapshot = ring.slice();
    const N = snapshot.length;
    const stride = inW;
    const px = inW * inH;

    // Reuse existing ImageData wrappers for working frames; refresh their
    // underlying bytes from the snapshot. Avoids per-cycle ImageData
    // construction churn.
    while (workingFrames.length < N) {
      workingFrames.push(new ImageData(new Uint8ClampedArray(px * 4), inW, inH));
    }
    while (workingFrames.length > N) workingFrames.pop();
    for (let f = 0; f < N; f += 1) {
      workingFrames[f].data.set(snapshot[f].data);
    }

    // Identity source coords.
    for (let y = 0; y < inH; y += 1) {
      const rowBase = y * stride;
      for (let x = 0; x < inW; x += 1) {
        sourceX[rowBase + x] = x;
        sourceY[rowBase + x] = y;
      }
    }

    const size: ImageSize = { w: inW, h: inH };
    const targetW = outW;
    const targetH = outH;

    // --- Width pass: delete vertical seams (carve columns) ---
    aggregateEnergyHFlat(workingFrames, size, energyBuf, stride);
    for (let i = 0; i < inW - targetW; i += 1) {
      findLowEnergySeamHFlat(energyBuf, size, stride, dpEnergy, dpPrev, seamRowX);
      for (let f = 0; f < N; f += 1) {
        deleteSeamHFromFrame(workingFrames[f], seamRowX, size, stride);
      }
      deleteSeamHFromCoords(sourceX, sourceY, seamRowX, size, stride);
      deleteSeamHFromEnergy(energyBuf, seamRowX, size, stride);
      size.w -= 1;
      refreshEnergyAfterSeamH(workingFrames, energyBuf, seamRowX, size, stride);
    }

    // --- Height pass: delete horizontal seams (carve rows) ---
    if (inH - targetH > 0) {
      aggregateEnergyVFlat(workingFrames, size, energyBuf, stride);
      for (let i = 0; i < inH - targetH; i += 1) {
        findLowEnergySeamVFlat(energyBuf, size, stride, dpEnergy, dpPrev, seamColY);
        for (let f = 0; f < N; f += 1) {
          deleteSeamVFromFrame(workingFrames[f], seamColY, size, stride);
        }
        deleteSeamVFromCoords(sourceX, sourceY, seamColY, size, stride);
        deleteSeamVFromEnergy(energyBuf, seamColY, size, stride);
        size.h -= 1;
        refreshEnergyAfterSeamV(workingFrames, energyBuf, seamColY, size, stride);
      }
    }

    // Pack the (targetW x targetH) top-left source coords into a tight mask.
    const maskSourceX = new Int16Array(targetW * targetH);
    const maskSourceY = new Int16Array(targetW * targetH);
    for (let y = 0; y < targetH; y += 1) {
      const srcRow = y * stride;
      const dstRow = y * targetW;
      for (let x = 0; x < targetW; x += 1) {
        maskSourceX[dstRow + x] = sourceX[srcRow + x];
        maskSourceY[dstRow + x] = sourceY[srcRow + x];
      }
    }

    const refineMs = performance.now() - t0;
    generation += 1;

    const payload: MaskPayload = {
      type: 'mask',
      inW,
      inH,
      outW: targetW,
      outH: targetH,
      sourceX: maskSourceX,
      sourceY: maskSourceY,
      generation,
      refineMs,
      windowFrames: snapshot.length,
    };

    self.postMessage(payload, [maskSourceX.buffer, maskSourceY.buffer]);

    await waitMs(0);
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
