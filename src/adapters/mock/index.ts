import { setTimeout as delay } from 'node:timers/promises';
import type { Capability, DeviceState } from '../../core/model.js';
import { validateState } from '../../core/capabilities/index.js';
import { GatewayError } from '../../core/errors.js';
import { AdapterError } from '../types.js';
import type { LightingAdapter, SchedulingProfile, AdapterDevice, AdapterEvent, CallContext, Color, Observation, WriteReceipt } from '../types.js';
const power:Capability={type:'power'};
const brightness:Capability={type:'brightness',minimum:0,maximum:100,step:1};
const temperature:Capability={type:'colorTemperature',minimum:2200,maximum:6500,step:100};
const definitions:{nativeId:string;name:string;capabilities:Capability[];state:DeviceState}[]=[
 {nativeId:'rgb',name:'Mock RGB bulb',capabilities:[power,brightness,{type:'rgb'},temperature],state:{power:false,brightness:50,rgb:{r:255,g:255,b:255},colorTemperature:2700}},
 {nativeId:'temperature',name:'Mock temperature bulb',capabilities:[power,brightness,temperature],state:{power:false,brightness:50,colorTemperature:2700}},
 {nativeId:'white',name:'Mock dimmable white bulb',capabilities:[power,brightness],state:{power:false,brightness:50}},
 {nativeId:'rgbw',name:'Mock RGBW device',capabilities:[power,brightness,{type:'rgbw'}],state:{power:false,brightness:50,rgbw:{r:0,g:0,b:0,w:255}}},
 {nativeId:'offline',name:'Mock offline bulb',capabilities:[power,brightness],state:{}}
];
export class MockAdapter implements LightingAdapter {
 readonly scheduling:SchedulingProfile;
 private readonly listeners=new Set<(event:AdapterEvent)=>void>(); private connected=false;
 private readonly devices=structuredClone(definitions); private sequence=0;
 readonly id:string; readonly latencyMs:number;
 constructor(options:{id?:string;latencyMs?:number}={}) {this.id=options.id??'mock';this.latencyMs=options.latencyMs??0;if(!Number.isFinite(this.latencyMs)||this.latencyMs<0)throw new RangeError('Invalid mock latency');this.scheduling={budgets:[{scope:'adapter',key:this.id,maxRequests:1000,windowMs:1000,burst:100,maxConcurrent:8}],minUpdateIntervalMs:10,estimatedLatencyMs:this.latencyMs,recommendedPollIntervalMs:30000};}
 onEvent(listener:(event:AdapterEvent)=>void):()=>void {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 private emit(event:AdapterEvent):void {for(const listener of this.listeners) {try{listener(event);}catch{/* Isolate consumer callbacks. */}}}
 private async wait(context:CallContext):Promise<void> {if(context.signal.aborted) throw new AdapterError('CANCELED','Call canceled'); if(this.latencyMs>0) {try{await delay(this.latencyMs,undefined,{signal:context.signal});}catch{throw new AdapterError('CANCELED','Call canceled');}} if(Date.now()>context.deadlineAt) throw new AdapterError('TIMEOUT','Deadline exceeded',true,'unknown');}
 async connect(context:CallContext):Promise<void> {await this.wait(context);this.connected=true;this.emit({type:'connection',connected:true});}
 async disconnect(context:CallContext):Promise<void> {await this.wait(context);this.connected=false;this.emit({type:'connection',connected:false});}
 async getDevices(context:CallContext):Promise<readonly AdapterDevice[]> {await this.wait(context);return this.devices.map(d=>({nativeId:d.nativeId,name:d.name,manufacturer:'OpenLight',model:d.nativeId,address:{transport:'mock',endpoint:null},extensions:{}}));}
 async *discover(context:CallContext):AsyncIterable<AdapterDevice> {for(const device of await this.getDevices(context)) {if(context.signal.aborted)return;yield device;}}
 private device(id:string) {const device=this.devices.find(d=>d.nativeId===id);if(!device)throw new AdapterError('OFFLINE','Device unavailable');return device;}
 async getCapabilities(id:string,context:CallContext):Promise<Capability[]> {await this.wait(context);return structuredClone(this.device(id).capabilities);}
 async getState(id:string,context:CallContext):Promise<Observation> {await this.wait(context);const device=this.device(id);if(id==='offline'||!this.connected)throw new AdapterError('OFFLINE','Device offline',true);return {state:structuredClone(device.state),observedAt:new Date().toISOString(),complete:true,nativeSequence:String(++this.sequence)};}
 private async write(id:string,state:DeviceState,context:CallContext):Promise<WriteReceipt> {
  await this.wait(context);const device=this.device(id);
  if(id==='offline'||!this.connected)throw new AdapterError('OFFLINE','Device offline',true);
  try{validateState(device.capabilities,state,id,context.operationId);}catch(error){if(error instanceof GatewayError)throw new AdapterError(error.code==='capability_mismatch'?'UNSUPPORTED_CAPABILITY':'OUT_OF_RANGE',error.message);throw error;}
  device.state={...device.state,...structuredClone(state)};
  const observation:Observation={state:structuredClone(device.state),observedAt:new Date().toISOString(),complete:true,nativeSequence:String(++this.sequence)};
  // Receipt readback is authoritative for this simulated physical state; no fabricated external observation.
  return {transport:'mock',acknowledgment:'applied',observation};
 }
 setPower(id:string,on:boolean,context:CallContext):Promise<WriteReceipt>{return this.write(id,{power:on},context);}
 setBrightness(id:string,percent:number,context:CallContext):Promise<WriteReceipt>{return this.write(id,{brightness:percent},context);}
 setColor(id:string,color:Color,context:CallContext):Promise<WriteReceipt>{return this.write(id,{[color.mode]:color.value},context);}
 setTemperature(id:string,kelvin:number,context:CallContext):Promise<WriteReceipt>{return this.write(id,{colorTemperature:kelvin},context);}
}
