import type { ImageFormat } from './image';
import type { ProgressPhase } from './pipeline';
import type { ImageSize } from './types';

// --- Worker inbound (main -> worker) -----------------------------------------

export type CarveRequest = {
  type: 'carve';
  jobId: number;
  buffer: ArrayBuffer;
  toWidth: number;
  toHeight: number;
  scaleBackToOriginal?: boolean;
  alphaAware?: boolean;
  jpegQuality?: number;
};

export type WorkerInMessage = CarveRequest;

// --- Worker outbound (worker -> main) ----------------------------------------

export type ProgressMessage = {
  type: 'progress';
  jobId: number;
  phase: ProgressPhase;
  current: number;
  total: number;
};

export type DoneMessage = {
  type: 'done';
  jobId: number;
  bytes: ArrayBuffer;
  format: ImageFormat;
  inputSize: ImageSize;
  carvedSize: ImageSize;
  outputSize: ImageSize;
  frameCount: number;
  scaledBack: boolean;
  timings: {
    decodeMs: number;
    widthCarveMs: number;
    heightCarveMs: number;
    scaleMs: number;
    encodeMs: number;
    totalMs: number;
  };
};

export type ErrorMessage = {
  type: 'error';
  jobId: number;
  message: string;
};

export type WorkerOutMessage = ProgressMessage | DoneMessage | ErrorMessage;

// Throttle progress messages to roughly this cadence. Always emit the final
// tick (current === total) regardless of timing so the UI can settle.
export const PROGRESS_INTERVAL_MS = 33;
