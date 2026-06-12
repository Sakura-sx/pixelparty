<script lang="ts">
  import { onMount } from 'svelte';
  import { io, type Socket } from 'socket.io-client';
  import { dev } from '$app/environment';
  import { hexToRgb, type RGB } from '$lib/utils/color';

  let socket: Socket | null = null;
  let status: 'disconnected' | 'connecting' | 'connected' | 'retrying' = 'disconnected';
  let clientCount: number | null = null;
  let reconnectAttempts = 0;

  // latency probe
  const pingEveryMs = 3000;
  let pingMs: number | null = null;
  let pingIntervalId: number | null = null;

  let width = 0;
  let height = 0;
  let scale = 1; // zoom factor
  let minScale = 1;
  let maxScale = 40;
  let canvasEl: HTMLCanvasElement;
  let offscreen: OffscreenCanvas | HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let offctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  // camera pan
  let camX = 0;
  let camY = 0;
  let isPanning = false;
  let lastPanX = 0;
  let lastPanY = 0;

  // current color
  function randomHex(): string {
    const n = Math.floor(Math.random() * 0xffffff);
    return '#' + n.toString(16).padStart(6, '0');
  }
  let colorHex = randomHex();

  function connect() {
    status = 'connecting';
    // In dev the API server runs separately on :8765; in production it's same-origin
    socket = dev ? io('http://localhost:8765') : io();

    socket.on('connect', () => {
      status = 'connected';
      reconnectAttempts = 0;
      socket?.emit('get_canvas');
      startPing();
    });

    socket.on('disconnect', () => {
      status = 'disconnected';
      pingMs = null;
      stopPing();
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      status = 'retrying';
      reconnectAttempts = attempt;
    });

    socket.on('hello', (msg: { width: number; height: number; clients?: number }) => {
      width = msg.width;
      height = msg.height;
      if (typeof msg.clients === 'number') clientCount = msg.clients;
      setupCanvas();
    });

    socket.on('canvas', async (msg: { width: number; height: number; data: ArrayBuffer }) => {
      if (!width || !height) {
        width = msg.width;
        height = msg.height;
        setupCanvas();
      }
      try {
        const bytes = await inflate(msg.data);
        drawFullCanvas(bytes);
      } catch (e) {
        console.error('Failed to decode canvas snapshot', e);
      }
    });

    socket.on('pixel_update', (msg: { x: number; y: number; color: RGB }) => {
      plotPixel(msg.x, msg.y, msg.color);
    });

    socket.on('clients', (count: number) => {
      if (typeof count === 'number') clientCount = count;
    });

    socket.on('error_msg', (msg: { error: string; message: string }) => {
      console.warn('server error:', msg.error, msg.message);
    });
  }

  function startPing() {
    stopPing();
    const sendPing = () => {
      if (!socket?.connected) return;
      const start = performance.now();
      socket.timeout(5000).emit('latency', (err: unknown) => {
        if (!err) pingMs = Math.round(performance.now() - start);
      });
    };
    sendPing();
    pingIntervalId = window.setInterval(sendPing, pingEveryMs);
  }

  function stopPing() {
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
    }
  }

  // Snapshots arrive as zlib-deflated RGB bytes (lossless); inflate them natively
  async function inflate(buf: ArrayBuffer): Promise<Uint8Array> {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function ensureOffscreen(w: number, h: number) {
    if (typeof window !== 'undefined' && 'OffscreenCanvas' in window) {
      // @ts-ignore - OffscreenCanvas exists at runtime in modern browsers
      offscreen = new OffscreenCanvas(w, h);
      // @ts-ignore
      offctx = (offscreen as OffscreenCanvas).getContext('2d');
    } else {
      offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      offctx = (offscreen as HTMLCanvasElement).getContext('2d');
    }
  }

  function setupCanvas() {
    if (!canvasEl) return;
    ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    ensureOffscreen(width, height);
    minScale = Math.max(1, Math.floor(Math.min(innerWidth / width, innerHeight / height)));
    scale = Math.max(1, minScale);
    // center camera
    camX = Math.floor((width * scale - innerWidth) / 2);
    camY = Math.floor((height * scale - innerHeight) / 2);
    requestFrame();
  }

  function drawFullCanvas(bytes: Uint8Array) {
    if (!offctx) return;
    const imageCtx = offctx as CanvasRenderingContext2D;
    // Ensure the offscreen has correct size (in case of server resize in future)
    // @ts-ignore
    if ('width' in offscreen && (offscreen as any).width !== width) {
      // @ts-ignore
      (offscreen as any).width = width;
      // @ts-ignore
      (offscreen as any).height = height;
    }
    const imgData = imageCtx.createImageData(width, height);
    for (let p = 0, i = 0; p < bytes.length; p += 3) {
      imgData.data[i++] = bytes[p];
      imgData.data[i++] = bytes[p + 1];
      imgData.data[i++] = bytes[p + 2];
      imgData.data[i++] = 255;
    }
    imageCtx.putImageData(imgData, 0, 0);
    requestFrame();
  }

  function plotPixel(x: number, y: number, rgb: RGB) {
    if (!offctx) return;
    const imageCtx = offctx as CanvasRenderingContext2D;
    const imageData = imageCtx.createImageData(1, 1);
    imageData.data[0] = rgb[0];
    imageData.data[1] = rgb[1];
    imageData.data[2] = rgb[2];
    imageData.data[3] = 255;
    imageCtx.putImageData(imageData, x, y);
    requestFrame();
  }

  let framePending = false;
  function requestFrame() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      render();
    });
  }

  function render() {
    if (!ctx || !offscreen) return;
    const viewW = canvasEl.clientWidth;
    const viewH = canvasEl.clientHeight;
    canvasEl.width = viewW;
    canvasEl.height = viewH;

    ctx.imageSmoothingEnabled = false;

    const sx = Math.floor(camX / scale);
    const sy = Math.floor(camY / scale);
    const sw = Math.ceil(viewW / scale) + 1; // Add 1 to prevent edge artifacts
    const sh = Math.ceil(viewH / scale) + 1; // Add 1 to prevent edge artifacts

    // Calculate the destination offset to account for fractional camera positions
    const dx = -(camX - sx * scale);
    const dy = -(camY - sy * scale);

    ctx.clearRect(0, 0, viewW, viewH);
    // Draw the portion of the offscreen canvas, now correctly offset
    // @ts-ignore drawImage works for OffscreenCanvas & HTMLCanvasElement
    ctx.drawImage(offscreen as any, sx, sy, sw, sh, dx, dy, sw * scale, sh * scale);

    // Grid when zoomed in
    if (scale >= 12) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;

      // The first visible vertical grid line's world coordinate
      const startGridX = Math.floor(camX / scale);
      // The last visible vertical grid line's world coordinate
      const endGridX = startGridX + Math.ceil(viewW / scale);

      for (let x = startGridX; x <= endGridX; x++) {
        // Calculate the precise screen position and add 0.5 for a crisp line
        const screenX = (x * scale) - camX;
        ctx.beginPath();
        ctx.moveTo(screenX + 0.5, 0);
        ctx.lineTo(screenX + 0.5, viewH);
        ctx.stroke();
      }

      // The first visible horizontal grid line's world coordinate
      const startGridY = Math.floor(camY / scale);
      // The last visible horizontal grid line's world coordinate
      const endGridY = startGridY + Math.ceil(viewH / scale);

      for (let y = startGridY; y <= endGridY; y++) {
        // Calculate the precise screen position and add 0.5 for a crisp line
        const screenY = (y * scale) - camY;
        ctx.beginPath();
        ctx.moveTo(0, screenY + 0.5);
        ctx.lineTo(viewW, screenY + 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function canvasToPixel(clientX: number, clientY: number) {
    const rect = canvasEl.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left + camX) / scale);
    const y = Math.floor((clientY - rect.top + camY) / scale);
    return { x, y };
  }

  function onWheel(e: WheelEvent) {
    if (!width || !height) return;
    e.preventDefault();
    const oldScale = scale;
    const delta = Math.sign(e.deltaY);
    const newScale = Math.max(minScale, Math.min(maxScale, scale * (delta > 0 ? 0.9 : 1.1)));
    if (newScale === scale) return;

    // Zoom towards cursor
    const rect = canvasEl.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const worldXBefore = (cx + camX) / oldScale;
    const worldYBefore = (cy + camY) / oldScale;
    scale = newScale;
    camX = Math.round(worldXBefore * scale - cx);
    camY = Math.round(worldYBefore * scale - cy);
    clampCamera();
    requestFrame();
  }

  function clampCamera() {
    const viewW = canvasEl?.clientWidth ?? innerWidth;
    const viewH = canvasEl?.clientHeight ?? innerHeight;
    const canvasW = width * scale;
    const canvasH = height * scale;
    // If canvas is smaller than viewport, center it
    if (canvasW <= viewW) {
      camX = Math.floor((canvasW - viewW) / 2);
    } else {
      camX = Math.max(0, Math.min(canvasW - viewW, camX));
    }
    if (canvasH <= viewH) {
      camY = Math.floor((canvasH - viewH) / 2);
    } else {
      camY = Math.max(0, Math.min(canvasH - viewH, camY));
    }
  }

  let isDrawing = false;
  let lastDrawX: number | null = null;
  let lastDrawY: number | null = null;

  function onMouseDown(e: MouseEvent) {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      isPanning = true;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
    } else if (e.button === 0) {
      isDrawing = true;
      const { x, y } = canvasToPixel(e.clientX, e.clientY);
      lastDrawX = x;
      lastDrawY = y;
      placePixel(x, y);
    }
  }
  function onMouseMove(e: MouseEvent) {
    if (isPanning) {
      const dx = e.clientX - lastPanX;
      const dy = e.clientY - lastPanY;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
      camX -= dx;
      camY -= dy;
      clampCamera();
      requestFrame();
    } else if (isDrawing) {
      const { x, y } = canvasToPixel(e.clientX, e.clientY);
      // Only send if position changed
      if (x !== lastDrawX || y !== lastDrawY) {
        lastDrawX = x;
        lastDrawY = y;
        placePixel(x, y);
      }
    }
  }
  function onMouseUp() {
    isPanning = false;
    isDrawing = false;
    lastDrawX = null;
    lastDrawY = null;
  }

  function placePixel(x: number, y: number) {
    if (!socket?.connected) return;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const color = hexToRgb(colorHex);
    socket.emit('set_pixel', { x, y, color });
  }

  function centerView() {
    if (!canvasEl) return;
    camX = Math.floor((width * scale - canvasEl.clientWidth) / 2);
    camY = Math.floor((height * scale - canvasEl.clientHeight) / 2);
    clampCamera();
    requestFrame();
  }

  onMount(() => {
    connect();
    const onResize = () => {
      clampCamera();
      requestFrame();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      stopPing();
      socket?.disconnect();
      socket = null;
    };
  });
