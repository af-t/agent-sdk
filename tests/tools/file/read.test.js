import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures');
const TEST_FILE = path.join(FIXTURES, 'read-test.txt');

describe('read.js execute', () => {
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await fs.writeFile(TEST_FILE, Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n'), 'utf8');
  });

  after(async () => {
    await fs.rm(TEST_FILE, { force: true });
  });

  it('reads an existing file and returns numbered lines', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const result = await mod.execute({ path: TEST_FILE });
    assert.ok(result.includes('     1\tLine 1'));
    assert.ok(result.includes('    20\tLine 20'));
  });

  it('throws for a non-existent file within project root', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    await assert.rejects(() => mod.execute({ path: 'tests/fixtures/nonexistent-file-xyz.txt' }), { code: 'ENOENT' });
  });

  it('supports pagination via start_line / end_line', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const result = await mod.execute({ path: TEST_FILE, start_line: 5, end_line: 10 });
    assert.ok(result.includes('     5\tLine 5'));
    assert.ok(result.includes('     9\tLine 9'));
    // line 10 is included since slice = lines[4:10) = lines 5 through 10
    assert.ok(result.includes('    10\tLine 10'));
    // truncated indicator appears because not all lines were read (end_line < total)
    assert.ok(result.includes('[... truncated]'));
  });

  it('respects max_lines limit', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const result = await mod.execute({ path: TEST_FILE, max_lines: 3 });
    const lines = result.split('\n').filter((l) => l.trim() && !l.includes('[... truncated]'));
    assert.ok(lines.length <= 3);
  });

  it('shows truncated indicator when not reading entire file', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    // 20 lines total, but reading start_line=1,end_line=5 means only first 5 lines
    const result = await mod.execute({ path: TEST_FILE, start_line: 1, end_line: 5 });
    assert.ok(result.includes('[... truncated]'));
  });

  it('reads a file outside project root when in agent trustedPaths', async () => {
    const fsP = await import('node:fs/promises');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const tmpDir = await fsP.mkdtemp(pathMod.join(os.tmpdir(), 'read-tool-test-'));
    const file = pathMod.join(tmpDir, 'external.txt');
    await fsP.writeFile(file, 'external file content');

    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: file }, ctx);

    assert.ok(result.includes('external file content'));
    await fsP.rm(tmpDir, { recursive: true });
  });

  it('rejects file outside project root with empty trustedPaths', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    await assert.rejects(() => mod.execute({ path: '/etc/hostname' }, { agent: { trustedPaths: new Set() } }), {
      message: /outside project root/,
    });
  });
});

describe('read.js — CRLF line endings', () => {
  let mod;
  let crlfFile;

  before(async () => {
    mod = await import('../../../src/tools/file/read.js');
    await fs.mkdir(FIXTURES, { recursive: true });
    crlfFile = path.join(FIXTURES, 'read-crlf.txt');
    await fs.writeFile(crlfFile, 'Line one\r\nLine two\r\nLine three\r\n', 'utf8');
  });

  after(() => fs.rm(crlfFile, { force: true }));

  it('strips trailing CR so lines do not end with \\r', async () => {
    const result = await mod.execute({ path: crlfFile });
    const lines = result.split('\n');
    for (const line of lines) {
      assert.ok(!line.endsWith('\r'), `line ends with \\r: ${JSON.stringify(line)}`);
    }
  });

  it('displays correct line content without carriage return', async () => {
    const result = await mod.execute({ path: crlfFile });
    assert.ok(result.includes('     1\tLine one'));
    assert.ok(result.includes('     2\tLine two'));
    assert.ok(result.includes('     3\tLine three'));
  });
});

describe('read.js — notebook branch', () => {
  const NOTEBOOK_FILE = path.join(FIXTURES, 'test-notebook.ipynb');

  before(async () => {
    const nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { language: 'python' } },
      cells: [
        { cell_type: 'code', source: 'print("hello")', outputs: [], execution_count: null },
        { cell_type: 'markdown', source: '# Section', outputs: [] },
      ],
    };
    await fs.mkdir(FIXTURES, { recursive: true });
    await fs.writeFile(NOTEBOOK_FILE, JSON.stringify(nb), 'utf8');
  });

  after(async () => {
    await fs.rm(NOTEBOOK_FILE, { force: true });
  });

  it('reads a .ipynb file and returns notebook content', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const result = await mod.execute({ path: NOTEBOOK_FILE });
    assert.ok(typeof result === 'string', 'result should be a string');
    assert.ok(result.includes('[notebook]'), 'result should contain [notebook]');
    assert.ok(result.includes('# Cell 1'), 'result should contain # Cell 1');
  });
});

