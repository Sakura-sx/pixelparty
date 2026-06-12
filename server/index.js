import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { brotliCompressSync, constants as zlib, deflateSync, inflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, saveSnapshot, storeEnabled } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 512;
const PIXEL_COUNT = CANVAS_WIDTH * CANVAS_HEIGHT;

// Wire format for the binary `px` event (both directions): 6 bytes per pixel,
// a 24-bit big-endian index (y * width + x) followed by R, G, B.
const PX_RECORD = 6;
const MAX_PIXELS_PER_CHUNK = 16384;

const BROADCAST_MS = 50; // tier 1 -> tier 2: coalesced pixel broadcast cadence
const PERSIST_MS = 200; // tier 1 -> tier 0: blob persistence cadence

// Tier 1: flat RGB buffer, row-major: index = (y * CANVAS_WIDTH + x) * 3
const canvas = Buffer.alloc(PIXEL_COUNT * 3);

// Cached compressed snapshots, invalidated whenever a pixel changes.
// Deflate feeds the legacy socket snapshot and tier-0 writes; brotli feeds
// the /snapshot HTTP endpoint where browsers decompress it natively.
let deflatedSnapshot = null;
let brotliSnapshot = null;
function getDeflatedSnapshot() {
  if (!deflatedSnapshot) deflatedSnapshot = deflateSync(canvas, { level: 9 });
  return deflatedSnapshot;
}
function getBrotliSnapshot() {
  if (!brotliSnapshot) {
    brotliSnapshot = brotliCompressSync(canvas, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: 5,
        [zlib.BROTLI_PARAM_SIZE_HINT]: canvas.length
      }
    });
  }
  return brotliSnapshot;
}

// Pixels written since the last broadcast tick: index -> packed 0xRRGGBB
const pendingBroadcast = new Map();
let storeDirty = false;

function writePixel(index, r, g, b) {
  const i = index * 3;
  canvas[i] = r;
  canvas[i + 1] = g;
  canvas[i + 2] = b;
  deflatedSnapshot = null;
  brotliSnapshot = null;
  pendingBroadcast.set(index, (r << 16) | (g << 8) | b);
  storeDirty = true;
}

// Applies a binary px chunk; returns an error code or null. The chunk is
// validated in full before any pixel is written so bad input is rejected
// atomically.
function applyChunk(data) {
  let buf;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else return 'not_binary';

  if (buf.length === 0 || buf.length % PX_RECORD !== 0) return 'bad_length';
  if (buf.length / PX_RECORD > MAX_PIXELS_PER_CHUNK) return 'too_many_pixels';
  for (let off = 0; off < buf.length; off += PX_RECORD) {
    if (buf.readUIntBE(off, 3) >= PIXEL_COUNT) return 'out_of_bounds';
  }
  for (let off = 0; off < buf.length; off += PX_RECORD) {
    writePixel(buf.readUIntBE(off, 3), buf[off + 3], buf[off + 4], buf[off + 5]);
  }
  return null;
}

function isValidColor(color) {
  return (
    Array.isArray(color) &&
    color.length === 3 &&
    color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
  );
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, clients: io.engine.clientsCount });
});

// Full canvas refresh. The body is the raw RGB framebuffer; compression is
// done via Content-Encoding so the browser's native decoder handles it
// (brotli when supported, zlib deflate otherwise) and the client just reads
// raw bytes from the response.
app.get('/snapshot', (req, res) => {
  res.set({
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    // The dev client runs on another port; headers must be exposed for CORS
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Canvas-Width, X-Canvas-Height',
    'X-Canvas-Width': String(CANVAS_WIDTH),
    'X-Canvas-Height': String(CANVAS_HEIGHT)
  });
  if (/\bbr\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.set('Content-Encoding', 'br');
    res.send(getBrotliSnapshot());
  } else {
    res.set('Content-Encoding', 'deflate');
    res.send(getDeflatedSnapshot());
  }
});

// Serve the built client when present, so a single deployment hosts everything
const clientBuildDir = path.resolve(__dirname, '../client/build');
if (existsSync(clientBuildDir)) {
  app.use(express.static(clientBuildDir));
}

