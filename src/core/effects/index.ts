import {randomUUID} from 'node:crypto';
import {validateSyntax} from '../capabilities/index.js';
import {GatewayError,type ErrorDetail} from '../errors.js';
import type {DeviceState} from '../model.js';
import type {DeviceRegistry} from '../devices/index.js';
import type {AdapterRuntime} from '../../adapters/runtime.js';
import type {CoreStore} from '../operations/storage.js';
import {OperationService,publicError,rejected,type OperationEvents} from '../operations/index.js';
import type {DeviceResult,Operation,Target} from '../operations/types.js';
export interface Effect {id:string;name:string;requiredCapabilities:string[];minimumIntervalMs:number;parameters:Record<string,unknown>}
export interface EffectRun {id:string;effectId:string;deviceIds:string[];status:'starting'|'running'|'stopped'|'failed';startedAt:string;stoppedAt:string|null;effectiveIntervalMs:number;reason:string|null;deviceExecutions:{deviceId:string;status:EffectRun['status'];effectiveIntervalMs:number;droppedFrames:number;throttled:boolean;error?:ErrorDetail}[]}
interface Active {startOperationId?:string;lastResults:Map<string,DeviceResult>;run:EffectRun;controllers:Map<string,AbortController>;timers:Set<ReturnType<typeof setTimeout>>;pending:Set<Promise<unknown>>;stopping:boolean}
const names=['static','pulse','breathe','color-cycle','wave','chase','gradient'] as const;
export const EFFECT_IDS:Record<typeof names[number],string>={static:'00000000-0000-4000-8000-000000000001',pulse:'00000000-0000-4000-8000-000000000002',breathe:'00000000-0000-4000-8000-000000000003','color-cycle':'00000000-0000-4000-8000-000000000004',wave:'00000000-0000-4000-8000-000000000005',chase:'00000000-0000-4000-8000-000000000006',gradient:'00000000-0000-4000-8000-000000000007'};
export class EffectService {
 private active=new Map<string,Active>();
 constructor(private store:CoreStore,private registry:DeviceRegistry,private runtime:AdapterRuntime,private operations:OperationService,private bus:OperationEvents){
  for(const name of names)if(!store.get('effects',EFFECT_IDS[name]))store.put('effects',EFFECT_IDS[name],{id:EFFECT_IDS[name],name,requiredCapabilities:name==='pulse'?['brightness']:[],minimumIntervalMs:100,parameters:name==='static'?{type:'object',required:['state'],properties:{state:{type:'object'}},additionalProperties:false}:{type:'object',properties:{minimum:{type:'number',minimum:0,maximum:100},maximum:{type:'number',minimum:0,maximum:100},periodMs:{type:'integer',minimum:200}},additionalProperties:false}} satisfies Effect);

 }
 list():Effect[]{return this.store.list<Effect>('effects');}
 get(id:string):Effect{const effect=this.store.get<Effect>('effects',id);if(!effect)throw new GatewayError(404,'not_found','Effect not found');return effect;}
 runs():EffectRun[]{return this.store.list<EffectRun>('effect_runs');}
 getRun(id:string):EffectRun{const run=this.store.get<EffectRun>('effect_runs',id);if(!run)throw new GatewayError(404,'not_found','Effect run not found');return run;}
 private publish(active:Active,type:'effect.started'|'effect.updated'|'effect.stopped',correlationId:string|null=null):void{this.store.put('effect_runs',active.run.id,active.run);this.bus.publish(type,{type:'effect-run',id:active.run.id},{run:structuredClone(active.run)},correlationId);}
 start(effectId:string,target:Target,parameters:Record<string,unknown>={}):Operation{
  const effect=this.get(effectId);
  // TODO: Implement breathe/color-cycle/wave/chase/gradient generators with capability-aware frames.
  if(effect.name!=='static'&&effect.name!=='pulse')throw new GatewayError(422,'effect_not_implemented','Effect is not implemented');
  const ids=this.operations.resolve(target);if(!ids.length)throw new GatewayError(422,'no_eligible_targets','Target set is empty');
  const allowed=effect.name==='static'?['state']:['minimum','maximum','periodMs'];if(Object.keys(parameters).some(key=>!allowed.includes(key)))throw new GatewayError(422,'validation_error','Unknown effect parameter');
  const minimum=parameters.minimum??10,maximum=parameters.maximum??100,periodMs=parameters.periodMs??2000;
  if(effect.name==='pulse'&&(typeof minimum!=='number'||typeof maximum!=='number'||!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum<0||maximum>100||minimum>maximum||typeof periodMs!=='number'||!Number.isInteger(periodMs)||periodMs<200))throw new GatewayError(422,'validation_error','Invalid pulse parameters');
  const frame=(elapsed:number):DeviceState=>effect.name==='static'?structuredClone(parameters.state as DeviceState):{brightness:Math.floor(elapsed/(Number(periodMs)/2))%2===0?Number(maximum):Number(minimum)};
  if(effect.name==='static'&&(!parameters.state||typeof parameters.state!=='object'||Array.isArray(parameters.state)))throw new GatewayError(422,'validation_error','Static requires a state object');
  if(effect.name==='static'){validateSyntax(parameters.state);const state=parameters.state as DeviceState;if('effect'in state||state.segments?.some(s=>'effect'in s.state))throw new GatewayError(422,'validation_error','Static effects cannot start native effects');}
  const run:EffectRun={id:randomUUID(),effectId,deviceIds:ids,status:'starting',startedAt:new Date().toISOString(),stoppedAt:null,effectiveIntervalMs:1,reason:null,deviceExecutions:ids.map(deviceId=>{const {adapter,device}=this.registry.resolve(deviceId);const profile=adapter.scheduling;const interval=Math.ceil(Math.max(effect.minimumIntervalMs,profile.minUpdateIntervalMs,profile.estimatedLatencyMs,...profile.budgets.map(b=>b.windowMs/b.maxRequests),device.address?.transport==='cloud'?1000:1));return {deviceId,status:'starting',effectiveIntervalMs:interval,droppedFrames:0,throttled:interval>effect.minimumIntervalMs};})};run.effectiveIntervalMs=Math.max(...run.deviceExecutions.map(d=>d.effectiveIntervalMs));
  this.operations.reserve(ids,run.id);const active:Active={run,lastResults:new Map(),controllers:new Map(),timers:new Set(),pending:new Set(),stopping:false};
  try{this.store.put('effect_runs',run.id,run);this.active.set(run.id,active);const startOperation=this.operations.control('effect.start',{effectId,target,parameters},ids,async operation=>{
   operation.results=await Promise.all(run.deviceExecutions.map(async execution=>{const controller=new AbortController();active.controllers.set(execution.deviceId,controller);if(active.stopping)controller.abort();const work=this.operations.executeFrame({deviceId:execution.deviceId,command:{state:frame(0)}},operation.id,{ownerRunId:run.id,signal:controller.signal});active.pending.add(work);const result=await work;active.pending.delete(work);active.lastResults.set(execution.deviceId,result);execution.status=result.status==='failed'?'failed':'running';if(result.error)execution.error=result.error;return result;}));
   if(active.stopping)return;
   run.status=run.deviceExecutions.some(d=>d.status==='running')?'running':'failed';if(run.status==='failed'){run.reason='effect_start_failed';run.stoppedAt=new Date().toISOString();this.operations.release(run.id);this.active.delete(run.id);}this.publish(active,run.status==='running'?'effect.started':'effect.stopped',operation.id);
   if(run.status==='running'&&effect.name==='pulse')for(const execution of run.deviceExecutions)if(execution.status==='running')this.schedule(active,execution,frame,operation.id);
  },run.id);active.startOperationId=startOperation.id;return startOperation;}catch(error){this.operations.release(run.id);this.active.delete(run.id);this.store.delete('effect_runs',run.id);throw error;}
 }
 private schedule(active:Active,execution:EffectRun['deviceExecutions'][number],frame:(elapsed:number)=>DeviceState,operationId:string,waitMs=execution.effectiveIntervalMs):void{
  if(active.stopping)return;const timer=setTimeout(()=>{active.timers.delete(timer);if(active.stopping)return;const started=Date.now();const controller=active.controllers.get(execution.deviceId)!;
   const work=this.operations.executeFrame({deviceId:execution.deviceId,command:{state:frame(Date.now()-Date.parse(active.run.startedAt))}},operationId,{ownerRunId:active.run.id,signal:controller.signal}).then(result=>{active.lastResults.set(execution.deviceId,result);if(active.stopping)return;const elapsed=Date.now()-started;if(elapsed>execution.effectiveIntervalMs){execution.droppedFrames+=Math.floor(elapsed/execution.effectiveIntervalMs);execution.effectiveIntervalMs=elapsed;execution.throttled=true;}if(result.status==='failed'){execution.status='failed';execution.error=result.error??publicError(new Error());if(active.run.deviceExecutions.every(d=>d.status==='failed')){active.run.status='failed';active.run.reason='effect_frame_failed';active.run.stoppedAt=new Date().toISOString();this.operations.release(active.run.id);this.active.delete(active.run.id);this.publish(active,'effect.stopped');return;}}else this.schedule(active,execution,frame,operationId,Math.max(0,execution.effectiveIntervalMs-elapsed));active.run.effectiveIntervalMs=Math.max(...active.run.deviceExecutions.map(d=>d.effectiveIntervalMs));this.publish(active,'effect.updated');}).catch(error=>{execution.status='failed';execution.error=publicError(error);if(active.run.deviceExecutions.every(d=>d.status==='failed')){active.run.status='failed';active.run.reason='effect_frame_failed';active.run.stoppedAt=new Date().toISOString();this.operations.release(active.run.id);this.active.delete(active.run.id);this.publish(active,'effect.stopped');}else this.publish(active,'effect.updated');}).finally(()=>active.pending.delete(work));active.pending.add(work);
  },waitMs);timer.unref();active.timers.add(timer);
 }
 stop(id:string):Operation{const run=this.getRun(id);return this.operations.control('effect.stop',{runId:id},run.deviceIds,async operation=>{
  const active=this.active.get(id);let uncertain=new Set<string>();
  if(active){active.stopping=true;for(const timer of active.timers)clearTimeout(timer);for(const controller of active.controllers.values())controller.abort();if(active.startOperationId)await this.operations.wait(active.startOperationId);await Promise.allSettled([...active.pending]);uncertain=new Set([...active.lastResults].filter(([,r])=>r.fieldResults.some(f=>f.status==='unconfirmed')).map(([id])=>id));active.run.status='stopped';active.run.reason=uncertain.size?'scheduling_stopped_in_flight_delivery_unconfirmed':'stopped_by_request';active.run.stoppedAt=new Date().toISOString();for(const execution of active.run.deviceExecutions)execution.status='stopped';this.operations.release(id);this.active.delete(id);this.publish(active,'effect.stopped',operation.id);}
  operation.results=run.deviceIds.map(deviceId=>uncertain.has(deviceId)?{...rejected(deviceId,{code:'delivery_unconfirmed',message:'Scheduling stopped; an in-flight frame may have reached the device',requestId:operation.id,details:[]}),transport:active?.lastResults.get(deviceId)?.transport??null}:{deviceId,status:'succeeded',confirmation:'acknowledged',warnings:[],transport:null,fallback:null,fieldResults:[]});
 },id);}
 async close():Promise<void>{for(const id of [...this.active.keys()]){const op=this.stop(id);await this.operations.wait(op.id);}}
}
