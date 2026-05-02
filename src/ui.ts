import type { CarveResult } from './pipeline';
import { CarveWorkerClient, formatProgress } from './carve-client';
import { extFor, mimeFor, type ImageFormat } from './image';

const DEFAULT_WIDTH_PCT = 50;
const DEFAULT_HEIGHT_PCT = 50;

type State = {
  inputBuffer: ArrayBuffer | null;
  inputUrl: string | null;
  outputUrl: string | null;
  inputName: string;
};

export function mountUi(root: HTMLElement): void {
  root.innerHTML = `
    <div class="controls">
      <label>
        Choose image
        <input type="file" id="file" accept="image/gif,image/png,image/jpeg" />
      </label>
      <label>
        Width %
        <input type="number" id="width-pct" min="1" max="100" value="${DEFAULT_WIDTH_PCT}" />
      </label>
      <label>
        Height %
        <input type="number" id="height-pct" min="1" max="100" value="${DEFAULT_HEIGHT_PCT}" />
      </label>
      <label title="After carving, bilinear-scale the result back up to the original image dimensions. The output keeps the original size but with low-energy areas compressed -- effectively a content-aware zoom toward the subject.">
        <input type="checkbox" id="scale-back" />
        Scale back to original size
      </label>
      <button id="carve" disabled>Carve</button>
    </div>
    <div class="status" id="status"></div>
    <div class="preview">
      <div>
        <span class="label" id="orig-label">Original</span>
        <img id="orig" alt="Original image" />
      </div>
      <div>
        <div class="label-row">
          <span class="label" id="out-label">Carved</span>
          <a id="download" class="download-btn" hidden download>Download</a>
        </div>
        <img id="out" alt="Carved image" />
      </div>
    </div>
    <pre class="timings" id="timings" hidden></pre>
  `;

  const fileInput = root.querySelector<HTMLInputElement>('#file')!;
  const widthInput = root.querySelector<HTMLInputElement>('#width-pct')!;
  const heightInput = root.querySelector<HTMLInputElement>('#height-pct')!;
  const scaleBackInput = root.querySelector<HTMLInputElement>('#scale-back')!;
  const carveBtn = root.querySelector<HTMLButtonElement>('#carve')!;
  const status = root.querySelector<HTMLDivElement>('#status')!;
  const origImg = root.querySelector<HTMLImageElement>('#orig')!;
  const outImg = root.querySelector<HTMLImageElement>('#out')!;
  const origLabel = root.querySelector<HTMLSpanElement>('#orig-label')!;
  const outLabel = root.querySelector<HTMLSpanElement>('#out-label')!;
  const downloadLink = root.querySelector<HTMLAnchorElement>('#download')!;
  const timingsEl = root.querySelector<HTMLPreElement>('#timings')!;

  const state: State = {
    inputBuffer: null,
    inputUrl: null,
    outputUrl: null,
    inputName: '',
  };

  // Lazily spawned on first carve so we don't pay the worker startup cost
  // for users who only browse the page. Kept alive across carves.
  let carveClient: CarveWorkerClient | null = null;
  function getCarveClient(): CarveWorkerClient {
    if (!carveClient) carveClient = new CarveWorkerClient();
    return carveClient;
  }

  async function loadFile(file: File): Promise<void> {
    if (!isSupportedImage(file)) {
      status.textContent = `error: unsupported file (${file.name || 'unknown'}); expected GIF, PNG, or JPEG`;
      return;
    }

    revokeIfSet(state.inputUrl);
    revokeIfSet(state.outputUrl);

    state.inputBuffer = await file.arrayBuffer();
    state.inputUrl = URL.createObjectURL(file);
    state.outputUrl = null;
    state.inputName = file.name;

    origImg.src = state.inputUrl;
    outImg.removeAttribute('src');
    origLabel.textContent = `Original (${file.name}, ${formatBytes(file.size)})`;
    outLabel.textContent = 'Carved';
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');
    timingsEl.hidden = true;
    status.textContent = '';
    carveBtn.disabled = false;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) await loadFile(file);
  });

  installDropZone(loadFile, status);

  carveBtn.addEventListener('click', async () => {
    if (!state.inputBuffer) return;

    const widthPct = clampPct(widthInput.valueAsNumber, DEFAULT_WIDTH_PCT);
    const heightPct = clampPct(heightInput.valueAsNumber, DEFAULT_HEIGHT_PCT);

    carveBtn.disabled = true;
    status.textContent = 'Carving...';
    timingsEl.hidden = true;

    try {
      const client = getCarveClient();
      const result = await client.carve(
        state.inputBuffer,
        {
          toWidth: Math.max(
            1,
            Math.floor((widthPct * /* original width */ getNaturalWidth(origImg)) / 100),
          ),
          toHeight: Math.max(
            1,
            Math.floor((heightPct * getNaturalHeight(origImg)) / 100),
          ),
          scaleBackToOriginal: scaleBackInput.checked,
        },
        (info) => {
          status.textContent = formatProgress(info);
        },
      );

      revokeIfSet(state.outputUrl);

      const blob = new Blob([result.bytes as BlobPart], { type: mimeFor(result.format) });
      state.outputUrl = URL.createObjectURL(blob);
      outImg.src = state.outputUrl;
      const carvedDims = `${result.carvedSize.w}x${result.carvedSize.h}`;
      const outDims = `${result.outputSize.w}x${result.outputSize.h}`;
      const dimText = result.scaledBack
        ? `${outDims}, carved to ${carvedDims} then scaled back`
        : outDims;
      const fmtTag = result.format.toUpperCase();
      outLabel.textContent = `Carved ${fmtTag} (${dimText}, ${formatBytes(blob.size)})`;
      origLabel.textContent = `Original (${state.inputName}, ${result.inputSize.w}x${result.inputSize.h})`;

      downloadLink.href = state.outputUrl;
      downloadLink.download = makeDownloadName(
        state.inputName,
        result.format,
        result.outputSize.w,
        result.outputSize.h,
        result.scaledBack,
      );
      downloadLink.hidden = false;

      timingsEl.textContent = formatTimings(result);
      timingsEl.hidden = false;
      status.textContent = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = `error: ${msg}`;
      console.error(err);
    } finally {
      carveBtn.disabled = false;
    }
  });
}

