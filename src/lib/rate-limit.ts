// Simple in-memory rate limiter
const requests = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS: Record<string, number> = {
  "/api/chat": 20,           // 20 messages per minute
  "/api/github/analyze": 5,  // 5 GitHub analyses per minute
  "/api/repos/sync": 10,     // 10 syncs per minute
  default: 60,               // 60 requests per minute for other endpoints
};

export function checkRateLimit(
  identifier: string, // userId or IP
  endpoint: string
): { allowed: boolean; remaining: number; resetIn: number } {
  const key = `${identifier}:${endpoint}`;
  const now = Date.now();
  const limit = MAX_REQUESTS[endpoint] ?? MAX_REQUESTS.default;

  const entry = requests.get(key);

  if (!entry || now > entry.resetAt) {
    requests.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, resetIn: WINDOW_MS };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetIn: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetIn: entry.resetAt - now };
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requests) {
    if (now > entry.resetAt) requests.delete(key);
  }
}, 60 * 1000);
