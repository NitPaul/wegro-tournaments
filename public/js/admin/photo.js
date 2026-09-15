/**
 * Turning a photo from a phone or a camera into a player picture — in the
 * browser, before anything is uploaded.
 *
 * The WeGro headshots are 1.2–2.2 MB PNGs. Shipping those to forty phones on a
 * player grid would be slow, and the server's proxy refuses bodies over 1 MB by
 * default. So every picture is cropped to a square here and re-encoded at 512px,
 * which comes out around 30–60 KB, and the server never needs an image library.
 */

export const OUTPUT_SIZE = 512;

/** Read a file into something drawable, honouring the camera's orientation flag. */
export async function loadImage(file) {
  if (!file?.type?.startsWith("image/")) throw new Error(`${file?.name ?? "That file"} is not an image.`);
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name} could not be read as an image.`);
  }
}

/**
 * The starting crop: the largest square, centred left to right and sitting a
 * little high — these are head-and-shoulders shots, so the face is in the top
 * half and a dead-centre crop would cut the top of the head on a tall photo.
 */
export function defaultCrop(width, height) {
  const side = Math.min(width, height);
  return {
    side,
    x: (width - side) / 2,
    y: (height - side) * 0.15,
  };
}

/** Keep a crop inside the picture. */
export function clampCrop(crop, width, height) {
  const side = Math.min(Math.max(crop.side, 32), Math.min(width, height));
  return {
    side,
    x: Math.min(Math.max(crop.x, 0), width - side),
    y: Math.min(Math.max(crop.y, 0), height - side),
  };
}

/** Draw the cropped square onto a canvas of the given size. */
export function drawCrop(canvas, bitmap, crop, size = canvas.width) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(bitmap, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size);
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Encode the crop for upload. WebP where the browser can write it; JPEG where it
 * cannot (older Safari hands back a PNG when asked for WebP, which would be ten
 * times the size).
 */
export async function encodeCrop(bitmap, crop) {
  const canvas = document.createElement("canvas");
  drawCrop(canvas, bitmap, crop, OUTPUT_SIZE);
  const webp = await toBlob(canvas, "image/webp", 0.86);
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await toBlob(canvas, "image/jpeg", 0.88);
  if (!jpeg) throw new Error("This browser could not prepare the photo.");
  return jpeg;
}

/**
 * A small crop editor: drag to move, slider to zoom.
 *
 * @param {HTMLElement} host   where to draw it
 * @param {ImageBitmap} bitmap the picture
 * @returns {{ crop: () => object, destroy: () => void }}
 */
export function cropEditor(host, bitmap) {
  const { width, height } = bitmap;
  const base = defaultCrop(width, height);
  let crop = { ...base };

  host.innerHTML = `
    <div class="crop">
      <canvas class="crop__canvas" width="280" height="280" aria-label="Drag to move the photo"></canvas>
      <label class="crop__zoom">
        <span>Zoom</span>
        <input type="range" min="1" max="3" step="0.01" value="1" />
      </label>
      <p class="faint crop__hint">Drag the picture to centre the face.</p>
    </div>`;
  const canvas = host.querySelector("canvas");
  const zoom = host.querySelector("input[type=range]");

  const paint = () => drawCrop(canvas, bitmap, crop, 280);
  paint();

  zoom.addEventListener("input", () => {
    const centreX = crop.x + crop.side / 2;
    const centreY = crop.y + crop.side / 2;
    const side = base.side / Number(zoom.value);
    crop = clampCrop({ side, x: centreX - side / 2, y: centreY - side / 2 }, width, height);
    paint();
  });

  let drag = null;
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    drag = { x: ev.clientX, y: ev.clientY, start: { ...crop } };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    // Screen pixels to picture pixels: the canvas shows `side` picture pixels
    // across its on-screen width.
    const scale = crop.side / canvas.getBoundingClientRect().width;
    crop = clampCrop(
      { side: crop.side, x: drag.start.x - (ev.clientX - drag.x) * scale, y: drag.start.y - (ev.clientY - drag.y) * scale },
      width,
      height,
    );
    paint();
  });
  const end = () => (drag = null);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  return {
    crop: () => ({ ...crop }),
    destroy: () => {
      host.innerHTML = "";
    },
  };
}
