import { UnimplementedDiscoveryProvider } from './provider.js';
// TODO: verified Govee LAN discovery restricted to configured network interfaces.
export class GoveeLanDiscoveryProvider extends UnimplementedDiscoveryProvider { readonly id = 'govee-lan'; }
