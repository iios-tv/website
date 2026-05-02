import { startCamera, type FrameSource } from './stream/source';
import {
  applyMask,
  identityMask,
  type SeamMask,
} from './stream/mask';
import { clampCrop, cropImageData, type CropRegion } from './stream/crop';
import type { MaskPayload } from './stream/refine.worker';
import { scaleFrame } from './resize';

const DEFAULT_WIDTH_PCT = 50;
const DEFAULT_HEIGHT_PCT = 50;
const DEFAULT_RES_HINT = 640;
const DEFAULT_WINDOW = 8;
const DEFAULT_CROP_W = 320;
const DEFAULT_CROP_H = 240;

// Throttle main->worker frame sends. Worker only consumes one frame per
// refine cycle anyway; the ring buffer drops the rest. Limiting outbound
// rate avoids piling up postMessage traffic.
const FRAME_SEND_INTERVAL_MS = 50;

type Mode = 'idle' | 'starting' | 'live' | 'error';

type LiveCtx = {
  source: FrameSource;
  worker: Worker;
  mask: SeamMask;
  carvedFrame: ImageData;
  croppedFrame: ImageData;
  renderFrames: number;
  workerMasks: number;
  lastRefineMs: number;
  lastFrameSentAt: number;
  rafHandle: number | null;
  statsHandle: number | null;
  lastStatsAt: number;
  lastRenderCount: number;
  lastMaskCount: number;
};

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startCropX: number;
  startCropY: number;
  rectWidth: number;
  rectHeight: number;
};

