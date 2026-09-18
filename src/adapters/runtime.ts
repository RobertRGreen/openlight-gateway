import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import { DomainBus } from '../core/events.js';
import { AdapterError } from './types.js';
import type { LightingAdapter, CallContext, AdapterEvent, RateBudget } from './types.js';
interface Bucket { times:number[]; active:number; next:number }
export class AdapterRuntime {
 private readonly adapters=new Map<string,LightingAdapter>();
 private readonly buckets=new Map<string,Bucket>();
 private readonly unavailable=new Map<string,number>();
 private readonly pending=new Map<string,number>();
 private readonly controllers=new Map<string,Set<AbortController>>();
 private readonly listeners=new Set<(id:string,event:AdapterEvent)=>void>();
 private readonly subscriptions=new Map<string,()=>void>();
 private readonly reconnect=new Map<string,{failures:number;retryAt:number}>();
 private readonly generations=new Map<string,number>();
 private readonly nextDeviceCall=new Map<string,number>();
 private readonly deviceTails=new Map<string,Promise<unknown>>();
 constructor(readonly bus:DomainBus,private readonly logger?:Logger,private readonly options:{timeoutMs?:number;maxQueue?:number}={}) {}
 get(id:string):LightingAdapter {const adapter=this.adapters.get(id);if(!adapter)throw new AdapterError('TRANSPORT_ERROR','Adapter not registered');return adapter;}
 list():LightingAdapter[]{return [...this.adapters.values()];}
 register(adapter:LightingAdapter):void {
  if(this.adapters.has(adapter.id))throw new Error('Duplicate adapter instance');this.adapters.set(adapter.id,adapter);this.subscribe(adapter);
 }
 private subscribe(adapter:LightingAdapter):void {
  if(this.subscriptions.has(adapter.id))return;
  try {this.subscriptions.set(adapter.id,adapter.onEvent(event=>{try {
   if(event.type==='error')this.quarantine(adapter.id,event.error);
   if(event.type==='connection') {if(event.connected)this.unavailable.delete(adapter.id);else this.unavailable.set(adapter.id,Infinity);this.bus.publish(event.connected?'adapter.connected':'adapter.disconnected',{type:'adapter',id:adapter.id},{adapterId:adapter.id,reason:event.connected?'connected':'disconnected'});}
   this.notify(adapter.id,event);
  }catch{this.quarantine(adapter.id,new AdapterError('TRANSPORT_ERROR','Adapter event processing failed'));}}));}catch{this.quarantine(adapter.id,new AdapterError('TRANSPORT_ERROR','Adapter subscription failed'));}
 }
 onEvent(listener:(id:string,event:AdapterEvent)=>void):()=>void {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 private notify(id:string,event:AdapterEvent):void {const report=()=>{try{this.logger?.error({adapter:id,errorCategory:'event_handler'},'Adapter event consumer failed');}catch{/* Reporting must not escape isolation. */}};for(const listener of this.listeners){try{const result:unknown=listener(id,event);if(result instanceof Promise)void result.catch(report);}catch{report();}}}
 private quarantine(id:string,error:AdapterError):void {this.unavailable.set(id,Infinity);this.bus.publish('adapter.error',{type:'adapter',id},{adapterId:id,reason:error.code});this.bus.publish('adapter.disconnected',{type:'adapter',id},{adapterId:id,reason:error.code});this.notify(id,{type:'connection',connected:false});}
 async connect(id:string):Promise<void> {const retry=this.reconnect.get(id);if(retry&&retry.retryAt>performance.now())throw new AdapterError('RATE_LIMITED','Reconnect backoff active',true,'not_sent',Math.ceil(retry.retryAt-performance.now()));try{this.subscribe(this.get(id));if(!this.subscriptions.has(id))throw new AdapterError('TRANSPORT_ERROR','Adapter subscription failed');await this.call(id,randomUUID(),null,c=>this.get(id).connect(c),{allowUnavailable:true});this.unavailable.delete(id);this.reconnect.delete(id);}catch(error){const failures=(retry?.failures??0)+1;this.reconnect.set(id,{failures,retryAt:performance.now()+Math.min(60000,1000*2**Math.min(failures-1,6))});throw error;}}
 async disconnect(id:string):Promise<void> {this.generations.set(id,(this.generations.get(id)??0)+1);for(const controller of this.controllers.get(id)??[])controller.abort();try{await this.call(id,randomUUID(),null,c=>this.get(id).disconnect(c),{allowUnavailable:true});}finally{this.subscriptions.get(id)?.();this.subscriptions.delete(id);this.unavailable.set(id,Infinity);}}
 async close():Promise<void>{await Promise.allSettled(this.list().map(adapter=>this.disconnect(adapter.id)));}
 call<T>(id:string,operationId:string,nativeId:string|null,fn:(context:CallContext)=>Promise<T>,options:{signal?:AbortSignal;timeoutMs?:number;correlationId?:string|null;allowUnavailable?:boolean}={}):Promise<T> {
  const queued=this.pending.get(id)??0;if(queued>=(this.options.maxQueue??256))return Promise.reject(new AdapterError('RATE_LIMITED','Adapter queue full',true));this.pending.set(id,queued+1);
  const key=`${id}:${nativeId??'session'}`;
  const generation=this.generations.get(id)??0;const admissionDeadline=performance.now()+(options.timeoutMs??this.options.timeoutMs??5000);
  const previous=this.deviceTails.get(key)??Promise.resolve();
  let executing=false;
  const execute=previous.catch(()=>{}).then(()=>{if((this.generations.get(id)??0)!==generation||options.signal?.aborted)throw new AdapterError('CANCELED','Queued call canceled');const remaining=admissionDeadline-performance.now();if(remaining<=0)throw new AdapterError('TIMEOUT','Queue deadline exceeded',true);executing=true;return this.execute(id,operationId,nativeId,fn,{...options,timeoutMs:remaining});});
  this.deviceTails.set(key,execute);
  void execute.finally(()=>{this.pending.set(id,(this.pending.get(id)??1)-1);if(this.deviceTails.get(key)===execute)this.deviceTails.delete(key);}).catch(()=>{});
  return new Promise<T>((resolve,reject)=>{const timeout=setTimeout(()=>{if(!executing)reject(new AdapterError('TIMEOUT','Queue deadline exceeded',true,'not_sent'));},Math.max(1,admissionDeadline-performance.now()));const abort=()=>{if(!executing)reject(new AdapterError('CANCELED','Queued call canceled'));};options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();execute.then(resolve,reject).finally(()=>{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}).catch(()=>{});});
 }
 private async execute<T>(id:string,operationId:string,nativeId:string|null,fn:(context:CallContext)=>Promise<T>,options:{signal?:AbortSignal;timeoutMs?:number;correlationId?:string|null;allowUnavailable?:boolean}):Promise<T> {
  const adapter=this.get(id);if(!options.allowUnavailable&&(this.unavailable.get(id)??0)>Date.now())throw new AdapterError('TRANSPORT_ERROR','Adapter unavailable',true);
  const controller=new AbortController();const set=this.controllers.get(id)??new Set<AbortController>();set.add(controller);this.controllers.set(id,set);
  const timeoutMs=options.timeoutMs??this.options.timeoutMs??5000;
  const started=performance.now();const context:CallContext={operationId,correlationId:options.correlationId??operationId,signal:controller.signal,deadlineAt:Date.now()+timeoutMs};
  const external=()=>controller.abort();options.signal?.addEventListener('abort',external,{once:true});if(options.signal?.aborted)controller.abort();
  let dispatched=false;let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  let release=()=>{};let abortListener:(()=>void)|undefined;
  const cancellation=new Promise<never>((_,reject)=>{abortListener=()=>reject(new AdapterError(timedOut?'TIMEOUT':'CANCELED',timedOut?'Adapter deadline exceeded':'Adapter call canceled',timedOut,dispatched?'unknown':'not_sent'));if(controller.signal.aborted)abortListener();else controller.signal.addEventListener('abort',abortListener,{once:true});});
  try {
   const work=(async()=>{release=await this.acquire(adapter,nativeId,controller.signal);controller.signal.throwIfAborted();dispatched=true;return await fn(context);})();
   const result=await Promise.race([work,cancellation]);
   this.logger?.debug({adapter:id,device:nativeId,operation:operationId,latency:performance.now()-started,success:true},'Adapter call');return result;
  }catch(error){const normalized=error instanceof AdapterError?error:controller.signal.aborted?new AdapterError(timedOut?'TIMEOUT':'CANCELED','Adapter call interrupted',timedOut,dispatched?'unknown':'not_sent'):new AdapterError('TRANSPORT_ERROR','Adapter call failed',true,dispatched?'unknown':'not_sent');if(normalized.code==='TIMEOUT'||normalized.code==='TRANSPORT_ERROR'||normalized.code==='AUTH_FAILED')this.quarantine(id,normalized);if(normalized.code==='RATE_LIMITED'){for(const budget of adapter.scheduling.budgets){const bucket=this.buckets.get(this.budgetKey(adapter.id,nativeId,budget));if(bucket)bucket.next=Math.max(bucket.next,performance.now()+(normalized.retryAfterMs??1000));}}
   this.logger?.warn({adapter:id,device:nativeId,operation:operationId,latency:performance.now()-started,success:false,errorCategory:normalized.code},'Adapter call failed');throw normalized;
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',external);if(abortListener)controller.signal.removeEventListener('abort',abortListener);release();set.delete(controller);}
 }
 private budgetKey(id:string,nativeId:string|null,budget:RateBudget):string {return budget.scope==='account'?`account:${budget.key}`:budget.scope==='device'?`${id}:${nativeId??'session'}:${budget.key}`:`${id}:${budget.key}`;}
 private async acquire(adapter:LightingAdapter,nativeId:string|null,signal:AbortSignal):Promise<()=>void> {
  const specs=(adapter.scheduling.budgetManagement==='adapter'?[]:adapter.scheduling.budgets).map(budget=>{const key=this.budgetKey(adapter.id,nativeId,budget);const bucket=this.buckets.get(key)??{times:[],active:0,next:0};this.buckets.set(key,bucket);return{budget,bucket};});
  const deviceKey=`${adapter.id}:${nativeId??'session'}`;
  while(true){signal.throwIfAborted();const now=performance.now();let wait=Math.max(0,(this.nextDeviceCall.get(deviceKey)??0)-now);
   for(const {budget,bucket} of specs){bucket.times=bucket.times.filter(t=>t>now-budget.windowMs);if(bucket.active>=budget.maxConcurrent)wait=Math.max(wait,5);if(bucket.times.length>=budget.maxRequests)wait=Math.max(wait,(bucket.times[0]??now)+budget.windowMs-now);wait=Math.max(wait,bucket.next-now);const burstWindow=budget.windowMs/Math.max(1,budget.maxRequests)*Math.max(1,budget.burst);const recent=bucket.times.filter(t=>t>now-burstWindow);if(recent.length>=budget.burst)wait=Math.max(wait,(recent[0]??now)+burstWindow-now);}
   if(wait<=0){this.nextDeviceCall.set(deviceKey,now+adapter.scheduling.minUpdateIntervalMs);for(const {bucket}of specs){bucket.active++;bucket.times.push(now);}return()=>{for(const {bucket}of specs)bucket.active--;};}
   await delay(Math.max(1,wait),undefined,{signal});
  }
 }
}
