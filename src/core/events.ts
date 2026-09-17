import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Device, Capability, Availability, StateSnapshot } from './model.js';
import type { Operation, OperationStatus } from './operations/types.js';
import type { EffectRun } from './effects/index.js';
import type { AggregateState } from './rooms/index.js';
import type { ErrorDetail } from './errors.js';
export interface DomainData {
 'device.discovered':{device:Device};
 'device.connected':{availability:Availability;reason:string};
 'device.disconnected':{availability:Availability;reason:string};
 'device.state_changed':StateSnapshot;
 'device.capabilities_changed':{capabilities:Capability[]};
 'adapter.connected':{adapterId:string;reason:string;error?:ErrorDetail};
 'adapter.disconnected':{adapterId:string;reason:string;error?:ErrorDetail};
 'adapter.error':{adapterId:string;reason:string;error?:ErrorDetail};
 'room.state_changed':AggregateState; 'group.state_changed':AggregateState;
 'scene.started':{operationId:string;status:OperationStatus}; 'scene.completed':{operationId:string;status:OperationStatus}; 'scene.failed':{operationId:string;status:OperationStatus};
 'effect.started':{run:EffectRun}; 'effect.updated':{run:EffectRun}; 'effect.stopped':{run:EffectRun};
 'operation.completed':{operation:Operation};
 'gateway.started':{reason:string}; 'gateway.stopping':{reason:string};
}
export interface DomainEvent<T=unknown> {schemaVersion:'1.0';id:string;sequence:number;gatewayId:string;bootId:string;type:string;occurredAt:string;subject:{type:string;id:string};correlationId:string|null;data:T}
export class DomainBus {
 private readonly emitter = new EventEmitter(); private sequence=0; readonly bootId=randomUUID();
 constructor(readonly gatewayId:string,private readonly onListenerError:(error:unknown)=>void=()=>{}) {}
 publish<K extends keyof DomainData>(type:K,subject:{type:string;id:string},data:DomainData[K],correlationId?:string|null):DomainEvent<DomainData[K]>;
 publish<T>(type:string,subject:{type:string;id:string},data:T,correlationId:string|null=null):DomainEvent<T> {
  const event:DomainEvent<T>={schemaVersion:'1.0',id:randomUUID(),sequence:++this.sequence,gatewayId:this.gatewayId,bootId:this.bootId,type,occurredAt:new Date().toISOString(),subject,correlationId,data:structuredClone(data)};
  for (const listener of this.emitter.listeners('event')) {try {const result:unknown=listener(event);if(result instanceof Promise)void result.catch(error=>this.listenerError(error));} catch(error) {this.listenerError(error);}}
  return event;
 }
 private listenerError(error:unknown):void {try{this.onListenerError(error);}catch{/* Error reporting must not escape the bus. */}}
 subscribe(listener:(event:DomainEvent)=>void):()=>void {this.emitter.on('event',listener);return()=>this.emitter.off('event',listener);}
}
