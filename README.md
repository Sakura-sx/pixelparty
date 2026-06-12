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

## Socket protocol

| Event (client → server) | Payload | Response |
| --- | --- | --- |
| `set_pixel` | `{x, y, color: [r,g,b]}` | broadcasts `pixel_update` to everyone |
| `get_canvas` | — | `canvas` with `{width, height, data}` where `data` is the raw RGB framebuffer, zlib-deflated (lossless). Client inflates with `DecompressionStream('deflate')`. |
| `latency` | ack callback | server acks immediately; client measures round-trip time |

Server-pushed events: `hello` (canvas size + client count), `pixel_update`, `clients` (live count), `error_msg`.
