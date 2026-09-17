import type { DeviceState, Transport } from '../model.js';
import type { ErrorDetail } from '../errors.js';
export interface Target { type: 'device' | 'group'; id: string }
export interface Command { state: DeviceState; transitionMs?: number }
export interface DeviceResult {
  deviceId: string; status: 'succeeded' | 'degraded' | 'failed';
  confirmation: 'observed' | 'acknowledged' | 'unconfirmed'; state?: DeviceState;
  warnings: { code: string; requested: string; applied: string }[];
  error?: ErrorDetail; transport: Transport | null;
  fallback: { from: string; to: string; reason: string } | null;
  fieldResults: { path: string; status: 'applied' | 'failed' | 'unconfirmed' | 'omitted'; reason?: string }[];
}
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
export interface Operation {
  id: string; kind: 'device.command' | 'group.command' | 'scene.activate' | 'effect.start' | 'effect.stop' | 'discovery';
  status: OperationStatus; createdAt: string; completedAt: string | null;
  request: Record<string, unknown>; targetDeviceIds: string[]; results: DeviceResult[];
  effectRunId?: string; discoveredDeviceIds?: string[]; error?: ErrorDetail;
  adapterResults?: { adapterId: string; status: 'succeeded' | 'failed'; discoveredDeviceIds: string[]; error?: ErrorDetail }[];
}
export interface PreparedTarget { deviceId: string; command: Command; warnings?: DeviceResult['warnings']; rejection?: ErrorDetail }
