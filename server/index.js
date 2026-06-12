import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 512;

// Flat RGB buffer, row-major: index = (y * CANVAS_WIDTH + x) * 3
const canvas = Buffer.alloc(CANVAS_WIDTH * CANVAS_HEIGHT * 3);

// Cached deflated snapshot, invalidated whenever a pixel changes.
// Snapshots are sent as zlib-deflated binary so a fresh client doesn't
// download a multi-megabyte JSON array; the client inflates it with
// DecompressionStream('deflate').
let deflatedSnapshot = null;
function getDeflatedSnapshot() {
  if (!deflatedSnapshot) deflatedSnapshot = deflateSync(canvas);
  return deflatedSnapshot;
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

    const i = (y * CANVAS_WIDTH + x) * 3;
    canvas[i] = color[0];
    canvas[i + 1] = color[1];
    canvas[i + 2] = color[2];
    deflatedSnapshot = null;

    io.emit('pixel_update', { x, y, color });
  });

  socket.on('disconnect', () => {
    io.emit('clients', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 8765;
httpServer.listen(PORT, () => {
  console.log(`pixelparty server listening on :${PORT}`);
});

// No default export on purpose: exporting the app makes Vercel wrap it in its
// own server, bypassing httpServer and the Socket.IO instance attached to it.
// Without an export, Vercel uses the port listener above and runs this server.
