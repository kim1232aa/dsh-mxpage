import path from "path";

export function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function extFromMime(mimeType?: string | null) {
  if (!mimeType) {
    return "bin";
  }

  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("svg")) return "svg";
  return "bin";
}

/** Sniff the real image mime from magic bytes; null when unrecognized. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[8] === 0x57) return "image/webp"; // RIFF....WEBP
  if (bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif"; // GIF
  return null;
}

export function relativeStorageUrl(filePath: string) {
  const normalized = filePath.split(path.sep).join("/");
  return `/api/files/${normalized}`;
}
