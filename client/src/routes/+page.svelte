<script lang="ts">
  import { onMount } from 'svelte';
  import { hexToRgb, type RGB } from '$lib/utils/color';

  let ws: WebSocket | null = null;
  let status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
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
  let colorHex = '#ff0000';

  function connect() {
    status = 'connecting';
    try {
      ws = new WebSocket('ws://localhost:8765');
    } catch (e) {
      console.error(e);
      status = 'disconnected';
      return;
    }

    ws.addEventListener('open', () => {
      status = 'connected';
      ws?.send(JSON.stringify({ type: 'get_canvas' }));
    });

    ws.addEventListener('close', () => {
      status = 'disconnected';
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleMessage(msg);
      } catch (e) {
        // ignore non-JSON (like ping)
      }
    });
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

  function handleMessage(msg: any) {
    if (msg.type === 'hello') {
      width = msg.width;
      height = msg.height;
      setupCanvas();
    } else if (msg.type === 'canvas') {
      if (!width || !height) {
        width = msg.width;
        height = msg.height;
        setupCanvas();
      }
      drawFullCanvas(msg.data as RGB[][]);
    } else if (msg.type === 'pixel_update') {
      plotPixel(msg.x, msg.y, msg.color as RGB);
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

  function drawFullCanvas(data: RGB[][]) {
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
    let i = 0;
    for (let y = 0; y < height; y++) {
      const row = data[y];
      for (let x = 0; x < width; x++) {
        const [r, g, b] = row[x];
        imgData.data[i++] = r;
        imgData.data[i++] = g;
        imgData.data[i++] = b;
        imgData.data[i++] = 255;
      }
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
    const sw = Math.ceil(viewW / scale);
    const sh = Math.ceil(viewH / scale);
    // draw the portion of the offscreen onto the visible canvas
    ctx.clearRect(0, 0, viewW, viewH);
    // @ts-ignore drawImage works for OffscreenCanvas & HTMLCanvasElement
    ctx.drawImage(offscreen as any, sx, sy, sw, sh, 0, 0, sw * scale, sh * scale);

    // grid when zoomed in
    if (scale >= 12) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      for (let x = 0; x <= sw; x++) {
        const gx = Math.floor(x * scale - (camX % scale));
        ctx.beginPath();
        ctx.moveTo(gx + 0.5, 0);
        ctx.lineTo(gx + 0.5, viewH);
        ctx.stroke();
      }
      for (let y = 0; y <= sh; y++) {
        const gy = Math.floor(y * scale - (camY % scale));
        ctx.beginPath();
        ctx.moveTo(0, gy + 0.5);
        ctx.lineTo(viewW, gy + 0.5);
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

  function onMouseDown(e: MouseEvent) {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      isPanning = true;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
    } else if (e.button === 0) {
      placeAtEvent(e);
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
    }
  }
  function onMouseUp() {
    isPanning = false;
  }

  function placeAtEvent(e: MouseEvent) {
    if (!ws || status !== 'connected') return;
    const { x, y } = canvasToPixel(e.clientX, e.clientY);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const color = hexToRgb(colorHex);
    ws.send(JSON.stringify({ type: 'set_pixel', x, y, color }));
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
      ws?.close();
    };
  });
</script>

<div class="flex h-screen w-screen flex-col bg-neutral-900 text-neutral-100">
  <header class="flex items-center gap-4 border-b border-white/10 px-4 py-2">
    <h1 class="text-lg font-semibold">Pixel Party</h1>
    <div class="ml-auto flex items-center gap-3 text-sm">
      <span class={status === 'connected' ? 'text-emerald-400' : status === 'connecting' ? 'text-amber-400' : 'text-rose-400'}>
        {status}
      </span>
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