function clampPct(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function getNaturalWidth(img: HTMLImageElement): number {
  return img.naturalWidth || 1;
}

function getNaturalHeight(img: HTMLImageElement): number {
  return img.naturalHeight || 1;
}

function revokeIfSet(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimings(result: CarveResult): string {
  const t = result.timings;
  const lines = [
    `frames:        ${result.frameCount}`,
    `input size:    ${result.inputSize.w}x${result.inputSize.h}`,
    `carved size:   ${result.carvedSize.w}x${result.carvedSize.h}`,
    `output size:   ${result.outputSize.w}x${result.outputSize.h}${result.scaledBack ? ' (scaled back)' : ''}`,
    `decode:        ${t.decodeMs.toFixed(1)} ms`,
    `width carve:   ${t.widthCarveMs.toFixed(1)} ms`,
    `height carve:  ${t.heightCarveMs.toFixed(1)} ms`,
    `scale-back:    ${t.scaleMs.toFixed(1)} ms`,
    `encode:        ${t.encodeMs.toFixed(1)} ms`,
    `total:         ${t.totalMs.toFixed(1)} ms`,
  ];
  return lines.join('\n');
}

// Build a "<stem>.carved.WxH[.scaled].<ext>" name from the input filename and
// output format so downloads land with something identifying.
function makeDownloadName(
  inputName: string,
  format: ImageFormat,
  w: number,
  h: number,
  scaledBack: boolean,
): string {
  const ext = extFor(format);
  const trimmed = (inputName || '').trim();
  const stem = stripKnownExtension(trimmed) || 'output';
  const tag = scaledBack ? `${w}x${h}.scaled` : `${w}x${h}`;
  return `${stem}.carved.${tag}.${ext}`;
}

const KNOWN_EXTENSIONS = ['.gif', '.png', '.jpg', '.jpeg'];

function stripKnownExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const e of KNOWN_EXTENSIONS) {
    if (lower.endsWith(e) && name.length > e.length) {
      return name.slice(0, -e.length);
    }
  }
  return name;
}

const SUPPORTED_MIME_TYPES = new Set(['image/gif', 'image/png', 'image/jpeg']);

function isSupportedImage(file: File): boolean {
  if (SUPPORTED_MIME_TYPES.has(file.type)) return true;
  // Some sources (e.g. drags from apps that don't set a MIME type) leave
  // file.type empty; fall back to extension. Decoding failures will still
  // surface as a friendly error if it's a misnamed file.
  const lower = file.name.toLowerCase();
  return KNOWN_EXTENSIONS.some((e) => lower.endsWith(e));
}

function dataTransferHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (const t of Array.from(dt.types)) {
    if (t === 'Files') return true;
  }
  return false;
}

function pickImageFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files)) {
    if (isSupportedImage(f)) return f;
  }
  // Fall back to the first file even if it's not supported, so the caller can
  // produce a useful error message naming the file.
  return dt.files.length > 0 ? dt.files[0] : null;
}

// Wire up window-level drag-and-drop. The whole page acts as a drop zone:
// dropping anywhere triggers loadFile. We use a depth counter because
// dragleave fires when the cursor crosses *into* a child element too;
// counting enter/leave events keeps the overlay state correct as the
// pointer moves over nested elements.
function installDropZone(
  loadFile: (file: File) => Promise<void>,
  status: HTMLElement,
): void {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;

  const showOverlay = (): void => overlay?.classList.add('active');
  const hideOverlay = (): void => overlay?.classList.remove('active');

  window.addEventListener('dragenter', (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth += 1;
    showOverlay();
  });

  window.addEventListener('dragover', (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideOverlay();
  });

  window.addEventListener('drop', async (e) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    hideOverlay();
    const file = pickImageFromDataTransfer(e.dataTransfer);
    if (!file) {
      status.textContent = 'error: drop a GIF, PNG, or JPEG file';
      return;
    }
    await loadFile(file);
  });
}
