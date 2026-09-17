import { Bonjour } from 'bonjour-service';
import type { Logger } from 'pino';
export interface MdnsOptions { gatewayName: string; port: number; protocol: 'http' | 'https'; apiVersion?: string }
/** Publishes _openlight._tcp.local. Construction/import has no network side effects. */
export class MdnsAdvertiser {
  private bonjour: Bonjour | undefined;
  constructor(private readonly options: MdnsOptions, private readonly logger?: Logger) {}
  start(): void {
    if (this.bonjour) return;
    const bonjour = new Bonjour(undefined, () => this.logger?.warn({ category: 'discovery' }, 'mDNS advertisement error'));
    this.bonjour = bonjour;
    try {
      const service = bonjour.publish({ name: this.options.gatewayName, type: 'openlight', protocol: 'tcp', port: this.options.port,
        txt: { apiVersion: this.options.apiVersion ?? 'v1', gatewayName: this.options.gatewayName, port: String(this.options.port), protocol: this.options.protocol } });
      service.on('error', () => this.logger?.warn({ category: 'discovery' }, 'mDNS service error'));
    } catch (error) { bonjour.destroy(); this.bonjour = undefined; throw error; }
  }
  stop(): Promise<void> {
    const bonjour = this.bonjour; this.bonjour = undefined;
    if (!bonjour) return Promise.resolve();
    return new Promise(resolve => { bonjour.unpublishAll(() => { bonjour.destroy(); resolve(); }); });
  }
}
