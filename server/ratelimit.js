// Per-IP token bucket: every client starts with CAPACITY pixels and regains
// one every 1/REFILL_PER_SEC seconds, up to CAPACITY. Keyed by IP so opening
// several tabs shares one budget.
//
// State is in-memory per function instance. Vercel routes each websocket
// independently, so a determined abuser spreading tabs across instances could
// get CAPACITY per instance — bounded and small. True global enforcement would
// need a shared low-latency store (Redis); blob is far too slow for a check on
// every pixel.
export const CAPACITY = 5;
export const REFILL_PER_SEC = 1;

const buckets = new Map(); // ip -> { tokens: float, last: ms }

function refilled(ip, now) {
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: CAPACITY, last: now };
    buckets.set(ip, b);
    return b;
  }
  const gained = ((now - b.last) / 1000) * REFILL_PER_SEC;
  if (gained > 0) {
    b.tokens = Math.min(CAPACITY, b.tokens + gained);
    b.last = now;
  }
  return b;
}

// Consume up to `n` whole tokens; returns how many were granted (0..n).
export function take(ip, n, now = Date.now()) {
  const b = refilled(ip, now);
  const granted = Math.min(n, Math.floor(b.tokens));
  b.tokens -= granted;
  return granted;
}

// Current budget without consuming. msToNext is time until the next whole
// token (null when full).
export function peek(ip, now = Date.now()) {
  const b = refilled(ip, now);
  const tokens = Math.floor(b.tokens);
  const msToNext =
    b.tokens >= CAPACITY ? null : Math.ceil(((tokens + 1 - b.tokens) / REFILL_PER_SEC) * 1000);
  return { tokens, capacity: CAPACITY, msToNext };
}

// Drop buckets that have fully refilled and gone idle, so the map can't grow
// without bound from one-off visitors.
export function prune(now = Date.now()) {
  for (const [ip, b] of buckets) {
    const gained = ((now - b.last) / 1000) * REFILL_PER_SEC;
    if (b.tokens + gained >= CAPACITY && now - b.last > 60000) buckets.delete(ip);
  }
}

export function clientIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}
