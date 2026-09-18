import type { SchedulingProfile } from '../types.js';

/**
 * TODO: cloud REST implementation, deliberately not registered or invoked.
 * Before wiring it, require a separate default-off flag plus a per-account API key,
 * and honor X-RateLimit-Reset through AdapterError.retryAfterMs. Keep LAN independent.
 * The caller must provide a sanitized opaque account identifier, never credentials;
 * all instances using one account must use the same identifier for shared quotas.
 */
export function futureCloudScheduling(accountBucketId: string): SchedulingProfile {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(accountBucketId)) throw new Error('Invalid opaque account bucket identifier');
  return {
    budgets: [
      { scope: 'device', key: 'govee-cloud-device', maxRequests: 10, windowMs: 60_000, burst: 1, maxConcurrent: 1 },
      { scope: 'account', key: `govee-cloud-${accountBucketId}`, maxRequests: 10_000, windowMs: 86_400_000, burst: 1, maxConcurrent: 1 },
    ],
    minUpdateIntervalMs: 6_000,
    estimatedLatencyMs: 1_000,
    recommendedPollIntervalMs: 60_000,
  };
}
