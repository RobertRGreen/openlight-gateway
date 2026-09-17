import { AdapterError } from '../adapters/types.js';
import type { AdapterDevice, CallContext } from '../adapters/types.js';
export interface DiscoveryProvider { readonly id: string; discover(context: CallContext): AsyncIterable<AdapterDevice> }
export function checkDiscoveryContext(context: CallContext): void {
  if (context.signal.aborted) throw new AdapterError('CANCELED', 'Discovery canceled');
  if (Date.now() >= context.deadlineAt) throw new AdapterError('TIMEOUT', 'Discovery deadline expired', true);
}
/** Entries come only from trusted local adapter configuration, never arbitrary API URLs. */
export class ManualDiscoveryProvider implements DiscoveryProvider {
  readonly id = 'manual';
  private readonly entries: readonly AdapterDevice[];
  constructor(entries: readonly AdapterDevice[], allowEndpoint: (endpoint: string) => boolean = () => false) {
    if (entries.length > 10_000) throw new RangeError('Manual inventory exceeds resource limit');
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.nativeId || ids.has(entry.nativeId)) throw new TypeError('Manual identities must be unique and nonempty'); ids.add(entry.nativeId);
      const endpoint = entry.address?.endpoint;
      if (endpoint && (!allowEndpoint(endpoint) || /[?@#]/.test(endpoint))) throw new TypeError('Endpoint is outside configured discovery policy or contains credentials');
    }
    this.entries = structuredClone(entries);
  }
  async *discover(context: CallContext): AsyncIterable<AdapterDevice> {
    checkDiscoveryContext(context);
    for (const entry of this.entries) { checkDiscoveryContext(context); yield structuredClone(entry); }
  }
}
export abstract class UnimplementedDiscoveryProvider implements DiscoveryProvider {
  abstract readonly id: string;
  async *discover(context: CallContext): AsyncIterable<AdapterDevice> {
    checkDiscoveryContext(context);
    // TODO: implement bounded discovery with explicit network/account policy.
    throw new AdapterError('TRANSPORT_ERROR', 'Discovery provider is not implemented');
  }
}
