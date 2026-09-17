import type { Operation } from './types.js';
export type Collection = 'rooms' | 'groups' | 'scenes' | 'effects' | 'effect_runs' | 'device_snapshots';
export interface CoreStore {
  get<T>(collection: Collection, id: string): T | undefined;
  list<T>(collection: Collection): T[];
  put<T>(collection: Collection, id: string, value: T): void;
  delete(collection: Collection, id: string): void;
  transaction<T>(fn: () => T): T;
  saveOperation(operation: Operation): void;
  getOperation<T>(id: string): T | undefined;
}
