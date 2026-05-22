// file type detection utilities

// extension-first and magic-byte detection
export function detectFileType(sampleBuffer, ext) {
  if (ext === '.ipynb') {
    return { category: 'notebook', mime: 'application/x-ipynb+json' };
  }

  const mime = magicMime(sampleBuffer);
  if (mime === 'image/png') return { category: 'image', mime };
  if (mime === 'image/jpeg') return { category: 'image', mime };
  if (mime === 'image/gif') return { category: 'image', mime };
  if (mime === 'image/webp') return { category: 'image', mime };
  if (mime === 'application/pdf') return { category: 'pdf', mime };

  if (isBinary(sampleBuffer)) {
    return { category: 'binary', mime: 'application/octet-stream' };
  }

  return { category: 'text', mime: 'text/plain' };
}

// detect well-known mime from magic bytes
function magicMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF') {
    return 'application/pdf';
  }
  return null;
}

// binary heuristic: NUL bytes or high control-char ratio
function isBinary(buf) {
  if (buf.length === 0) return false;
  let controlCount = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x00) return true;
    // control chars below 9 or in range 14..31 (exclude tab=9, LF=10, CR=13)
    if (b < 9 || (b >= 14 && b <= 31)) controlCount++;
  }
  return controlCount / buf.length > 0.3;
}

// parse image dimensions from a full file buffer
export function imageDimensions(buffer, mime) {
  try {
    if (mime === 'image/png') {
      if (buffer.length < 24) return null;
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      if (buffer.length < 10) return null;
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      return parseJpegDimensions(buffer);
    }
    if (mime === 'image/webp') {
      return parseWebPDimensions(buffer);
    }
  } catch {
    return null;
  }
  return null;
}

// walk JPEG segments looking for SOF marker
function parseJpegDimensions(buf) {
  // skip SOI (2 bytes)
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    const segLen = buf.readUInt16BE(offset + 2);
    // SOF markers: C0..CF except C4, C8, CC
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // 2 (marker) + 2 (len) + 1 (precision) = offset 5 from segment start
      if (offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + segLen;
  }
  return null;
}

// parse WebP VP8X extended form
function parseWebPDimensions(buf) {
  if (buf.length < 30) return null;
  const chunkId = buf.toString('ascii', 12, 16);
  if (chunkId !== 'VP8X') return null;
  const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
  const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
  return { width: w, height: h };
}

// format first n bytes as lowercase hex with spaces
export function hexPreview(buffer, n = 64) {
  const slice = buffer.slice(0, n);
  const parts = [];
  for (let i = 0; i < slice.length; i++) {
    parts.push(slice[i].toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

// human-readable file size
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// guess mime for binary files from magic bytes
export function magicByteType(sampleBuffer) {
  if (sampleBuffer.length >= 4 &&
      sampleBuffer[0] === 0x7f && sampleBuffer[1] === 0x45 &&
      sampleBuffer[2] === 0x4c && sampleBuffer[3] === 0x46) {
    return 'application/x-elf';
  }
  if (sampleBuffer.length >= 4 &&
      sampleBuffer[0] === 0x50 && sampleBuffer[1] === 0x4b &&
      sampleBuffer[2] === 0x03 && sampleBuffer[3] === 0x04) {
    return 'application/zip';
  }
  if (sampleBuffer.length >= 2 &&
      sampleBuffer[0] === 0x1f && sampleBuffer[1] === 0x8b) {
    return 'application/gzip';
  }
  return 'application/octet-stream';
}
