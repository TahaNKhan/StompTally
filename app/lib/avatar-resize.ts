/** Side length of the square the browser produces. Small enough to stay far below the server cap. */
export const AVATAR_SIZE = 256;
const JPEG_QUALITY = 0.85;

type Crop = { sx: number; sy: number; side: number };

/** The largest centered square in a width x height image. */
export function centerSquare(width: number, height: number): Crop {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/**
 * Center-crops to a square and re-encodes as JPEG in the browser. Re-encoding also drops EXIF
 * (location, camera) and turns any input format into one the server accepts.
 */
export async function resizeToAvatar(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => {
    throw new Error("That file isn't a photo this browser can read.");
  });
  try {
    const { sx, sy, side } = centerSquare(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser can't resize photos.");
    context.fillStyle = "#ffffff"; // JPEG has no transparency: flatten PNGs onto white
    context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't prepare that photo."))), "image/jpeg", JPEG_QUALITY),
    );
  } finally {
    bitmap.close();
  }
}