export function mountVideoUi(root: HTMLElement): void {
  root.innerHTML = `
    <div class="controls">
      <label>
        Camera res
        <select id="res-hint">
          <option value="320">320</option>
          <option value="480">480</option>
          <option value="640" selected>640</option>
          <option value="960">960</option>
          <option value="1280">1280</option>
        </select>
      </label>
      <label title="The seam carver only sees this rectangle. Drag the red box on the camera preview to position it.">
        Crop W
        <input type="number" id="crop-w" min="32" max="1920" value="${DEFAULT_CROP_W}" />
      </label>
      <label title="Height of the crop region (in camera pixels).">
        Crop H
        <input type="number" id="crop-h" min="32" max="1080" value="${DEFAULT_CROP_H}" />
      </label>
      <label>
        Width %
        <input type="number" id="width-pct" min="1" max="100" value="${DEFAULT_WIDTH_PCT}" />
      </label>
      <label>
        Height %
        <input type="number" id="height-pct" min="1" max="100" value="${DEFAULT_HEIGHT_PCT}" />
      </label>
      <label title="How many recent frames the worker aggregates energy across. Larger window = more temporal coherence, slower refine.">
        Window
        <input type="number" id="window" min="1" max="32" value="${DEFAULT_WINDOW}" />
      </label>
      <label title="After carving, bilinear-scale each frame back up to the crop dimensions. Output keeps original size with low-energy areas compressed.">
        <input type="checkbox" id="scale-back" />
        Scale back to crop size
      </label>
      <button id="apply" disabled>Apply</button>
      <button id="start">Start camera</button>
    </div>
    <div class="status" id="status"></div>
    <div class="preview">
      <div>
        <span class="label" id="orig-label">Camera (idle)</span>
        <div class="camera-stage" id="stage">
          <canvas id="orig"></canvas>
          <div class="crop-overlay hidden" id="crop-overlay"></div>
        </div>
      </div>
      <div>
        <span class="label" id="out-label">Carved (idle)</span>
        <canvas id="out"></canvas>
      </div>
    </div>
    <pre class="stats" id="stats">(start the camera to see stats)</pre>
  `;

  const widthInput = root.querySelector<HTMLInputElement>('#width-pct')!;
  const heightInput = root.querySelector<HTMLInputElement>('#height-pct')!;
  const resInput = root.querySelector<HTMLSelectElement>('#res-hint')!;
  const windowInput = root.querySelector<HTMLInputElement>('#window')!;
  const cropWInput = root.querySelector<HTMLInputElement>('#crop-w')!;
  const cropHInput = root.querySelector<HTMLInputElement>('#crop-h')!;
  const scaleBackInput = root.querySelector<HTMLInputElement>('#scale-back')!;
  const applyBtn = root.querySelector<HTMLButtonElement>('#apply')!;
  const startBtn = root.querySelector<HTMLButtonElement>('#start')!;
  const status = root.querySelector<HTMLDivElement>('#status')!;
  const origCanvas = root.querySelector<HTMLCanvasElement>('#orig')!;
  const outCanvas = root.querySelector<HTMLCanvasElement>('#out')!;
  const origLabel = root.querySelector<HTMLSpanElement>('#orig-label')!;
  const outLabel = root.querySelector<HTMLSpanElement>('#out-label')!;
  const cropOverlay = root.querySelector<HTMLDivElement>('#crop-overlay')!;
  const statsEl = root.querySelector<HTMLPreElement>('#stats')!;

  let mode: Mode = 'idle';
  let live: LiveCtx | null = null;
  let crop: CropRegion = {
    x: 0,
    y: 0,
    w: DEFAULT_CROP_W,
    h: DEFAULT_CROP_H,
  };
  let drag: DragState | null = null;

  function setMode(next: Mode): void {
    mode = next;
    startBtn.textContent = mode === 'live' ? 'Stop camera' : 'Start camera';
    applyBtn.disabled = mode !== 'live';
  }

  // Position the crop overlay using percentages relative to the stage. The
  // stage sizes itself to the canvas's display rect, so percentages auto-
  // adjust if the camera canvas gets CSS-scaled to fit the column.
  function paintOverlay(): void {
    if (!live) {
      cropOverlay.classList.add('hidden');
      return;
    }
    const { width: srcW, height: srcH } = live.source;
    cropOverlay.classList.remove('hidden');
    cropOverlay.style.left = `${(crop.x / srcW) * 100}%`;
    cropOverlay.style.top = `${(crop.y / srcH) * 100}%`;
    cropOverlay.style.width = `${(crop.w / srcW) * 100}%`;
    cropOverlay.style.height = `${(crop.h / srcH) * 100}%`;
  }

  function updateCarvedTarget(): { outW: number; outH: number; windowSize: number } {
    const widthPct = clampPct(widthInput.valueAsNumber, DEFAULT_WIDTH_PCT);
    const heightPct = clampPct(heightInput.valueAsNumber, DEFAULT_HEIGHT_PCT);
    const outW = Math.max(1, Math.floor((crop.w * widthPct) / 100));
    const outH = Math.max(1, Math.floor((crop.h * heightPct) / 100));
    const windowSize = clampInt(windowInput.valueAsNumber, 1, 32, DEFAULT_WINDOW);
    return { outW, outH, windowSize };
  }

  function updateOutLabel(): void {
    if (!live) return;
    const { outW, outH } = live.mask;
    if (scaleBackInput.checked) {
      outLabel.textContent = `Carved (${crop.w}x${crop.h}, scaled back from ${outW}x${outH})`;
    } else {
      outLabel.textContent = `Carved (${outW}x${outH})`;
    }
  }

  function updateOrigLabel(): void {
    if (!live) {
      origLabel.textContent = 'Camera (idle)';
      return;
    }
    origLabel.textContent =
      `Camera (${live.source.width}x${live.source.height}), ` +
      `crop ${crop.w}x${crop.h} @ (${crop.x}, ${crop.y})`;
  }

  cropWInput.addEventListener('change', () => {
    crop.w = clampInt(cropWInput.valueAsNumber, 32, 1920, DEFAULT_CROP_W);
    if (live) crop = clampCrop(crop, { w: live.source.width, h: live.source.height });
    cropWInput.value = String(crop.w);
    paintOverlay();
    updateOrigLabel();
  });
  cropHInput.addEventListener('change', () => {
    crop.h = clampInt(cropHInput.valueAsNumber, 32, 1080, DEFAULT_CROP_H);
    if (live) crop = clampCrop(crop, { w: live.source.width, h: live.source.height });
    cropHInput.value = String(crop.h);
    paintOverlay();
    updateOrigLabel();
  });

  cropOverlay.addEventListener('pointerdown', (e) => {
    if (!live) return;
    e.preventDefault();
    cropOverlay.setPointerCapture(e.pointerId);
    cropOverlay.classList.add('dragging');
    const rect = origCanvas.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCropX: crop.x,
      startCropY: crop.y,
      rectWidth: rect.width,
      rectHeight: rect.height,
    };
  });
  cropOverlay.addEventListener('pointermove', (e) => {
    if (!drag || !live) return;
    const scaleX = live.source.width / drag.rectWidth;
    const scaleY = live.source.height / drag.rectHeight;
    const dx = (e.clientX - drag.startClientX) * scaleX;
    const dy = (e.clientY - drag.startClientY) * scaleY;
    crop = clampCrop(
      {
        x: drag.startCropX + dx,
        y: drag.startCropY + dy,
        w: crop.w,
        h: crop.h,
      },
      { w: live.source.width, h: live.source.height },
    );
    paintOverlay();
    updateOrigLabel();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    cropOverlay.releasePointerCapture(drag.pointerId);
    cropOverlay.classList.remove('dragging');
    drag = null;
  };
  cropOverlay.addEventListener('pointerup', endDrag);
  cropOverlay.addEventListener('pointercancel', endDrag);

  startBtn.addEventListener('click', async () => {
    if (mode === 'live') {
      teardown();
      return;
    }
    if (mode === 'starting') return;

    setMode('starting');
    status.textContent = 'requesting camera...';

    try {
      const idealWidth = clampInt(Number(resInput.value), 160, 1920, DEFAULT_RES_HINT);
      const source = await startCamera({ idealWidth, idealFrameRate: 30 });

      // Ensure crop fits within whatever resolution the camera actually gave us.
      crop = clampCrop(
        {
          x: Math.max(0, Math.floor((source.width - crop.w) / 2)),
          y: Math.max(0, Math.floor((source.height - crop.h) / 2)),
          w: crop.w,
          h: crop.h,
        },
        { w: source.width, h: source.height },
      );
      cropWInput.value = String(crop.w);
      cropHInput.value = String(crop.h);

      const { outW, outH, windowSize } = updateCarvedTarget();

      const worker = new Worker(
        new URL('./stream/refine.worker.ts', import.meta.url),
        { type: 'module' },
      );

      const ctx: LiveCtx = {
        source,
        worker,
        mask: identityMask(crop.w, crop.h, 0),
        carvedFrame: new ImageData(outW, outH),
        croppedFrame: new ImageData(crop.w, crop.h),
        renderFrames: 0,
        workerMasks: 0,
        lastRefineMs: 0,
        lastFrameSentAt: 0,
        rafHandle: null,
        statsHandle: null,
        lastStatsAt: performance.now(),
        lastRenderCount: 0,
        lastMaskCount: 0,
      };
      live = ctx;

      worker.onmessage = (e: MessageEvent<MaskPayload>) => {
        const m = e.data;
        if (m.type !== 'mask') return;
        if (!live) return;
        live.mask = {
          inW: m.inW,
          inH: m.inH,
          outW: m.outW,
          outH: m.outH,
          sourceX: m.sourceX,
          sourceY: m.sourceY,
          generation: m.generation,
        };
        live.workerMasks += 1;
        live.lastRefineMs = m.refineMs;
        if (live.carvedFrame.width !== m.outW || live.carvedFrame.height !== m.outH) {
          live.carvedFrame = new ImageData(m.outW, m.outH);
        }
      };

      worker.onerror = (err) => {
        console.error('worker error:', err);
        status.textContent = `worker error: ${err.message}`;
      };

      worker.postMessage({
        type: 'init',
        inW: crop.w,
        inH: crop.h,
        outW,
        outH,
        windowSize,
      });

      origCanvas.width = source.width;
      origCanvas.height = source.height;
      outCanvas.width = scaleBackInput.checked ? crop.w : outW;
      outCanvas.height = scaleBackInput.checked ? crop.h : outH;

      paintOverlay();
      updateOrigLabel();
      updateOutLabel();

      setMode('live');
      status.textContent = '';
      startRenderLoop();
      startStatsLoop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = `error: ${msg}`;
      console.error(err);
      setMode('error');
    }
  });

  applyBtn.addEventListener('click', () => {
    if (!live) return;
    crop = clampCrop(crop, { w: live.source.width, h: live.source.height });
    cropWInput.value = String(crop.w);
    cropHInput.value = String(crop.h);
    paintOverlay();

    const { outW, outH, windowSize } = updateCarvedTarget();

    live.croppedFrame = new ImageData(crop.w, crop.h);
    live.carvedFrame = new ImageData(outW, outH);
    live.mask = identityMask(crop.w, crop.h, live.mask.generation);

    live.worker.postMessage({
      type: 'init',
      inW: crop.w,
      inH: crop.h,
      outW,
      outH,
      windowSize,
    });

    outCanvas.width = scaleBackInput.checked ? crop.w : outW;
    outCanvas.height = scaleBackInput.checked ? crop.h : outH;
    updateOrigLabel();
    updateOutLabel();
  });

  scaleBackInput.addEventListener('change', () => {
    if (!live) return;
    outCanvas.width = scaleBackInput.checked ? crop.w : live.mask.outW;
    outCanvas.height = scaleBackInput.checked ? crop.h : live.mask.outH;
    updateOutLabel();
  });

  function startRenderLoop(): void {
    if (!live) return;
    const origCtx = origCanvas.getContext('2d')!;
    const outCtx = outCanvas.getContext('2d')!;

    const tick = (): void => {
      if (!live || mode !== 'live') return;
      const ctx = live;

      const frame = ctx.source.captureFrame();
      origCtx.putImageData(frame, 0, 0);

      // Crop to the user-positioned region. Reuse the cropped buffer to avoid
      // per-frame allocation; cropImageData detects geometry mismatches and
      // allocates fresh if needed.
      if (ctx.croppedFrame.width !== crop.w || ctx.croppedFrame.height !== crop.h) {
        ctx.croppedFrame = new ImageData(crop.w, crop.h);
      }
      const cropped = cropImageData(frame, crop, ctx.croppedFrame);

      // Only apply the mask if its input geometry matches the current crop.
      // Mismatch happens transiently right after Apply (worker hasn't posted
      // a fresh mask yet) -- skipping render then keeps stale frames out.
      if (ctx.mask.inW === crop.w && ctx.mask.inH === crop.h) {
        if (
          ctx.carvedFrame.width !== ctx.mask.outW ||
          ctx.carvedFrame.height !== ctx.mask.outH
        ) {
          ctx.carvedFrame = new ImageData(ctx.mask.outW, ctx.mask.outH);
        }
        applyMask(cropped, ctx.mask, ctx.carvedFrame);

        if (scaleBackInput.checked) {
          const scaled = scaleFrame(
            ctx.carvedFrame,
            { w: ctx.mask.outW, h: ctx.mask.outH },
            { w: crop.w, h: crop.h },
          );
          if (outCanvas.width !== scaled.width || outCanvas.height !== scaled.height) {
            outCanvas.width = scaled.width;
            outCanvas.height = scaled.height;
          }
          outCtx.putImageData(scaled, 0, 0);
        } else {
          if (
            outCanvas.width !== ctx.carvedFrame.width ||
            outCanvas.height !== ctx.carvedFrame.height
          ) {
            outCanvas.width = ctx.carvedFrame.width;
            outCanvas.height = ctx.carvedFrame.height;
          }
          outCtx.putImageData(ctx.carvedFrame, 0, 0);
        }
      }

      const now = performance.now();
      if (now - ctx.lastFrameSentAt > FRAME_SEND_INTERVAL_MS) {
        // Send a copy of the cropped buffer (transferred for zero-copy on
        // worker side). The local `cropped` buffer keeps its data because
        // we copy first, then transfer the copy.
        const copy = new Uint8ClampedArray(cropped.data);
        ctx.worker.postMessage(
          {
            type: 'frame',
            buffer: copy.buffer,
            width: cropped.width,
            height: cropped.height,
          },
          [copy.buffer],
        );
        ctx.lastFrameSentAt = now;
      }

      ctx.renderFrames += 1;
      ctx.rafHandle = requestAnimationFrame(tick);
    };
    live.rafHandle = requestAnimationFrame(tick);
  }

  function startStatsLoop(): void {
    if (!live) return;
    const refresh = (): void => {
      if (!live || mode !== 'live') return;
      const now = performance.now();
      const dt = (now - live.lastStatsAt) / 1000;
      const renderFps = (live.renderFrames - live.lastRenderCount) / dt;
      const refineFps = (live.workerMasks - live.lastMaskCount) / dt;
      live.lastStatsAt = now;
      live.lastRenderCount = live.renderFrames;
      live.lastMaskCount = live.workerMasks;

      const lines = [
        `mode:           ${mode}`,
        `camera:         ${live.source.width}x${live.source.height}`,
        `crop:           ${crop.w}x${crop.h} @ (${crop.x}, ${crop.y})`,
        `mask geometry:  ${live.mask.inW}x${live.mask.inH} -> ${live.mask.outW}x${live.mask.outH}`,
        `mask gen:       ${live.mask.generation}`,
        `render fps:     ${renderFps.toFixed(1)}`,
        `refine fps:     ${refineFps.toFixed(1)}`,
        `last refine:    ${live.lastRefineMs.toFixed(1)} ms`,
      ];
      statsEl.textContent = lines.join('\n');

      live.statsHandle = window.setTimeout(refresh, 500);
    };
    refresh();
  }

  function teardown(): void {
    if (!live) {
      setMode('idle');
      return;
    }
    if (live.rafHandle != null) cancelAnimationFrame(live.rafHandle);
    if (live.statsHandle != null) clearTimeout(live.statsHandle);
    live.worker.postMessage({ type: 'stop' });
    live.worker.terminate();
    live.source.stop();
    live = null;
    statsEl.textContent = '(stopped)';
    cropOverlay.classList.add('hidden');
    updateOrigLabel();
    outLabel.textContent = 'Carved (idle)';
    setMode('idle');
  }
}

function clampPct(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