io.on('connection', (socket) => {
  socket.emit('hello', {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    clients: io.engine.clientsCount
  });
  io.emit('clients', io.engine.clientsCount);

  // Latency probe: client measures round-trip time via the ack
  socket.on('latency', (ack) => {
    if (typeof ack === 'function') ack();
  });

  socket.on('get_canvas', () => {
    socket.emit('canvas', {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      data: getDeflatedSnapshot()
    });
  });

  // Tier 2 -> tier 1: binary chunk of pixels batched client-side
  socket.on('px', (data) => {
    const error = applyChunk(data);
    if (error) {
      socket.emit('error_msg', {
        error,
        message: `Expected binary chunk of ${PX_RECORD}-byte records (24-bit index, r, g, b), max ${MAX_PIXELS_PER_CHUNK} pixels, index < ${PIXEL_COUNT}`
      });
    }
  });

  // Legacy single-pixel JSON protocol; feeds the same broadcast pipeline
  socket.on('set_pixel', (msg) => {
    const { x, y, color } = msg ?? {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || !isValidColor(color)) {
      socket.emit('error_msg', {
        error: 'invalid_arguments',
        message: "Expected: {x:int, y:int, color:[r,g,b]} where r/g/b are 0-255"
      });
      return;
    }
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
      socket.emit('error_msg', {
        error: 'out_of_bounds',
        message: `Pixel (${x},${y}) outside canvas ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`
      });
      return;
    }
    writePixel(y * CANVAS_WIDTH + x, color[0], color[1], color[2]);
  });

  socket.on('disconnect', () => {
    io.emit('clients', io.engine.clientsCount);
  });
});

// Tier 1 -> tier 2: merge everything drawn in the last tick (by any client)
// into one binary chunk and broadcast it. Everyone gets the same packet; the
// author repaints its own pixels, which keeps all clients converged on
// server state.
setInterval(() => {
  if (pendingBroadcast.size === 0) return;
  const chunk = Buffer.allocUnsafe(pendingBroadcast.size * PX_RECORD);
  let off = 0;
  for (const [index, rgb] of pendingBroadcast) {
    chunk.writeUIntBE(index, off, 3);
    chunk[off + 3] = (rgb >> 16) & 0xff;
    chunk[off + 4] = (rgb >> 8) & 0xff;
    chunk[off + 5] = rgb & 0xff;
    off += PX_RECORD;
  }
  pendingBroadcast.clear();
  io.emit('px', chunk);
}, BROADCAST_MS).unref();

// Tier 1 -> tier 0: persist when dirty, never more than one write in flight.
// With multiple function instances this is last-writer-wins on the whole
// canvas; instances don't merge.
if (storeEnabled()) {
  let persisting = false;
  setInterval(async () => {
    if (!storeDirty || persisting) return;
    storeDirty = false;
    persisting = true;
    try {
      await saveSnapshot(getDeflatedSnapshot());
    } catch (err) {
      storeDirty = true;
      console.error('tier 0 save failed:', err.message);
    } finally {
      persisting = false;
    }
  }, PERSIST_MS).unref();
} else {
  console.warn('BLOB_READ_WRITE_TOKEN not set; canvas will not persist across restarts');
}

// Tier 0 -> tier 1: restore the canvas before accepting traffic
if (storeEnabled()) {
  try {
    const stored = await loadSnapshot();
    if (stored) {
      const raw = inflateSync(stored);
      if (raw.length === canvas.length) {
        raw.copy(canvas);
        console.log('canvas restored from blob store');
      } else {
        console.error(`stored snapshot has wrong size (${raw.length}), starting blank`);
      }
    }
  } catch (err) {
    console.error('tier 0 load failed, starting blank:', err.message);
  }
}

const PORT = process.env.PORT || 8765;
httpServer.listen(PORT, () => {
  console.log(`pixelparty server listening on :${PORT}`);
});

// No default export on purpose: exporting the app makes Vercel wrap it in its
// own server, bypassing httpServer and the Socket.IO instance attached to it.
// Without an export, Vercel uses the port listener above and runs this server.
