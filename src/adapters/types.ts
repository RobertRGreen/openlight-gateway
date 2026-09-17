import type { Capability, DeviceState, SegmentState, RGB, RGBW, RGBWW, Transport } from '../core/model.js';
export type { Capability, DeviceState, SegmentState, Transport } from '../core/model.js';
export type NativeDeviceId = string;
export type Color = {mode:'rgb';value:RGB} | {mode:'rgbw';value:RGBW} | {mode:'rgbww';value:RGBWW};
export interface CallContext {operationId:string; correlationId:string|null; signal:AbortSignal; deadlineAt:number}
export interface AdapterDevice {nativeId:string;name:string;manufacturer:string;model:string|null;address:{transport:Transport;endpoint:string|null}|null;extensions:Record<string,Record<string,unknown>>}
export interface Observation {state:DeviceState;observedAt:string;complete:boolean;nativeSequence?:string}
export interface WriteReceipt {transport:Transport;acknowledgment:'accepted'|'applied';observation?:Observation}
export interface RateBudget {scope:'adapter'|'account'|'device';key:string;maxRequests:number;windowMs:number;burst:number;maxConcurrent:number}
export interface SchedulingProfile {budgets:readonly RateBudget[];minUpdateIntervalMs:number;estimatedLatencyMs:number;recommendedPollIntervalMs:number}
export type AdapterErrorCode = 'OFFLINE'|'UNSUPPORTED_CAPABILITY'|'OUT_OF_RANGE'|'AUTH_FAILED'|'RATE_LIMITED'|'TIMEOUT'|'CANCELED'|'TRANSPORT_ERROR';
export class AdapterError extends Error {
  constructor(readonly code:AdapterErrorCode,message:string,readonly retryable=false,readonly delivery:'not_sent'|'unknown'|'acknowledged'='not_sent',readonly retryAfterMs?:number) {super(message);this.name='AdapterError';}
}
export type AdapterEvent = {type:'observation';nativeId:string;observation:Observation}|{type:'availability';nativeId:string;status:'online'|'offline'|'unknown'}|{type:'capabilities';nativeId:string;capabilities:Capability[]}|{type:'connection';connected:boolean}|{type:'error';error:AdapterError};
export interface LightingAdapter {
 readonly id:string; readonly scheduling:SchedulingProfile;
 onEvent(listener:(event:AdapterEvent)=>void):()=>void;
 discover(context:CallContext):AsyncIterable<AdapterDevice>;
 connect(context:CallContext):Promise<void>; disconnect(context:CallContext):Promise<void>;
 getDevices(context:CallContext):Promise<readonly AdapterDevice[]>;
 getCapabilities(id:string,context:CallContext):Promise<Capability[]>;
 getState(id:string,context:CallContext):Promise<Observation>;
 setPower(id:string,on:boolean,context:CallContext):Promise<WriteReceipt>;
 setBrightness(id:string,percent:number,context:CallContext):Promise<WriteReceipt>;
 setColor(id:string,color:Color,context:CallContext):Promise<WriteReceipt>;
 setTemperature(id:string,kelvin:number,context:CallContext):Promise<WriteReceipt>;
 effects?:{start(id:string,effectId:string,context:CallContext):Promise<WriteReceipt>;stop(id:string,context:CallContext):Promise<WriteReceipt>};
 transitions?:{apply(id:string,state:DeviceState,durationMs:number,context:CallContext):Promise<WriteReceipt>};
 segments?:{apply(id:string,values:readonly {id:string;state:SegmentState}[],context:CallContext):Promise<WriteReceipt>};
}