describe('read.js — image branch', () => {
  let tmpDir;
  let pngFile;
  let oversizedPngFile;

  before(async () => {
    const os = await import('node:os');
    tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'read-image-test-'));

    // minimal valid PNG: signature(8) + IHDR chunk(4 len + 4 type + 13 data + 4 crc = 25)
    // width=64 at bytes 16-19, height=32 at bytes 20-23
    const png = Buffer.alloc(8 + 4 + 4 + 13 + 4);
    // PNG signature
    png[0] = 0x89;
    png[1] = 0x50;
    png[2] = 0x4e;
    png[3] = 0x47;
    png[4] = 0x0d;
    png[5] = 0x0a;
    png[6] = 0x1a;
    png[7] = 0x0a;
    // IHDR chunk length = 13
    png.writeUInt32BE(13, 8);
    // chunk type = IHDR
    png.write('IHDR', 12, 'ascii');
    // width = 64
    png.writeUInt32BE(64, 16);
    // height = 32
    png.writeUInt32BE(32, 20);

    pngFile = path.join(tmpDir, 'test.png');
    await fs.writeFile(pngFile, png);

    // oversized PNG: just over 5MB starting with PNG signature
    const large = Buffer.alloc(5 * 1024 * 1024 + 1);
    large[0] = 0x89;
    large[1] = 0x50;
    large[2] = 0x4e;
    large[3] = 0x47;
    large[4] = 0x0d;
    large[5] = 0x0a;
    large[6] = 0x1a;
    large[7] = 0x0a;
    oversizedPngFile = path.join(tmpDir, 'large.png');
    await fs.writeFile(oversizedPngFile, large);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an array with text and image_url for a small PNG', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: pngFile }, ctx);
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.equal(result[0].type, 'text');
    assert.equal(result[1].type, 'image_url');
    assert.ok(result[1].image_url.url.startsWith('data:image/png;base64,'), 'url should be a PNG data URI');
  });

  it('returns a string for an oversized PNG', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: oversizedPngFile }, ctx);
    assert.ok(typeof result === 'string', 'result should be a string');
    assert.ok(result.includes('too large to inline'), 'result should mention too large to inline');
  });
});

describe('read.js — pdf branch', () => {
  let tmpDir;
  let pdfFile;

  before(async () => {
    const os = await import('node:os');
    tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'read-pdf-test-'));

    // minimal PDF starting with %PDF-1.4
    const pdfContent = Buffer.from('%PDF-1.4\n%%EOF\n', 'ascii');
    pdfFile = path.join(tmpDir, 'test.pdf');
    await fs.writeFile(pdfFile, pdfContent);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an array with text and file for a small PDF', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: pdfFile }, ctx);
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.equal(result[0].type, 'text');
    assert.equal(result[1].type, 'file');
    assert.ok(
      result[1].file.file_data.startsWith('data:application/pdf;base64,'),
      'file_data should be a PDF data URI',
    );
  });
});

describe('read.js — binary branch', () => {
  let tmpDir;
  let binaryFile;

  before(async () => {
    const os = await import('node:os');
    tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'read-binary-test-'));

    // NUL bytes guarantee binary detection
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe, 0xfd, 0x03]);
    binaryFile = path.join(tmpDir, 'test.bin');
    await fs.writeFile(binaryFile, buf);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a string starting with [binary] and containing hex', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: binaryFile }, ctx);
    assert.ok(typeof result === 'string', 'result should be a string');
    assert.ok(result.startsWith('[binary]'), 'result should start with [binary]');
    assert.ok(result.includes('hex'), 'result should contain hex');
  });
});

