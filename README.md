# Pixel Party

A collaborative r/place-style pixel canvas. Express + Socket.io server, SvelteKit client.

## Structure

- `server/index.js` — Express + Socket.io server. Holds the 512×512 RGB canvas in memory and serves the built client from `client/build`.
- `client/` — SvelteKit app (static build, no SSR) using `socket.io-client`.

## Develop

```sh
npm install            # server deps (root)
npm run dev:server     # server on :8765

cd client && pnpm install
pnpm dev               # client on :5173, connects to :8765
```

## Build & run production locally

```sh
npm run build          # builds the client into client/build
npm start              # serves client + sockets on :8765
```

## Deploy to Vercel

Deploy the repo root. `vercel.json` sets the Express framework preset and the build command (which builds the SvelteKit client). The server entry is `server/index.js` (via `main` in package.json); Socket.io runs over WebSockets on the same origin, so the client needs no configuration.

## Architecture: three state tiers

- **Tier 0 — Vercel Blob.** The canvas is persisted as zlib-deflated RGB bytes at `pixelparty/canvas.bin`. The server loads it on boot and writes it back at most every 200ms while dirty (one write in flight at a time). Requires `BLOB_READ_WRITE_TOKEN`; without it the canvas is memory-only.
- **Tier 1 — the server.** Holds the authoritative 512×512 RGB framebuffer in memory. All writes (binary chunks and legacy `set_pixel`) land here, and every 50ms the pixels written since the last tick are merged into one binary chunk and broadcast to all clients.
- **Tier 2 — the browser.** Paints locally the moment you draw, queues the pixels (deduped), and ships them as one binary chunk per 50ms window.

## Socket protocol

Pixel updates use a binary `px` event in both directions: 6 bytes per pixel — 24-bit big-endian index (`y * width + x`) followed by `r`, `g`, `b`. Chunks are capped at 16384 pixels.

| Event (client → server) | Payload | Response |
| --- | --- | --- |
| `px` | binary chunk (see above) | merged into the next 50ms `px` broadcast to everyone (including the sender) |
| `set_pixel` | `{x, y, color: [r,g,b]}` (legacy) | same as `px` |
| `get_canvas` | — | `canvas` with `{width, height, data}` where `data` is the raw RGB framebuffer, zlib-deflated (lossless). Client inflates with `DecompressionStream('deflate')`. |
| `latency` | ack callback | server acks immediately; client measures round-trip time |

Server-pushed events: `hello` (canvas size + client count), `px` (binary, coalesced), `clients` (live count), `error_msg`.

## Full refresh

New clients fetch `GET /snapshot`: the raw framebuffer compressed via `Content-Encoding` (brotli when the browser supports it, zlib deflate otherwise), so the browser's native decoder does the work and the transfer is as small as the content allows. The socket `get_canvas` event remains as a fallback.
