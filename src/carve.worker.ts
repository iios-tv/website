/// <reference lib="webworker" />

import { carveImage, type ProgressCallback } from './pipeline';
import {
  PROGRESS_INTERVAL_MS,
  type CarveRequest,
  type DoneMessage,
  type ErrorMessage,
  type ProgressMessage,
  type WorkerInMessage,
} from './carve-protocol';

declare const self: DedicatedWorkerGlobalScope;

let busy = false;

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  if (msg.type !== 'carve') return;

  if (busy) {
    postError(msg.jobId, 'worker busy: a carve is already in progress');
    return;
  }

  busy = true;
  void handleCarve(msg).finally(() => {
    busy = false;
  });
};

async function handleCarve(req: CarveRequest): Promise<void> {
  const onProgress = throttledProgress(req.jobId);

  try {
    const result = await carveImage(req.buffer, {
      toWidth: req.toWidth,
      toHeight: req.toHeight,
      scaleBackToOriginal: req.scaleBackToOriginal,
      alphaAware: req.alphaAware,
      jpegQuality: req.jpegQuality,
      onProgress,
    });

    // Transfer the result bytes' backing buffer to avoid a copy. We extract
    // only the active region (byteOffset..byteOffset+byteLength) so the
    // receiver can wrap it as a Uint8Array directly.
    const bytesBuffer = sliceToOwnBuffer(result.bytes);

    const out: DoneMessage = {
      type: 'done',
      jobId: req.jobId,
      bytes: bytesBuffer,
      format: result.format,
      inputSize: result.inputSize,
      carvedSize: result.carvedSize,
      outputSize: result.outputSize,
      frameCount: result.frameCount,
      scaledBack: result.scaledBack,
      timings: result.timings,
    };
    self.postMessage(out, [bytesBuffer]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    postError(req.jobId, message);
  }
}

// Throttle high-frequency progress posts to ~30Hz. Always emit the final tick
// (current === total) for each phase so the UI can show a clean transition.
function throttledProgress(jobId: number): ProgressCallback {
  let lastEmit = 0;
  return (phase, current, total) => {
    const now = performance.now();
    const isFinal = current === total;
    if (!isFinal && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    const msg: ProgressMessage = { type: 'progress', jobId, phase, current, total };
    self.postMessage(msg);
  };
}

function postError(jobId: number, message: string): void {
  const out: ErrorMessage = { type: 'error', jobId, message };
  self.postMessage(out);
}

// `Uint8Array` may be a view over a larger buffer (e.g. when produced by
// gifenc's internal arena). We need a real ArrayBuffer (not SharedArrayBuffer)
// whose entire range belongs to the payload before we can transfer it,
// otherwise the receiver gets the wrong length. If the view already owns its
// buffer exactly, return it as-is; otherwise copy into a fresh buffer.
function sliceToOwnBuffer(arr: Uint8Array): ArrayBuffer {
  const buf = arr.buffer;
  if (
    buf instanceof ArrayBuffer &&
    arr.byteOffset === 0 &&
    arr.byteLength === buf.byteLength
  ) {
    return buf;
  }
  const owned = new Uint8Array(arr.byteLength);
  owned.set(arr);
  return owned.buffer as ArrayBuffer;
}
