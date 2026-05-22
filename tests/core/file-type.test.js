import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFileType,
  imageDimensions,
  hexPreview,
  humanSize,
  magicByteType,
} from '../../src/core/file-type.js';

// helpers to build minimal image buffers
function makePng(width, height) {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeGif(width, height, version = '89a') {
  const buf = Buffer.alloc(10);
  buf.write('GIF' + version, 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function makeJpeg(width, height) {
  // SOI + APP0 + SOF0 segment
  const sof = Buffer.alloc(19);
  // SOI
  sof[0] = 0xff;
  sof[1] = 0xd8;
  // APP0 marker + length (will be skipped)
  sof[2] = 0xff;
  sof[3] = 0xe0;
  sof.writeUInt16BE(2, 4); // length 2 means 0 data bytes after length
  // SOF0 marker
  sof[6] = 0xff;
  sof[7] = 0xc0;
  sof.writeUInt16BE(11, 8); // length
  sof[10] = 8; // precision
  sof.writeUInt16BE(height, 11);
  sof.writeUInt16BE(width, 13);
  return sof;
}

function makeWebPExtended(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  // canvas width/height stored at offsets 24 and 27 as uint24 LE (value - 1)
  buf[24] = (width - 1) & 0xff;
  buf[25] = ((width - 1) >> 8) & 0xff;
  buf[26] = ((width - 1) >> 16) & 0xff;
  buf[27] = (height - 1) & 0xff;
  buf[28] = ((height - 1) >> 8) & 0xff;
  buf[29] = ((height - 1) >> 16) & 0xff;
  return buf;
}

describe('detectFileType', () => {
  it('detects .ipynb by extension', () => {
    const result = detectFileType(Buffer.from('{}'), '.ipynb');
    assert.deepEqual(result, { category: 'notebook', mime: 'application/x-ipynb+json' });
  });

  it('detects PNG by magic bytes', () => {
    const buf = makePng(100, 100);
    const result = detectFileType(buf, '.png');
    assert.deepEqual(result, { category: 'image', mime: 'image/png' });
  });

  it('detects JPEG by magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const result = detectFileType(buf, '.jpg');
    assert.deepEqual(result, { category: 'image', mime: 'image/jpeg' });
  });

  it('detects GIF87a', () => {
    const buf = Buffer.from('GIF87a\x00\x00\x00\x00', 'ascii');
    const result = detectFileType(buf, '.gif');
    assert.deepEqual(result, { category: 'image', mime: 'image/gif' });
  });

  it('detects GIF89a', () => {
    const buf = Buffer.from('GIF89a\x00\x00\x00\x00', 'ascii');
    const result = detectFileType(buf, '');
    assert.deepEqual(result, { category: 'image', mime: 'image/gif' });
  });

  it('detects WebP', () => {
    const buf = makeWebPExtended(100, 100);
    const result = detectFileType(buf, '.webp');
    assert.deepEqual(result, { category: 'image', mime: 'image/webp' });
  });

  it('detects PDF by magic bytes', () => {
    const buf = Buffer.from('%PDF-1.4 ...');
    const result = detectFileType(buf, '.pdf');
    assert.deepEqual(result, { category: 'pdf', mime: 'application/pdf' });
  });

  it('detects binary via NUL byte', () => {
    const buf = Buffer.from([0x41, 0x00, 0x42]);
    const result = detectFileType(buf, '');
    assert.deepEqual(result, { category: 'binary', mime: 'application/octet-stream' });
  });

  it('detects binary via high control-char ratio', () => {
    // all bytes are control chars (0x01-0x08), ratio = 1.0 > 0.30
    const buf = Buffer.alloc(20, 0x01);
    const result = detectFileType(buf, '');
    assert.deepEqual(result, { category: 'binary', mime: 'application/octet-stream' });
  });

  it('treats empty buffer as text', () => {
    const result = detectFileType(Buffer.alloc(0), '');
    assert.deepEqual(result, { category: 'text', mime: 'text/plain' });
  });

  it('detects plain text', () => {
    const buf = Buffer.from('hello world\nthis is text\n');
    const result = detectFileType(buf, '.txt');
    assert.deepEqual(result, { category: 'text', mime: 'text/plain' });
  });
});

describe('imageDimensions', () => {
  it('returns PNG dimensions', () => {
    const buf = makePng(320, 240);
    assert.deepEqual(imageDimensions(buf, 'image/png'), { width: 320, height: 240 });
  });

  it('returns GIF dimensions (GIF87a)', () => {
    const buf = makeGif(640, 480, '87a');
    assert.deepEqual(imageDimensions(buf, 'image/gif'), { width: 640, height: 480 });
  });

  it('returns GIF dimensions (GIF89a)', () => {
    const buf = makeGif(100, 200, '89a');
    assert.deepEqual(imageDimensions(buf, 'image/gif'), { width: 100, height: 200 });
  });

  it('returns JPEG dimensions', () => {
    const buf = makeJpeg(800, 600);
    assert.deepEqual(imageDimensions(buf, 'image/jpeg'), { width: 800, height: 600 });
  });

  it('returns WebP extended dimensions', () => {
    const buf = makeWebPExtended(1920, 1080);
    assert.deepEqual(imageDimensions(buf, 'image/webp'), { width: 1920, height: 1080 });
  });

  it('returns null for unknown mime', () => {
    const buf = Buffer.from('hello');
    assert.strictEqual(imageDimensions(buf, 'text/plain'), null);
  });

  it('returns null on truncated PNG buffer', () => {
    const buf = Buffer.alloc(10);
    buf[0] = 0x89;
    buf[1] = 0x50;
    // buffer too short to hold dimensions
    assert.strictEqual(imageDimensions(buf, 'image/png'), null);
  });
});

describe('hexPreview', () => {
  it('formats bytes as lowercase two-digit hex with spaces', () => {
    const buf = Buffer.from([0x00, 0x0f, 0xff, 0xab]);
    assert.strictEqual(hexPreview(buf, 4), '00 0f ff ab');
  });

  it('limits to n bytes', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    assert.strictEqual(hexPreview(buf, 3), '01 02 03');
  });

  it('defaults to 64 bytes', () => {
    const buf = Buffer.alloc(100, 0xaa);
    const result = hexPreview(buf);
    const parts = result.split(' ');
    assert.strictEqual(parts.length, 64);
    assert.ok(parts.every((p) => p === 'aa'));
  });

  it('handles buffer shorter than n', () => {
    const buf = Buffer.from([0x01, 0x02]);
    assert.strictEqual(hexPreview(buf, 10), '01 02');
  });
});

describe('humanSize', () => {
  it('formats bytes under 1024', () => {
    assert.strictEqual(humanSize(0), '0 B');
    assert.strictEqual(humanSize(512), '512 B');
    assert.strictEqual(humanSize(1023), '1023 B');
  });

  it('formats kilobytes', () => {
    assert.strictEqual(humanSize(1024), '1.0 KB');
    assert.strictEqual(humanSize(1536), '1.5 KB');
    assert.strictEqual(humanSize(1024 * 1023), '1023.0 KB');
  });

  it('formats megabytes', () => {
    assert.strictEqual(humanSize(1024 * 1024), '1.0 MB');
    assert.strictEqual(humanSize(1024 * 1024 * 2.5), '2.5 MB');
  });
});

describe('magicByteType', () => {
  it('detects ELF binary', () => {
    const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]);
    assert.strictEqual(magicByteType(buf), 'application/x-elf');
  });

  it('detects ZIP archive', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    assert.strictEqual(magicByteType(buf), 'application/zip');
  });

  it('detects gzip', () => {
    const buf = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    assert.strictEqual(magicByteType(buf), 'application/gzip');
  });

  it('falls back to octet-stream for unknown binary', () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    assert.strictEqual(magicByteType(buf), 'application/octet-stream');
  });
});
