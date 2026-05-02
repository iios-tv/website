// Camera capture wrapped to produce ImageData on demand.
//
// Uses an OffscreenCanvas as a hidden render target so we can pull pixels
// without paying for DOM compositing. `willReadFrequently: true` hints the
// 2D context to keep its backing store in CPU-readable memory.

export type FrameSource = {
  width: number;
  height: number;
  // Every call returns a fresh ImageData -- callers may keep it / transfer
  // its buffer freely without affecting subsequent captures.
  captureFrame: () => ImageData;
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

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('failed to acquire 2D context for camera capture');
  }

  return {
    width,
    height,
    captureFrame: () => {
      ctx.drawImage(video, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    },
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
