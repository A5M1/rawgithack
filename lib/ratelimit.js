// In-memory fixed-window rate limiter.
//
// Vercel Functions are stateless between instances, so this is a best-effort
// local guard. For strict limits across all instances, add a Vercel WAF rule
// or a shared store such as Upstash Redis.

const buckets = new Map();
const MAX_BUCKETS = 10_000;
let operations = 0;

function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }

  while (buckets.size > MAX_BUCKETS) {
    buckets.delete(buckets.keys().next().value);
  }
}

export function rateLimit(key, { windowMs, max }) {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  operations += 1;
  if (operations % 1_000 === 0) sweep(now);

  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    resetAt: bucket.resetAt,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function resetRateLimits() {
  buckets.clear();
  operations = 0;
}