</script>

<div class="flex h-screen w-screen flex-col bg-neutral-900 text-neutral-100">
  <header class="flex items-center gap-4 border-b border-white/10 px-4 py-2">
    <h1 class="text-lg font-semibold">Pixel Party</h1>
    <div class="ml-auto flex items-center gap-3 text-sm">
      <span class={status === 'connected' ? 'text-emerald-400' : status === 'connecting' ? 'text-amber-400' : status === 'retrying' ? 'text-amber-400' : 'text-rose-400'}>
        {status === 'retrying' ? `disconnected, retrying (${reconnectAttempts})` : status}
      </span>
      {#if pingMs !== null}
        <span class={pingMs < 80 ? 'text-emerald-400' : pingMs < 200 ? 'text-amber-400' : 'text-rose-400'} title="Round-trip latency">
          {pingMs}ms
        </span>
      {/if}
      <span class="text-white/70">{clientCount !== null ? `clients: ${clientCount}` : ''}</span>
      <input type="color" bind:value={colorHex} class="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent p-0" title="Pick color" />
      <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" on:click={centerView}>Center</button>
      <div class="flex items-center gap-1">
        <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" on:click={() => { scale = Math.max(minScale, Math.round(scale * 0.9)); clampCamera(); requestFrame(); }}>-</button>
        <span class="w-10 text-center tabular-nums">{Math.round(scale)}x</span>
        <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" on:click={() => { scale = Math.min(maxScale, Math.round(scale * 1.1)); clampCamera(); requestFrame(); }}>+</button>
      </div>
    </div>
  </header>

  <main class="relative flex-1 overflow-hidden">
    <div class="absolute inset-0">
      <canvas
        bind:this={canvasEl}
        class="h-full w-full touch-none select-none bg-neutral-950"
        on:wheel|preventDefault={onWheel}
        on:mousedown={onMouseDown}
        on:mousemove={onMouseMove}
        on:mouseup={onMouseUp}
        on:mouseleave={onMouseUp}
      ></canvas>
    </div>
    <div class="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/50 px-2 py-1 text-xs text-white/80">
      Left-click to place • Middle-click/Shift+Drag to pan • Scroll to zoom
    </div>
  </main>
</div>
