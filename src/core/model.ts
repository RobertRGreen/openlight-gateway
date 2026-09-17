export type Transport = 'lan' | 'matter' | 'bridge' | 'cloud' | 'mock';
export type RGB = { r: number; g: number; b: number };
export type RGBW = RGB & { w: number };
export type RGBWW = RGB & { warmWhite: number; coolWhite: number };
export type Capability = { type: 'power' | 'rgb' | 'rgbw' | 'rgbww' }
  | { type: 'brightness' | 'colorTemperature'; minimum: number; maximum: number; step: number }
  | { type: 'effects'; effectIds: string[] }
  | { type: 'transitions'; maxDurationMs: number }
  | { type: 'segments'; segmentIds: string[] };
export interface SegmentState { power?: boolean; brightness?: number; rgb?: RGB; rgbw?: RGBW; rgbww?: RGBWW; colorTemperature?: number; effect?: string | null }
export interface DeviceState extends SegmentState { segments?: { id: string; state: SegmentState }[] }
export type Availability = 'online' | 'offline' | 'unknown';
export interface Device {
  id: string; name: string; manufacturer: string; model: string | null; adapter: string;
  address: { transport: Transport; endpoint: string | null } | null; room: string | null; groups: string[];
  capabilities: Capability[]; state: DeviceState; stateObservedAt: string | null; stateStale: boolean;
  revision: number; availability: Availability; metadata: { extensions: Record<string, Record<string, unknown>> };
}
export interface StateSnapshot { state: DeviceState; observedAt: string | null; stale: boolean; revision: number }
