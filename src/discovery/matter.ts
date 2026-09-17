import { UnimplementedDiscoveryProvider } from './provider.js';
// TODO: authenticated Matter fabric discovery; commissioning is a separate action.
export class MatterDiscoveryProvider extends UnimplementedDiscoveryProvider { readonly id = 'matter'; }
