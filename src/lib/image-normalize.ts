// Normalize an operator-uploaded image into a format Square's catalog image API accepts.
//
// Square only accepts JPEG/PNG/GIF. Phones (iPhones especially) shoot HEIC/HEIF by default, so a
// studio uploading their own product shots would otherwise be rejected. We detect HEIC — by
// content-type OR by sniffing the ISO-BMFF `ftyp` brand (browsers sometimes send an empty type for
// HEIC) — and convert it to JPEG before attaching. Everything else passes through untouched and is
// still validated by isAllowedImageType downstream. The converter is injectable for tests.

import convert from 'heic-convert';

// ISO base media file format brands used by HEIC/HEIF containers.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs']);

export function isHeic(bytes: Buffer, contentType: string): boolean {
  if (/image\/(heic|heif)/i.test(contentType)) return true;
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    return HEIC_BRANDS.has(bytes.toString('latin1', 8, 12).toLowerCase());
  }
  return false;
}

export interface NormalizedImage {
  bytes: Buffer;
  contentType: string;
  converted: boolean;
}

type HeicConverter = (buffer: Buffer) => Promise<ArrayBuffer | Buffer>;

export async function normalizeUploadedImage(
  bytes: Buffer,
  contentType: string,
  opts: { convertHeic?: HeicConverter } = {},
): Promise<NormalizedImage> {
  if (isHeic(bytes, contentType)) {
    const doConvert: HeicConverter = opts.convertHeic ?? ((buffer) => convert({ buffer, format: 'JPEG', quality: 0.9 }));
    const out = await doConvert(bytes);
    return { bytes: Buffer.from(out as ArrayBuffer), contentType: 'image/jpeg', converted: true };
  }
  return { bytes, contentType, converted: false };
}
