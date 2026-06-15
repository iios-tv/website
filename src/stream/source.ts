// Camera capture wrapped to produce ImageData on demand.
//
// Uses OffscreenCanvas backing stores so we can pull pixels without paying
// for DOM compositing. `willReadFrequently: true` hints the 2D context to
// keep its backing store in CPU-readable memory.
//
// Two capture paths:
//   * `captureFrame()` blits the entire video into a full-frame canvas and
//     reads it back. Used when callers need the full camera image (e.g.
//     painting a preview canvas). Cost scales with full-frame area.
//   * `captureCropped(crop)` blits only the crop rectangle into a small
//     canvas sized to the crop, and reads back only crop-size pixels. At
//     640x480 camera + 320x240 crop this is ~4x cheaper than capturing
//     the full frame then cropping in JS.

import type { CropRegion } from './crop';

export type FrameSource = {
  width: number;
  height: number;
  // Underlying <video> element. Exposed so the UI can use it directly as
  // a live preview (browser GPU-composites the camera with zero main-
  // thread work) instead of repainting a canvas every RAF.
  video: HTMLVideoElement;
  // Returns a fresh full-frame ImageData. Caller may keep / transfer it.
  captureFrame: () => ImageData;
  // Returns a fresh ImageData containing just the crop region, sized
  // (crop.w x crop.h). Caller may keep / transfer it.
  captureCropped: (crop: CropRegion) => ImageData;
  stop: () => void;
};

export type CameraOptions = {
  // Hint to the browser. Final dimensions come from videoWidth/videoHeight,
  // which may differ from what we asked for.
  idealWidth?: number;
  idealFrameRate?: number;
};

export async function startCamera(opts: CameraOptions = {}): Promise<FrameSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia is not supported in this browser');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: opts.idealWidth ? { ideal: opts.idealWidth } : undefined,
      frameRate: opts.idealFrameRate ? { ideal: opts.idealFrameRate } : undefined,
    },
  });

  const video = document.createElement('video');
  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('video element failed to load camera stream'));
  });
  await video.play();

  const width = video.videoWidth;
  const height = video.videoHeight;

  const fullCanvas = new OffscreenCanvas(width, height);
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  if (!fullCtx) {
    throw new Error('failed to acquire 2D context for camera capture');
  }

  // Separate canvas for the cropped path -- resized lazily to whatever
  // crop dimensions the caller passes. Most users keep the crop the same
  // for long stretches, so resizing is rare.
  const cropCanvas = new OffscreenCanvas(1, 1);
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!cropCtx) {
    throw new Error('failed to acquire 2D context for cropped camera capture');
  }
  let cropCanvasW = 0;
  let cropCanvasH = 0;

  return {
    width,
    height,
    video,
    captureFrame: () => {
      fullCtx.drawImage(video, 0, 0, width, height);
      return fullCtx.getImageData(0, 0, width, height);
    },
    captureCropped: (crop) => {
      const cw = Math.max(1, Math.floor(crop.w));
      const ch = Math.max(1, Math.floor(crop.h));
      if (cw !== cropCanvasW || ch !== cropCanvasH) {
        cropCanvas.width = cw;
        cropCanvas.height = ch;
        cropCanvasW = cw;
        cropCanvasH = ch;
      }
      cropCtx.drawImage(video, crop.x, crop.y, cw, ch, 0, 0, cw, ch);
      return cropCtx.getImageData(0, 0, cw, ch);
    },
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
