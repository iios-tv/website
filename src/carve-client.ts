import type { CarveOptions, CarveResult, ProgressPhase } from './pipeline';
import type {
  CarveRequest,
  DoneMessage,
  ErrorMessage,
  ProgressMessage,
  WorkerOutMessage,
} from './carve-protocol';

export type ProgressInfo = {
  phase: ProgressPhase;
  current: number;
  total: number;
};

export type CarveProgressCallback = (info: ProgressInfo) => void;

type Pending = {
  resolve: (result: CarveResult) => void;
  reject: (err: Error) => void;
  onProgress?: CarveProgressCallback;
};

// Thin client around the carve worker. Owns one Worker, serializes one carve
// at a time. The UI talks only to this; pipeline-level details (decode, DP,
// encode) stay opaque on the main thread.
export class CarveWorkerClient {
  private worker: Worker;
  private nextJobId = 1;
  private inflight: Map<number, Pending> = new Map();

  constructor() {
    this.worker = new Worker(new URL('./carve.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
      this.handleMessage(e.data);
    };
    this.worker.onerror = (e) => {
      // Worker-level error (e.g. parse error). Reject every in-flight job;
      // the worker is unlikely to be useful afterward.
      const err = new Error(e.message || 'carve worker crashed');
      for (const pending of this.inflight.values()) pending.reject(err);
      this.inflight.clear();
    };
  }

  carve(
    buffer: ArrayBuffer,
    opts: Omit<CarveOptions, 'onProgress'>,
    onProgress?: CarveProgressCallback,
  ): Promise<CarveResult> {
    if (this.inflight.size > 0) {
      return Promise.reject(new Error('carve already in progress'));
    }

    return new Promise((resolve, reject) => {
      const jobId = this.nextJobId++;
      this.inflight.set(jobId, { resolve, reject, onProgress });

      const req: CarveRequest = {
        type: 'carve',
        jobId,
        buffer,
        toWidth: opts.toWidth,
        toHeight: opts.toHeight,
        scaleBackToOriginal: opts.scaleBackToOriginal,
        jpegQuality: opts.jpegQuality,
      };

      // Note: the input buffer is structured-cloned (not transferred) so the
      // caller can re-carve the same image with different parameters. The
      // resulting bytes are transferred back from the worker.
      this.worker.postMessage(req);
    });
  }

  terminate(): void {
    this.worker.terminate();
    const err = new Error('carve worker terminated');
    for (const pending of this.inflight.values()) pending.reject(err);
    this.inflight.clear();
  }

  private handleMessage(msg: WorkerOutMessage): void {
    const pending = this.inflight.get(msg.jobId);
    if (!pending) return;

    switch (msg.type) {
      case 'progress':
        pending.onProgress?.({
          phase: msg.phase,
          current: msg.current,
          total: msg.total,
        });
        return;

      case 'done': {
        this.inflight.delete(msg.jobId);
        pending.resolve(buildResult(msg));
        return;
      }

      case 'error':
        this.inflight.delete(msg.jobId);
        pending.reject(new Error(msg.message));
        return;
    }
  }
}

function buildResult(msg: DoneMessage): CarveResult {
  return {
    bytes: new Uint8Array(msg.bytes),
    format: msg.format,
    inputSize: msg.inputSize,
    carvedSize: msg.carvedSize,
    outputSize: msg.outputSize,
    frameCount: msg.frameCount,
    scaledBack: msg.scaledBack,
    timings: msg.timings,
  };
}

// Format a progress event into a short status string for UI display. Kept
// here so the worker, client, and UI all agree on the phrasing.
export function formatProgress(info: ProgressInfo): string {
  switch (info.phase) {
    case 'decode':
      return 'Decoding image...';
    case 'width':
      return info.total > 0
        ? `Carving width: ${info.current} / ${info.total} px`
        : 'Carving width...';
    case 'height':
      return info.total > 0
        ? `Carving height: ${info.current} / ${info.total} px`
        : 'Carving height...';
    case 'scale':
      return 'Scaling back to original size...';
    case 'encode':
      return 'Encoding output...';
  }
}

export type { ErrorMessage, ProgressMessage, DoneMessage };
