import { startCamera, type FrameSource } from './stream/source';
import {
  applyMask,
  identityMask,
  type SeamMask,
} from './stream/mask';
import { clampCrop, type CropRegion } from './stream/crop';
import type { MaskPayload } from './stream/refine.worker';

const DEFAULT_WIDTH_PCT = 50;
const DEFAULT_HEIGHT_PCT = 50;
const DEFAULT_RES_HINT = 640;
// EMA blend factor. Higher follows motion faster (less catch-up lag) at
// the cost of more flicker. ~0.25 = ~4-frame half-life, a comfortable
// default on camera footage.
const DEFAULT_ALPHA = 0.25;
const DEFAULT_CROP_W = 320;
const DEFAULT_CROP_H = 240;

// Throttle main->worker frame sends. The worker only consumes one frame
// per refine cycle anyway; dropping the rest keeps postMessage traffic
// proportional to refine rate rather than render rate.
const FRAME_SEND_INTERVAL_MS = 50;

// Render-thread mask smoothing. The worker publishes a fresh mask each
// refine cycle, but small numerical wiggles in the EMA energy regularly
// flip the DP between two near-equal seams, so adjacent published masks
// shift output pixels by 1-2 px even when the subject is still. We keep
// a float copy of the displayed source coords and EMA-blend it toward
// each new worker mask per render frame; rounded ints feed applyMask.
// 1-px pick flips fade in over ~3-4 render frames instead of snapping,
// while still tracking real subject motion within ~50 ms.
//
// Lower -> smoother / more lag, higher -> snappier / more flicker.
const DEFAULT_MASK_SMOOTH_ALPHA = 0.05;

type Mode = 'idle' | 'starting' | 'live' | 'error';

// SeamMask plus the float source-coord buffers we EMA-blend toward the
// latest worker mask. The int sourceX/sourceY are derived (rounded) from
// the floats on every blend, so SmoothMask is a drop-in for applyMask.
type SmoothMask = SeamMask & {
  sourceXf: Float32Array;
  sourceYf: Float32Array;
};

