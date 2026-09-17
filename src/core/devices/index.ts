import { redactSecrets } from '../../security/index.js';
import { randomUUID } from 'node:crypto';
import type { Device, DeviceState, Availability, Capability, StateSnapshot } from '../model.js';
import type { AdapterDevice, Observation } from '../../adapters/types.js';
import { AdapterError } from '../../adapters/types.js';
import { AdapterRuntime } from '../../adapters/runtime.js';
import { DomainBus } from '../events.js';
import { GatewayError } from '../errors.js';
interface RegistryStore {identity(adapterId:string,nativeId:string):string;identities():{adapterId:string;nativeId:string;deviceId:string}[];get<T>(collection:'device_snapshots',id:string):T|undefined;put(collection:'device_snapshots',id:string,value:unknown):void}
export class DeviceRegistry {
 private readonly devices=new Map<string,Device>();private readonly identities=new Map<string,{adapterId:string;nativeId:string}>();
 private readonly desiredStates=new Map<string,{state:DeviceState;operationId:string}>();private readonly generations=new Map<string,number>();private readonly sequences=new Map<string,string>();
 private readonly capabilityRefreshes=new Map<string,Promise<void>>();
 private readonly refreshes=new Map<string,Promise<void>>();private readonly timers=new Map<string,ReturnType<typeof setTimeout>>();private readonly unsubscribe:()=>void;private stopped=false;private polling=false;
 constructor(private readonly store:RegistryStore,readonly runtime:AdapterRuntime,readonly bus:DomainBus) {
  for(const identity of store.identities()){this.identities.set(identity.deviceId,identity);const prior=store.get<Device>('device_snapshots',identity.deviceId);if(prior)this.devices.set(identity.deviceId,{...prior,availability:'unknown',stateStale:true});}
  this.unsubscribe=runtime.onEvent((adapterId,event)=>{
   if(event.type==='connection'&&event.connected){for(const [id,identity] of this.identities)if(identity.adapterId===adapterId){this.sequences.delete(id);if(this.devices.has(id))void this.refreshCapabilities(id);}}
   if(event.type==='connection'&&!event.connected){for(const device of this.devices.values())if(device.adapter===adapterId)this.availability(device.id,'unknown','adapter_disconnected');return;}
   if(event.type==='connection'||event.type==='error')return;
   const id=[...this.identities.entries()].find(([,identity])=>identity.adapterId===adapterId&&identity.nativeId===event.nativeId)?.[0];if(!id)return;
   if(event.type==='observation')this.observe(id,event.observation);else if(event.type==='availability')this.availability(id,event.status,'adapter_report');else this.setCapabilities(id,event.capabilities);
  });
 }
 list():Device[]{return structuredClone([...this.devices.values()]);}
 get(id:string):Device {const device=this.devices.get(id);if(!device)throw new GatewayError(404,'not_found','Device not found');return structuredClone(device);}
 resolve(id:string){const device=this.get(id);const identity=this.identities.get(id);if(!identity)throw new GatewayError(404,'not_found','Device identity not found');return{device,adapter:this.runtime.get(identity.adapterId),nativeId:identity.nativeId};}
 snapshot(id:string):StateSnapshot{const device=this.get(id);return{state:device.state,observedAt:device.stateObservedAt,stale:device.stateStale,revision:device.revision};}
 private save(device:Device):void {this.store.put('device_snapshots',device.id,device);}
 update(id:string,patch:{name?:string}):Device {const device=this.devices.get(id);if(!device)throw new GatewayError(404,'not_found','Device not found');const next={...device,...(patch.name===undefined?{}:{name:patch.name})};this.save(next);this.devices.set(id,next);return this.get(id);}
 applyPersistedMetadata(id:string,patch:{name?:string;room?:string|null;groups?:string[]}):void{const device=this.devices.get(id);if(!device)throw new GatewayError(404,'not_found','Device not found');Object.assign(device,structuredClone(patch));}
 setMembership(id:string,room:string|null,groups:string[]):void{const device=this.devices.get(id);if(!device)throw new GatewayError(404,'not_found','Device not found');const next={...device,room,groups:[...groups]};this.save(next);this.devices.set(id,next);}
 desired(id:string,state:DeviceState,operationId:string):void {this.get(id);this.desiredStates.set(id,{state:structuredClone(state),operationId});}
 getDesired(id:string):{state:DeviceState;operationId:string}|undefined {return structuredClone(this.desiredStates.get(id));}
 revisionToken(id:string):number{return this.generations.get(id)??0;}
 completeWrite(id:string):void{this.generations.set(id,this.revisionToken(id)+1);this.desiredStates.delete(id);}
 observe(id:string,observation:Observation,operationId?:string,expectedRevision?:number):boolean {
  const device=this.devices.get(id);if(!device)return false;if(expectedRevision!==undefined&&this.revisionToken(id)!==expectedRevision)return false;
  const previous=this.sequences.get(id);if(previous!==undefined&&observation.nativeSequence!==undefined){if(previous===observation.nativeSequence)return false;if(/^\d+$/.test(previous)&&/^\d+$/.test(observation.nativeSequence)&&BigInt(observation.nativeSequence)<BigInt(previous))return false;}
  if(observation.nativeSequence!==undefined)this.sequences.set(id,observation.nativeSequence);
  device.state={...device.state,...structuredClone(observation.state)};device.stateObservedAt=new Date().toISOString();device.stateStale=false;device.revision++;this.generations.set(id,this.revisionToken(id)+1);this.availability(id,'online','observation');this.save(device);this.bus.publish('device.state_changed',{type:'device',id},this.snapshot(id),operationId);return true;
 }
 availability(id:string,status:Availability,reason:string):void {const device=this.devices.get(id);if(!device)return;const changed=device.availability!==status;const staleChanged=status!=='online'&&!device.stateStale;device.availability=status;if(status!=='online')device.stateStale=true;if(staleChanged)device.revision++;this.save(device);if(changed)this.bus.publish(status==='online'?'device.connected':'device.disconnected',{type:'device',id},{availability:status,reason});if(staleChanged)this.bus.publish('device.state_changed',{type:'device',id},this.snapshot(id));}
 setCapabilities(id:string,capabilities:Capability[]):void{const device=this.devices.get(id);if(!device)return;const adapter=this.runtime.get(device.adapter);if(new Set(capabilities.map(c=>c.type)).size!==capabilities.length)throw new AdapterError('TRANSPORT_ERROR','Duplicate capability descriptor');for(const capability of capabilities){if((capability.type==='effects'&&!adapter.effects)||(capability.type==='transitions'&&!adapter.transitions)||(capability.type==='segments'&&!adapter.segments))throw new AdapterError('TRANSPORT_ERROR','Advertised operation is not implemented');if((capability.type==='brightness'||capability.type==='colorTemperature')&&(!Number.isFinite(capability.minimum)||!Number.isFinite(capability.maximum)||!Number.isFinite(capability.step)||capability.step<=0||capability.minimum>capability.maximum))throw new AdapterError('TRANSPORT_ERROR','Invalid numeric capability');}if(JSON.stringify(device.capabilities)===JSON.stringify(capabilities))return;device.capabilities=structuredClone(capabilities);this.save(device);this.bus.publish('device.capabilities_changed',{type:'device',id},{capabilities});}
 async discover(adapterId:string,operationId:string=randomUUID()):Promise<Device[]> {
  const adapter=this.runtime.get(adapterId);
  const inventory=await this.runtime.call(adapterId,operationId,null,async context=>{const found:AdapterDevice[]=[];for await(const device of adapter.discover(context)){if(context.signal.aborted)break;if(found.length>=10000)throw new AdapterError('RATE_LIMITED','Discovery inventory limit reached');found.push(device);}return found;});
  const discovered:Device[]=[];
  for(const candidate of inventory){const native=structuredClone(candidate);native.extensions=safeExtensions(native.extensions);const endpoint=native.address?.endpoint;if(native.address&&endpoint){try{const parsed=new URL(endpoint);if(parsed.username||parsed.password||parsed.search||parsed.hash)native.address.endpoint=null;}catch{if(/[?@#]/.test(endpoint))native.address.endpoint=null;}}const id=this.store.identity(adapterId,native.nativeId);this.identities.set(id,{adapterId,nativeId:native.nativeId});let device=this.devices.get(id);
   if(!device){device={id,name:native.name,manufacturer:native.manufacturer,model:native.model,adapter:adapterId,address:native.address,room:null,groups:[],capabilities:[],state:{},stateObservedAt:null,stateStale:true,revision:0,availability:'unknown',metadata:{extensions:native.extensions}};this.devices.set(id,device);}
   else{device.address=structuredClone(native.address);device.metadata={extensions:structuredClone(native.extensions)};}
   this.setCapabilities(id,await this.runtime.call(adapterId,operationId,native.nativeId,c=>adapter.getCapabilities(native.nativeId,c)));
   this.save(device);this.bus.publish('device.discovered',{type:'device',id},{device:this.get(id)},operationId);await this.refresh(id);discovered.push(this.get(id));if(this.polling)this.schedule(id);
  }
  return discovered;
 }
 refreshCapabilities(id:string):Promise<void>{const pending=this.capabilityRefreshes.get(id);if(pending)return pending;if(this.stopped)return Promise.resolve();const work=(async()=>{const {device,adapter,nativeId}=this.resolve(id);try{const capabilities=await this.runtime.call(device.adapter,randomUUID(),nativeId,c=>adapter.getCapabilities(nativeId,c));if(!this.stopped)this.setCapabilities(id,capabilities);}catch{this.availability(id,'unknown','capability_refresh_failed');}})().catch(()=>{}).finally(()=>this.capabilityRefreshes.delete(id));this.capabilityRefreshes.set(id,work);return work;}
 refresh(id:string):Promise<void> {const existing=this.refreshes.get(id);if(existing)return existing;if(this.stopped)return Promise.resolve();const work=this.doRefresh(id).finally(()=>this.refreshes.delete(id));this.refreshes.set(id,work);return work;}
 private async doRefresh(id:string):Promise<void> {const {device,adapter,nativeId}=this.resolve(id);const token=this.revisionToken(id);try{const observation=await this.runtime.call(device.adapter,randomUUID(),nativeId,c=>adapter.getState(nativeId,c));this.observe(id,observation,undefined,token);}catch(error){this.availability(id,error instanceof AdapterError&&error.code==='OFFLINE'?'offline':'unknown','refresh_failed');}}
 startPolling():void{this.stopped=false;this.polling=true;for(const device of this.devices.values()){try{this.schedule(device.id);}catch{this.availability(device.id,'unknown','adapter_not_registered');}}}
 private schedule(id:string):void{if(this.stopped||this.timers.has(id))return;const adapter=this.resolve(id).adapter;const period=Math.max(100,adapter.scheduling.recommendedPollIntervalMs);const jitter=0.9+(id.charCodeAt(0)%21)/100;const timer=setTimeout(()=>{this.timers.delete(id);const device=this.devices.get(id);if(device&&device.stateObservedAt&&Date.now()-Date.parse(device.stateObservedAt)>=period){device.stateStale=true;device.revision++;this.save(device);this.bus.publish('device.state_changed',{type:'device',id},this.snapshot(id));}void this.refresh(id).catch(()=>{}).finally(()=>{if(!this.stopped)this.schedule(id);}).catch(()=>{});},period*jitter);timer.unref();this.timers.set(id,timer);}
 async close():Promise<void>{this.stopped=true;this.polling=false;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();this.unsubscribe();await Promise.allSettled([...this.refreshes.values(),...this.capabilityRefreshes.values()]);}
}
export type { Device } from '../model.js';

function safeExtensions(extensions:Record<string,Record<string,unknown>>):Record<string,Record<string,unknown>> {const result:Record<string,Record<string,unknown>>={};for(const [namespace,value]of Object.entries(extensions)){if(!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(namespace))continue;try{const clean=JSON.parse(JSON.stringify(redactSecrets(value))) as Record<string,unknown>;if(JSON.stringify(clean).length<=16384&&Object.keys(result).length<16)result[namespace]=clean;}catch{/* Ignore invalid or unbounded metadata. */}}return result;}
