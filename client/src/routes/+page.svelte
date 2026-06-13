<script lang="ts">
  import { onMount } from 'svelte';
  import { io, type Socket } from 'socket.io-client';
  import { dev } from '$app/environment';
  import { hexToRgb, type RGB } from '$lib/utils/color';

  let socket: Socket | null = null;
  let status: 'disconnected' | 'connecting' | 'connected' | 'retrying' = 'disconnected';
  let transport: string | null = null; // 'polling' | 'websocket' | 'webtransport'
  let region: string | null = null; // Vercel region the function runs in
  let instance: string | null = null; // id of the function instance we're on
  let localClients = 0; // clients on this same instance
  let totalClients = 0; // clients across all instances
  let instanceCount = 1; // number of running instances
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

  // current color
  function randomHex(): string {
    const n = Math.floor(Math.random() * 0xffffff);
    return '#' + n.toString(16).padStart(6, '0');
  }
  let colorHex = randomHex();

  // --- pixel budget (mirrors the server's per-IP token bucket) ---
  const REFILL_PER_SEC = 1;
  let capacity = 5;
  let tokens = 5; // float; last value known/derived
  let bucketSyncAt = 0; // performance.now() when `tokens` was last set
  let displayTokens = 5; // integer shown in UI
  let refillFrac = 1; // 0..1 progress toward the next token (1 when full)
  let denyShake = false; // brief animation when a draw is refused locally

  function availableTokens(): number {
    const elapsed = (performance.now() - bucketSyncAt) / 1000;
    return Math.min(capacity, tokens + elapsed * REFILL_PER_SEC);
  }
  function tickBudget() {
    const cur = availableTokens();
    displayTokens = Math.floor(cur);
    refillFrac = cur >= capacity ? 1 : cur - Math.floor(cur);
  }
  function tryConsumeToken(): boolean {
    const cur = availableTokens();
    if (cur >= 1) {
      tokens = cur - 1;
      bucketSyncAt = performance.now();
      tickBudget();
      return true;
    }
    return false;
  }
  function flashDeny() {
    denyShake = true;
    setTimeout(() => (denyShake = false), 450);
  }

  // --- onboarding ---
  const INTRO_KEY = 'pp_intro_v1';
  let showIntro = false;
  function dismissIntro() {
    showIntro = false;
    try {
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      /* private mode */
    }
  }

  function connect() {
    status = 'connecting';
    // Websocket first: socket.io's default polling-first handshake needs every
    // poll to reach the same instance, and Vercel has no sticky routing — polls
    // land elsewhere, get "Session ID unknown", and the connection dies until a
    // websocket (one pinned connection) completes. Polling stays as a fallback.
    const opts = { transports: ['websocket', 'polling'], tryAllTransports: true };
    // In dev the API server runs separately on :8765; in production it's same-origin
    socket = dev ? io('http://localhost:8765', opts) : io(opts);

    socket.on('connect', () => {
      status = 'connected';
      reconnectAttempts = 0;
      snapshotReady = false;
      pxBacklog = [];
      pendingConfirm.clear();
      transport = socket?.io.engine.transport.name ?? null;
      socket?.io.engine.on('upgrade', (t: { name: string }) => {
        transport = t.name;
      });
      void loadSnapshot();
      startPing();
    });

    socket.on('disconnect', () => {
      status = 'disconnected';
      transport = null;
      pingMs = null;
      stopPing();
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      status = 'retrying';
      reconnectAttempts = attempt;
    });

    socket.on(
      'hello',
      (msg: { width: number; height: number; clients?: number; region?: string; instance?: string }) => {
        width = msg.width;
        height = msg.height;
        region = msg.region ?? null;
        instance = msg.instance ?? null;
        setupCanvas();
      }
    );

    // Authoritative budget from the server; reconcile our local estimate to it
    socket.on('budget', (b: { tokens: number; capacity: number; msToNext: number | null }) => {
      capacity = b.capacity ?? capacity;
      tokens = b.tokens;
      bucketSyncAt = performance.now();
      tickBudget();
    });

    // Pixels the server refused (out of budget) — undo the optimistic paint
    socket.on('px_rejected', (indices: number[]) => {
      for (const index of indices) {
        const prev = pendingConfirm.get(index);
        if (prev) {
          plotPixel(index % width, Math.floor(index / width), prev);
          pendingConfirm.delete(index);
        }
      }
      flashDeny();
    });

    // Fallback snapshot path over the socket (used if the HTTP fetch fails)
    socket.on('canvas', async (msg: { width: number; height: number; data: ArrayBuffer }) => {
      if (!width || !height) {
        width = msg.width;
        height = msg.height;
        setupCanvas();
      }
      try {
        const bytes = await inflate(msg.data);
        finishSnapshot(bytes);
      } catch (e) {
        console.error('Failed to decode canvas snapshot', e);
      }
    });

    // Tier 1 -> tier 2: coalesced binary chunk of pixel updates. Buffer until
    // the snapshot lands, else the (older) snapshot would overwrite them.
    socket.on('px', (data: ArrayBuffer) => {
      if (!snapshotReady) {
        pxBacklog.push(data);
        return;
      }
      applyPxChunk(data);
    });

    socket.on(
      'presence',
      (p: { localClients: number; totalClients: number; instanceCount: number; instance?: string }) => {
        localClients = p.localClients;
        totalClients = p.totalClients;
        instanceCount = p.instanceCount;
        if (p.instance) instance = p.instance;
      }
    );

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

  // --- snapshot + binary pixel protocol ---
  // px chunks are 6 bytes per pixel: 24-bit big-endian index (y*width+x), r, g, b
  const PX_RECORD = 6;
  const FLUSH_MS = 50;
  let snapshotReady = false;
  let pxBacklog: ArrayBuffer[] = [];
  // Pixels painted optimistically, awaiting server confirm; value is the color
  // that was there before, so we can roll back if the server rejects them.
  let pendingConfirm = new Map<number, RGB>();

  // Full refresh over HTTP: the body is the raw RGB framebuffer and the browser
  // decompresses via Content-Encoding, the cheapest decode and smallest transfer.
  async function loadSnapshot() {
    try {
      const base = dev ? 'http://localhost:8765' : '';
      const res = await fetch(`${base}/snapshot`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!width || !height) {
        width = Number(res.headers.get('x-canvas-width')) || 512;
        height = Number(res.headers.get('x-canvas-height')) || 512;
        setupCanvas();
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length !== width * height * 3) throw new Error(`bad snapshot size ${bytes.length}`);
      finishSnapshot(bytes);
    } catch (e) {
      console.warn('HTTP snapshot failed, falling back to socket', e);
      socket?.emit('get_canvas');
    }
  }

  function finishSnapshot(bytes: Uint8Array) {
    drawFullCanvas(bytes);
    snapshotReady = true;
    const backlog = pxBacklog;
    pxBacklog = [];
    for (const chunk of backlog) applyPxChunk(chunk);
  }

  function applyPxChunk(data: ArrayBuffer) {
    const b = new Uint8Array(data);
    for (let off = 0; off + PX_RECORD <= b.length; off += PX_RECORD) {
      const index = (b[off] << 16) | (b[off + 1] << 8) | b[off + 2];
      plotPixel(index % width, Math.floor(index / width), [b[off + 3], b[off + 4], b[off + 5]]);
      pendingConfirm.delete(index); // server confirmed this pixel
    }
  }

  // Tier 2 -> tier 1: locally-drawn pixels are painted immediately and queued
  // (deduped per pixel), then sent as one binary chunk per 50ms window.
  let pending = new Map<number, RGB>();
  let flushTimer: number | null = null;

  function flushPending() {
    flushTimer = null;
    if (pending.size === 0) return;
    if (!socket?.connected) {
      pending.clear();
      return;
    }
    const buf = new Uint8Array(pending.size * PX_RECORD);
    let off = 0;
    for (const [index, [r, g, b]] of pending) {
      buf[off] = index >> 16;
      buf[off + 1] = (index >> 8) & 0xff;
      buf[off + 2] = index & 0xff;
      buf[off + 3] = r;
      buf[off + 4] = g;
      buf[off + 5] = b;
      off += PX_RECORD;
    }
    pending.clear();
    socket.emit('px', buf);
  }

  function readPixel(x: number, y: number): RGB {
    if (!offctx) return [0, 0, 0];
    const d = (offctx as CanvasRenderingContext2D).getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  function ensureOffscreen(w: number, h: number) {
    if (typeof window !== 'undefined' && 'OffscreenCanvas' in window) {
      // @ts-ignore - OffscreenCanvas exists at runtime in modern browsers
      offscreen = new OffscreenCanvas(w, h);
      // @ts-ignore - willReadFrequently: we read single pixels for rollback
      offctx = (offscreen as OffscreenCanvas).getContext('2d', { willReadFrequently: true });
    } else {
      offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      offctx = (offscreen as HTMLCanvasElement).getContext('2d', { willReadFrequently: true });
    }
  }

  function setupCanvas() {
    if (!canvasEl) return;
    ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    ensureOffscreen(width, height);
    minScale = Math.max(1, Math.floor(Math.min(innerWidth / width, innerHeight / height)));
    scale = Math.max(1, minScale);
    camX = Math.floor((width * scale - innerWidth) / 2);
    camY = Math.floor((height * scale - innerHeight) / 2);
    requestFrame();
  }

  function drawFullCanvas(bytes: Uint8Array) {
    if (!offctx) return;
    const imageCtx = offctx as CanvasRenderingContext2D;
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
    const sw = Math.ceil(viewW / scale) + 1;
    const sh = Math.ceil(viewH / scale) + 1;

    const dx = -(camX - sx * scale);
    const dy = -(camY - sy * scale);

    ctx.clearRect(0, 0, viewW, viewH);
    // @ts-ignore drawImage works for OffscreenCanvas & HTMLCanvasElement
    ctx.drawImage(offscreen as any, sx, sy, sw, sh, dx, dy, sw * scale, sh * scale);

    if (scale >= 12) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      const startGridX = Math.floor(camX / scale);
      const endGridX = startGridX + Math.ceil(viewW / scale);
      for (let x = startGridX; x <= endGridX; x++) {
        const screenX = x * scale - camX;
        ctx.beginPath();
        ctx.moveTo(screenX + 0.5, 0);
        ctx.lineTo(screenX + 0.5, viewH);
        ctx.stroke();
      }
      const startGridY = Math.floor(camY / scale);
      const endGridY = startGridY + Math.ceil(viewH / scale);
      for (let y = startGridY; y <= endGridY; y++) {
        const screenY = y * scale - camY;
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

  function clampCamera() {
    const viewW = canvasEl?.clientWidth ?? innerWidth;
    const viewH = canvasEl?.clientHeight ?? innerHeight;
    const canvasW = width * scale;
    const canvasH = height * scale;
    if (canvasW <= viewW) camX = Math.floor((canvasW - viewW) / 2);
    else camX = Math.max(0, Math.min(canvasW - viewW, camX));
    if (canvasH <= viewH) camY = Math.floor((canvasH - viewH) / 2);
    else camY = Math.max(0, Math.min(canvasH - viewH, camY));
  }

  // Zoom toward a canvas-relative point, keeping that point under the cursor/fingers
  function zoomTo(cx: number, cy: number, newScale: number) {
    newScale = Math.max(minScale, Math.min(maxScale, newScale));
    if (newScale === scale) return;
    const worldX = (cx + camX) / scale;
    const worldY = (cy + camY) / scale;
    scale = newScale;
    camX = Math.round(worldX * scale - cx);
    camY = Math.round(worldY * scale - cy);
    clampCamera();
    requestFrame();
  }

  function onWheel(e: WheelEvent) {
    if (!width || !height) return;
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    zoomTo(e.clientX - rect.left, e.clientY - rect.top, scale * (e.deltaY > 0 ? 0.9 : 1.1));
  }

  // --- unified pointer input: tap = place, drag = pan, two-finger = pinch ---
  const TAP_THRESH = 6; // px of movement that turns a tap into a pan
  const activePointers = new Map<number, { x: number; y: number }>();
  let gesture: 'none' | 'pan' | 'pinch' = 'none';
  let downId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let movedBeyondTap = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  function twoPointers() {
    const it = activePointers.values();
    const a = it.next().value as { x: number; y: number };
    const b = it.next().value as { x: number; y: number };
    return [a, b];
  }

  function onPointerDown(e: PointerEvent) {
    canvasEl.setPointerCapture?.(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      downId = e.pointerId;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      movedBeyondTap = false;
      gesture = 'none';
    } else if (activePointers.size === 2) {
      const [a, b] = twoPointers();
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinchStartScale = scale;
      gesture = 'pinch';
      movedBeyondTap = true; // lifting fingers after a pinch shouldn't place
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture === 'pinch' && activePointers.size >= 2) {
      const [a, b] = twoPointers();
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const rect = canvasEl.getBoundingClientRect();
      const midX = (a.x + b.x) / 2 - rect.left;
      const midY = (a.y + b.y) / 2 - rect.top;
      zoomTo(midX, midY, pinchStartScale * (dist / pinchStartDist));
      return;
    }

    if (e.pointerId !== downId) return;
    if (!movedBeyondTap && Math.hypot(e.clientX - startX, e.clientY - startY) > TAP_THRESH) {
      movedBeyondTap = true;
      gesture = 'pan';
    }
    if (gesture === 'pan') {
      camX -= e.clientX - lastX;
      camY -= e.clientY - lastY;
      clampCamera();
      requestFrame();
    }
    lastX = e.clientX;
    lastY = e.clientY;
  }

  function endPointer(e: PointerEvent, place: boolean) {
    canvasEl.releasePointerCapture?.(e.pointerId);
    activePointers.delete(e.pointerId);

    if (gesture === 'pinch') {
      // Dropped from two fingers to one: continue as a pan from where it is
      if (activePointers.size === 1) {
        const [id, p] = [...activePointers.entries()][0];
        downId = id;
        startX = lastX = p.x;
        startY = lastY = p.y;
        gesture = 'pan';
        movedBeyondTap = true;
      } else if (activePointers.size === 0) {
        gesture = 'none';
        downId = null;
      }
      return;
    }

    if (e.pointerId === downId) {
      if (place && !movedBeyondTap) {
        const { x, y } = canvasToPixel(e.clientX, e.clientY);
        placePixel(x, y);
      }
      downId = null;
      gesture = 'none';
    } else {
      activePointers.delete(e.pointerId);
    }
  }

  function placePixel(x: number, y: number) {
    if (!socket?.connected) return;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (!tryConsumeToken()) {
      flashDeny();
      return;
    }
    const color = hexToRgb(colorHex);
    const index = y * width + x;
    if (!pendingConfirm.has(index)) pendingConfirm.set(index, readPixel(x, y));
    plotPixel(x, y, color); // tier 2: immediate local feedback
    pending.set(index, color);
    if (flushTimer === null) flushTimer = window.setTimeout(flushPending, FLUSH_MS);
  }

  function centerView() {
    if (!canvasEl) return;
    camX = Math.floor((width * scale - canvasEl.clientWidth) / 2);
    camY = Math.floor((height * scale - canvasEl.clientHeight) / 2);
    clampCamera();
    requestFrame();
  }

  function zoomBy(factor: number) {
    if (!canvasEl) return;
    zoomTo(canvasEl.clientWidth / 2, canvasEl.clientHeight / 2, scale * factor);
  }

  onMount(() => {
    try {
      showIntro = !localStorage.getItem(INTRO_KEY);
    } catch {
      showIntro = true;
    }
    connect();
    const budgetTimer = window.setInterval(tickBudget, 120);
    const onResize = () => {
      clampCamera();
      requestFrame();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearInterval(budgetTimer);
      stopPing();
      if (flushTimer !== null) clearTimeout(flushTimer);
      socket?.disconnect();
      socket = null;
    };
  });
</script>

<div class="flex h-screen w-screen flex-col bg-neutral-900 text-neutral-100">
  <header class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 px-3 py-2 sm:px-4">
    <div class="flex items-center gap-2">
      <h1 class="text-lg font-semibold">Pixel Party</h1>
      <button
        class="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-sm hover:bg-white/20"
        title="What is this?"
        on:click={() => (showIntro = true)}>?</button
      >
    </div>

    <div class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {#if status === 'connected'}
        <span class="hidden items-center gap-1 text-white/60 lg:flex" title="Function instance">
          Connected over {transport} to
          <svg viewBox="0 0 76 65" class="h-2.5 w-2.5 fill-current" aria-label="Vercel" role="img">
            <path d="M37.59.25l36.95 64H.64l36.95-64z" />
          </svg>
          {region ?? '…'} · fn {instance ?? '…'}
        </span>
        <span
          class="text-white/70"
          title="{localClients} on this function ({instance ?? '?'}) · {instanceCount} function{instanceCount === 1 ? '' : 's'} running"
        >
          {totalClients} online{instanceCount > 1 ? ` · ${localClients} here` : ''}
        </span>
        {#if pingMs !== null}
          <span class={pingMs < 80 ? 'text-emerald-400' : pingMs < 200 ? 'text-amber-400' : 'text-rose-400'} title="Round-trip latency">
            {pingMs}ms
          </span>
        {/if}
      {:else}
        <span class={status === 'connecting' || status === 'retrying' ? 'text-amber-400' : 'text-rose-400'}>
          {status === 'retrying' ? `reconnecting (${reconnectAttempts})` : status}
        </span>
      {/if}

      <label class="flex items-center gap-1" title="Pick color">
        <span class="hidden text-white/50 sm:inline">Color</span>
        <input type="color" bind:value={colorHex} class="h-8 w-10 cursor-pointer rounded border border-white/10 bg-transparent p-0" />
      </label>
      <button class="hidden rounded bg-white/10 px-2 py-1 hover:bg-white/20 sm:block" on:click={centerView}>Center</button>
      <div class="hidden items-center gap-1 sm:flex">
        <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" on:click={() => zoomBy(0.9)}>−</button>
        <span class="w-10 text-center tabular-nums">{Math.round(scale)}x</span>
        <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" on:click={() => zoomBy(1.1)}>+</button>
      </div>
    </div>
  </header>

  <main class="relative flex-1 overflow-hidden">
    <div class="absolute inset-0">
      <canvas
        bind:this={canvasEl}
        class="h-full w-full touch-none select-none bg-neutral-950"
        on:wheel|preventDefault={onWheel}
        on:pointerdown={onPointerDown}
        on:pointermove={onPointerMove}
        on:pointerup={(e) => endPointer(e, true)}
        on:pointercancel={(e) => endPointer(e, false)}
      ></canvas>
    </div>

    <!-- pixel budget -->
    <div
      class="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5 rounded-xl bg-black/60 px-4 py-2 backdrop-blur {denyShake ? 'animate-shake ring-1 ring-rose-500' : ''}"
    >
      <div class="flex items-center gap-1.5">
        {#each Array(capacity) as _, i}
          <span
            class="h-3.5 w-3.5 rounded-full border transition-colors"
            style={i < displayTokens ? `background:${colorHex};border-color:rgba(255,255,255,.85)` : 'border-color:rgba(255,255,255,.25)'}
          ></span>
        {/each}
        <span class="ml-1.5 text-xs tabular-nums text-white/80">{displayTokens}/{capacity}</span>
      </div>
      <div class="h-1 w-full overflow-hidden rounded bg-white/10">
        <div class="h-full bg-white/50 transition-[width] duration-100" style="width:{Math.round(refillFrac * 100)}%"></div>
      </div>
    </div>

    <div class="pointer-events-none absolute bottom-2 left-2 rounded bg-black/50 px-2 py-1 text-xs text-white/70">
      Tap to place · Drag to pan · Pinch or scroll to zoom
    </div>
  </main>

  {#if showIntro}
    <div class="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-4" on:click|self={dismissIntro} role="presentation">
      <div class="max-w-sm rounded-2xl border border-white/10 bg-neutral-800 p-6 text-center shadow-xl">
        <h2 class="text-2xl font-bold">Pixel Party 🎨</h2>
        <p class="mt-3 text-sm text-white/80">
          A shared canvas everyone draws on together, live. Pick a color and place pixels — whatever you draw, everyone else sees instantly.
        </p>
        <div class="mt-4 space-y-1 text-left text-sm text-white/70">
          <p>👆 <b>Tap</b> (or click) to place a pixel</p>
          <p>✋ <b>Drag</b> to move around · <b>pinch / scroll</b> to zoom</p>
          <p>⏳ You get <b>{capacity} pixels</b>, and earn one more every second</p>
        </div>
        <button class="mt-5 w-full rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-black hover:bg-emerald-400" on:click={dismissIntro}>
          Start drawing
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  @keyframes shake {
    0%, 100% { transform: translate(-50%, 0); }
    25% { transform: translate(calc(-50% - 5px), 0); }
    75% { transform: translate(calc(-50% + 5px), 0); }
  }
  :global(.animate-shake) {
    animation: shake 0.25s ease-in-out;
  }
</style>