type LiveCtx = {
  source: FrameSource;
  worker: Worker;
  mask: SeamMask;
  // EMA-blended copy of `mask` used for actual rendering; smooths sub-
  // pixel cycle-to-cycle flicker without affecting the carve algorithm.
  smoothMask: SmoothMask | null;
  // Render-thread mask EMA blend factor. Live-tunable via the Smoothing
  // input (no Apply needed); the render loop reads this every tick.
  smoothAlpha: number;
  carvedFrame: ImageData;
  renderFrames: number;
  workerMasks: number;
  lastRefineMs: number;
  lastRefineScale: number;
  lastAlpha: number;
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
      <label title="How fast the carve follows subject motion. Lower = smoother but slower to catch up; higher = snaps to motion sooner with more flicker.">
        Responsiveness
        <input type="number" id="alpha" min="0.05" max="1" step="0.05" value="${DEFAULT_ALPHA}" />
      </label>
      <label title="Render-time smoothing of the displayed seam mask. Lower = more stable output but small motion lag; higher = no lag but sub-pixel flicker shows through. 1.0 disables smoothing.">
        Smoothing
        <input type="number" id="smooth" min="0.05" max="1" step="0.05" value="${DEFAULT_MASK_SMOOTH_ALPHA}" />
      </label>
      <label title="After carving, display each frame stretched back to the crop dimensions (browser CSS scaling). Output keeps original size with low-energy areas compressed.">
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
  const alphaInput = root.querySelector<HTMLInputElement>('#alpha')!;
  const smoothInput = root.querySelector<HTMLInputElement>('#smooth')!;
  const cropWInput = root.querySelector<HTMLInputElement>('#crop-w')!;
  const cropHInput = root.querySelector<HTMLInputElement>('#crop-h')!;
  const scaleBackInput = root.querySelector<HTMLInputElement>('#scale-back')!;
  const applyBtn = root.querySelector<HTMLButtonElement>('#apply')!;
  const startBtn = root.querySelector<HTMLButtonElement>('#start')!;
  const status = root.querySelector<HTMLDivElement>('#status')!;
  const stage = root.querySelector<HTMLDivElement>('#stage')!;
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
  // The live <video> element mounted in #stage. Tracked so we can remove
  // it on teardown / camera restart.
  let mountedVideo: HTMLVideoElement | null = null;

  function setMode(next: Mode): void {
    mode = next;
    startBtn.textContent = mode === 'live' ? 'Stop camera' : 'Start camera';
    applyBtn.disabled = mode !== 'live';
  }

  // Position the crop overlay using percentages relative to the stage. The
  // stage sizes itself to the video's display rect, so percentages auto-
  // adjust if the camera element gets CSS-scaled to fit the column.
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

  function updateCarvedTarget(): { outW: number; outH: number; alpha: number } {
    const widthPct = clampPct(widthInput.valueAsNumber, DEFAULT_WIDTH_PCT);
    const heightPct = clampPct(heightInput.valueAsNumber, DEFAULT_HEIGHT_PCT);
    const outW = Math.max(1, Math.floor((crop.w * widthPct) / 100));
    const outH = Math.max(1, Math.floor((crop.h * heightPct) / 100));
    const alpha = clampAlpha(alphaInput.valueAsNumber);
    return { outW, outH, alpha };
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

  // CSS-scale the output canvas back to crop size when "scale back" is on.
  // The backing store stays at the carved dims (cheap to redraw); the
  // browser handles the upscale at composite time. Free on opaque camera
  // footage since browser bilinear matches premultiplied bilinear when
  // alpha is uniform.
  function applyOutCanvasDisplay(): void {
    if (!live) return;
    if (scaleBackInput.checked) {
      outCanvas.style.width = `${crop.w}px`;
      outCanvas.style.height = `${crop.h}px`;
      outCanvas.classList.add('scale-back');
    } else {
      outCanvas.style.width = '';
      outCanvas.style.height = '';
      outCanvas.classList.remove('scale-back');
    }
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
    if (!live || !mountedVideo) return;
    e.preventDefault();
    cropOverlay.setPointerCapture(e.pointerId);
    cropOverlay.classList.add('dragging');
    const rect = mountedVideo.getBoundingClientRect();
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

      const { outW, outH, alpha } = updateCarvedTarget();

      const worker = new Worker(
        new URL('./stream/refine.worker.ts', import.meta.url),
        { type: 'module' },
      );

      const ctx: LiveCtx = {
        source,
        worker,
        mask: identityMask(crop.w, crop.h, 0),
        smoothMask: null,
        smoothAlpha: clampAlpha(smoothInput.valueAsNumber),
        carvedFrame: new ImageData(outW, outH),
        renderFrames: 0,
        workerMasks: 0,
        lastRefineMs: 0,
        lastRefineScale: 0,
        lastAlpha: alpha,
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
        live.lastRefineScale = m.refineScale;
        live.lastAlpha = m.alpha;
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
        alpha,
      });

      // Mount the live <video> element where the placeholder canvas used
      // to live. Browser GPU-composites the camera; no main-thread paint.
      mountVideo(source.video);

      outCanvas.width = outW;
      outCanvas.height = outH;
      applyOutCanvasDisplay();

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

    const { outW, outH, alpha } = updateCarvedTarget();

    live.carvedFrame = new ImageData(outW, outH);
    live.mask = identityMask(crop.w, crop.h, live.mask.generation);
    // Geometry changes (crop or width/height %) invalidate any blended
    // history; ensureSmoothMaskMatches re-seeds it from the first new
    // mask in the render loop.
    live.smoothMask = null;
    live.lastAlpha = alpha;

    live.worker.postMessage({
      type: 'init',
      inW: crop.w,
      inH: crop.h,
      outW,
      outH,
      alpha,
    });

    outCanvas.width = outW;
    outCanvas.height = outH;
    applyOutCanvasDisplay();
    updateOrigLabel();
    updateOutLabel();
  });

  scaleBackInput.addEventListener('change', () => {
    if (!live) return;
    applyOutCanvasDisplay();
    updateOutLabel();
  });

  // Smoothing is a render-thread parameter -- no worker re-init needed,
  // so it's live-tunable as the user types/scrubs without clicking Apply.
  smoothInput.addEventListener('input', () => {
    if (!live) return;
    live.smoothAlpha = clampAlpha(smoothInput.valueAsNumber);
  });

  function mountVideo(video: HTMLVideoElement): void {
    if (mountedVideo && mountedVideo.parentElement === stage) {
      stage.removeChild(mountedVideo);
    }
    // Insert the live preview before the crop overlay so the overlay
    // stays on top.
    stage.insertBefore(video, cropOverlay);
    mountedVideo = video;
  }

  function unmountVideo(): void {
    if (mountedVideo && mountedVideo.parentElement === stage) {
      stage.removeChild(mountedVideo);
    }
    mountedVideo = null;
  }

  function startRenderLoop(): void {
    if (!live) return;
    const outCtx = outCanvas.getContext('2d')!;

    const tick = (): void => {
      if (!live || mode !== 'live') return;
      const ctx = live;

      // captureCropped reads back only the crop rectangle (much cheaper
      // than full-frame getImageData + JS crop). Returns a fresh
      // ImageData; safe to transfer below.
      const cropped = ctx.source.captureCropped(crop);

      // Only apply the mask if its input geometry matches the current
      // crop. Mismatch happens transiently right after Apply (worker
      // hasn't posted a fresh mask yet) -- skipping the render in that
      // window keeps stale frames out.
      if (ctx.mask.inW === crop.w && ctx.mask.inH === crop.h) {
        if (
          ctx.carvedFrame.width !== ctx.mask.outW ||
          ctx.carvedFrame.height !== ctx.mask.outH
        ) {
          ctx.carvedFrame = new ImageData(ctx.mask.outW, ctx.mask.outH);
        }
        // EMA-blend the rendered (smoothed) mask toward the latest mask
        // from the worker. The blend runs every render frame, even when
        // the worker hasn't published a fresh mask, so the displayed
        // coords converge smoothly between worker updates. The carve
        // itself is unchanged; only the per-pixel sampling positions
        // for `applyMask` are smoothed.
        ensureSmoothMaskMatches(ctx, ctx.mask);
        blendSmoothMask(ctx.smoothMask!, ctx.mask, ctx.smoothAlpha);
        applyMask(cropped, ctx.smoothMask!, ctx.carvedFrame);

        if (
          outCanvas.width !== ctx.carvedFrame.width ||
          outCanvas.height !== ctx.carvedFrame.height
        ) {
          outCanvas.width = ctx.carvedFrame.width;
          outCanvas.height = ctx.carvedFrame.height;
          applyOutCanvasDisplay();
        }
        outCtx.putImageData(ctx.carvedFrame, 0, 0);
      }

      const now = performance.now();
      if (now - ctx.lastFrameSentAt > FRAME_SEND_INTERVAL_MS) {
        // Transfer the cropped buffer to the worker (zero-copy). The
        // `cropped` ImageData is single-use this RAF -- applyMask
        // already finished above -- so transfer is safe.
        const buf = cropped.data.buffer;
        ctx.worker.postMessage(
          {
            type: 'frame',
            buffer: buf,
            width: cropped.width,
            height: cropped.height,
          },
          [buf],
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
        `alpha:          ${live.lastAlpha.toFixed(2)}`,
        `smoothing:      ${live.smoothAlpha.toFixed(2)}`,
        `refine scale:   ${live.lastRefineScale.toFixed(2)}`,
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
    unmountVideo();
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

function clampAlpha(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ALPHA;
  if (value > 1) return 1;
  if (value < 0.05) return 0.05;
  return value;
}

// (Re)allocate ctx.smoothMask if its geometry doesn't match the latest mask
// from the worker. Seeds the float buffers directly from the latest int
// coords (no smoothing across a geometry change -- there's nothing useful
// to blend with). Cheap: an O(outW * outH) loop on the rare path.
function ensureSmoothMaskMatches(ctx: LiveCtx, latest: SeamMask): void {
  const sm = ctx.smoothMask;
  if (
    sm &&
    sm.outW === latest.outW &&
    sm.outH === latest.outH &&
    sm.inW === latest.inW &&
    sm.inH === latest.inH
  ) {
    return;
  }
  const n = latest.outW * latest.outH;
  const sourceXf = new Float32Array(n);
  const sourceYf = new Float32Array(n);
  const sourceX = new Int16Array(n);
  const sourceY = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    sourceXf[i] = latest.sourceX[i];
    sourceYf[i] = latest.sourceY[i];
    sourceX[i] = latest.sourceX[i];
    sourceY[i] = latest.sourceY[i];
  }
  ctx.smoothMask = {
    inW: latest.inW,
    inH: latest.inH,
    outW: latest.outW,
    outH: latest.outH,
    sourceX,
    sourceY,
    sourceXf,
    sourceYf,
    generation: latest.generation,
  };
}

// In-place EMA blend of the smooth mask's float source coords toward the
// latest worker mask's int coords. Re-derives the int sourceX/sourceY
// (rounded) so applyMask reads the smoothed positions. Runs every render
// frame -- when the worker hasn't published a fresh mask, the latest
// argument is the same one we already converged on, so the blend is a
// near-no-op (target == current after a few frames).
function blendSmoothMask(smooth: SmoothMask, latest: SeamMask, blend: number): void {
  const inv = 1 - blend;
  const { sourceXf, sourceYf, sourceX, sourceY } = smooth;
  const tx = latest.sourceX;
  const ty = latest.sourceY;
  const n = sourceXf.length;
  for (let i = 0; i < n; i += 1) {
    const xf = inv * sourceXf[i] + blend * tx[i];
    const yf = inv * sourceYf[i] + blend * ty[i];
    sourceXf[i] = xf;
    sourceYf[i] = yf;
    sourceX[i] = Math.round(xf);
    sourceY[i] = Math.round(yf);
  }
  smooth.generation = latest.generation;
}