describe('read.js — fileState caching', () => {
  let mod;
  let tmpDir;
  let tmpFile;

  before(async () => {
    mod = await import('../../../src/tools/file/read.js');
    const fsP = await import('node:fs/promises');
    const os = await import('node:os');
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'read-state-test-'));
    tmpFile = path.join(tmpDir, 'file.txt');
    await fsP.writeFile(tmpFile, Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n'), 'utf8');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx({ turn = 3 } = {}) {
    return { agent: { fileState: new Map(), currentTurn: turn, trustedPaths: new Set([tmpDir]) } };
  }

  it('first read populates fileState and returns numbered content', async () => {
    const ctx = makeCtx();
    const result = await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    assert.ok(result.includes('     1\tLine 1'));
    assert.ok(result.includes('     5\tLine 5'));
    assert.equal(ctx.agent.fileState.size, 1);
    const entry = [...ctx.agent.fileState.values()][0];
    assert.match(entry.hash, /^[0-9a-f]{64}$/);
    assert.equal(entry.lastReadTurn, 3);
    assert.deepEqual(entry.rangesRead, [[1, 5]]);
    assert.equal(entry.totalLines, 20);
  });

  it('repeat read of the same range returns a cache-hit short message', async () => {
    const ctx = makeCtx({ turn: 5 });
    await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    const result = await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    assert.ok(result.startsWith('[CACHED]'));
    assert.ok(result.includes('turn 5'));
    assert.ok(result.includes('Lines 1-5'));
    assert.ok(result.includes('Total: 20'));
  });

  it('disjoint subsequent read returns content and merges rangesRead', async () => {
    const ctx = makeCtx();
    await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    const result = await mod.execute({ path: tmpFile, start_line: 10, end_line: 12 }, ctx);
    assert.ok(!result.startsWith('[CACHED]'));
    assert.ok(result.includes('    10\tLine 10'));
    const entry = [...ctx.agent.fileState.values()][0];
    assert.deepEqual(entry.rangesRead, [
      [1, 5],
      [10, 12],
    ]);
  });

  it('external file modification invalidates cache and replaces ranges', async () => {
    const ctx = makeCtx();
    await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    const entryBefore = [...ctx.agent.fileState.values()][0];
    const firstHash = entryBefore.hash;

    await fs.writeFile(tmpFile, Array.from({ length: 25 }, (_, i) => `New ${i + 1}`).join('\n'), 'utf8');

    const result = await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    assert.ok(!result.startsWith('[CACHED]'));
    assert.ok(result.includes('     1\tNew 1'));
    const entryAfter = [...ctx.agent.fileState.values()][0];
    assert.notEqual(entryAfter.hash, firstHash);
    assert.deepEqual(entryAfter.rangesRead, [[1, 5]]);
    assert.equal(entryAfter.totalLines, 25);
  });

  it('implements exact-offset caching logic where identical offsets trigger cache and changed offsets or file updates do not', async () => {
    const ctx = makeCtx({ turn: 1 });

    // Ensure clean initial content
    const originalContent = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');
    await fs.writeFile(tmpFile, originalContent, 'utf8');

    // 1. First read of the file should return the content normally
    const res1 = await mod.execute({ path: tmpFile, start_line: 1, end_line: 10 }, ctx);
    assert.ok(!res1.startsWith('[CACHED]'), 'initial read should return content normally');
    assert.ok(res1.includes('     1\tLine 1'));

    // 2. Reading with a different offset returns content normally (even if it overlaps with a prior read)
    const res2 = await mod.execute({ path: tmpFile, start_line: 2, end_line: 5 }, ctx);
    assert.ok(!res2.startsWith('[CACHED]'), 'read with a different offset should return content normally');
    assert.ok(res2.includes('     2\tLine 2'));

    // 3. Repeating the read with the exact same offset triggers the cache
    const res3 = await mod.execute({ path: tmpFile, start_line: 2, end_line: 5 }, ctx);
    assert.ok(res3.startsWith('[CACHED]'), 'repeating the read with the identical offset should hit the cache');

    // 4. Repeating the initial read (lines 1-10) also hits the cache
    const res4 = await mod.execute({ path: tmpFile, start_line: 1, end_line: 10 }, ctx);
    assert.ok(res4.startsWith('[CACHED]'), 'repeating the initial offset read should hit the cache');

    // 5. Reading after editing the file returns content normally
    try {
      await fs.writeFile(tmpFile, originalContent + '\nEdited line', 'utf8');

      const res5 = await mod.execute({ path: tmpFile, start_line: 2, end_line: 5 }, ctx);
      assert.ok(!res5.startsWith('[CACHED]'), 'read after editing the file should return content normally');
      assert.ok(res5.includes('     2\tLine 2'));
    } finally {
      // restore file
      await fs.writeFile(tmpFile, originalContent, 'utf8');
    }
  });

  it('works without ctx.agent (legacy callers)', async () => {
    const legacyFile = path.join(FIXTURES, 'read-state-legacy.txt');
    await fs.writeFile(legacyFile, 'a\nb\nc\n', 'utf8');
    try {
      const result = await mod.execute({ path: legacyFile });
      assert.ok(result.includes('     1\ta'));
      assert.ok(result.includes('     3\tc'));
    } finally {
      await fs.rm(legacyFile, { force: true });
    }
  });
});

