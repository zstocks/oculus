import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export async function readImageMeta(path) {
  const meta = await sharp(path).metadata();
  let exif = {};
  try { exif = (await exifr.parse(path)) || {}; } catch { exif = {}; }

  let { width, height } = meta;
  if (meta.orientation && meta.orientation >= 5) { [width, height] = [height, width]; }

  const taken = exif.DateTimeOriginal || exif.CreateDate || null;
  return {
    format: meta.format || null,
    width: width || null,
    height: height || null,
    taken_at: taken ? new Date(taken).toISOString() : null,
    camera_make: exif.Make || null,
    camera_model: exif.Model || null,
    gps_lat: typeof exif.latitude === 'number' ? exif.latitude : null,
    gps_lon: typeof exif.longitude === 'number' ? exif.longitude : null,
  };
}

export async function makeThumbnail(path, maxPx) {
  return sharp(path)
    .rotate()
    .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

const MIME = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heif: 'image/heic', avif: 'image/avif', tiff: 'image/tiff',
};
export function formatToMime(fmt) {
  return MIME[fmt] || 'application/octet-stream';
}