describe('read.js — video and audio branch', () => {
  let tmpDir;
  let mp4File;
  let oversizedMp4File;
  let mp3File;

  before(async () => {
    const os = await import('node:os');
    tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'read-media-test-'));

    // MP4 signature at offset 4: "ftyp"
    const mp4Bytes = Buffer.alloc(16);
    mp4Bytes.write('ftyp', 4, 'ascii');
    mp4File = path.join(tmpDir, 'test.mp4');
    await fs.writeFile(mp4File, mp4Bytes);

    // Oversized MP4
    const largeMp4 = Buffer.alloc(25 * 1024 * 1024 + 1);
    largeMp4.write('ftyp', 4, 'ascii');
    oversizedMp4File = path.join(tmpDir, 'large.mp4');
    await fs.writeFile(oversizedMp4File, largeMp4);

    // MP3 ID3 signature: "ID3"
    const mp3Bytes = Buffer.alloc(8);
    mp3Bytes.write('ID3', 0, 'ascii');
    mp3File = path.join(tmpDir, 'test.mp3');
    await fs.writeFile(mp3File, mp3Bytes);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an array with text and video_url for a small MP4 video', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: mp4File }, ctx);
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.equal(result[0].type, 'text');
    assert.ok(result[0].text.includes('video/mp4'));
    assert.equal(result[1].type, 'video_url');
    assert.ok(result[1].video_url.url.startsWith('data:video/mp4;base64,'), 'url should be an MP4 data URI');
  });

  it('returns a string for an oversized MP4', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: oversizedMp4File }, ctx);
    assert.ok(typeof result === 'string', 'result should be a string');
    assert.ok(result.includes('too large to inline'), 'result should mention too large to inline');
  });

  it('returns an array with text and input_audio for a small MP3 audio', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: mp3File }, ctx);
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.equal(result[0].type, 'text');
    assert.ok(result[0].text.includes('audio/mpeg'));
    assert.equal(result[1].type, 'input_audio');
    assert.ok(typeof result[1].input_audio.data === 'string', 'data should be a base64 string');
    assert.strictEqual(result[1].input_audio.format, 'mp3');
  });

  it('returns a string for an oversized audio file', async () => {
    const oversizedMp3File = path.join(tmpDir, 'large.mp3');
    await fs.writeFile(oversizedMp3File, Buffer.alloc(8));
    await fs.truncate(oversizedMp3File, 25 * 1024 * 1024 + 1);
    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: oversizedMp3File }, ctx);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('too large to inline'));
  });
});

describe('read.js — oversized text file', () => {
  it('throws when text file exceeds 10MB', async () => {
    const os = await import('node:os');
    const tmpDir = await fs.mkdtemp(path.join(os.default.tmpdir(), 'read-oversize-'));
    const bigFile = path.join(tmpDir, 'big.txt');
    try {
      await fs.writeFile(bigFile, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)); // 10MB+1 of 'a'
      const mod = await import('../../../src/tools/file/read.js');
      const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
      await assert.rejects(() => mod.execute({ path: bigFile }, ctx), /too large/i);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
