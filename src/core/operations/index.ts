import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { GatewayError, type ErrorDetail } from '../errors.js';
import type { DeviceState } from '../model.js';
import { validateState } from '../capabilities/index.js';
import type { DeviceRegistry } from '../devices/index.js';
import type { AdapterRuntime } from '../../adapters/runtime.js';
import { AdapterError, type CallContext, type WriteReceipt } from '../../adapters/types.js';
import type { CoreStore } from './storage.js';
import type { Command, DeviceResult, Operation, PreparedTarget, Target } from './types.js';
export type { Command, DeviceResult, Operation, PreparedTarget, Target } from './types.js';
export type OperationEvents = Pick<import('../events.js').DomainBus,'publish'>;
export interface SubmitOptions {requestId?:string;transitionMs?:number;ownerRunId?:string;signal?:AbortSignal}
export function publicError(error:unknown,requestId='core'):ErrorDetail {
  if(error instanceof GatewayError)return error.detail;
  if(error instanceof AdapterError){const codes:Record<string,string>={OFFLINE:'device_offline',UNSUPPORTED_CAPABILITY:'capability_mismatch',OUT_OF_RANGE:'validation_error',AUTH_FAILED:'adapter_auth_failed',RATE_LIMITED:'rate_limited',TIMEOUT:'adapter_timeout',CANCELED:'operation_canceled',TRANSPORT_ERROR:'transport_error'};return {code:codes[error.code]??'adapter_error',message:'Adapter command failed',requestId,details:[]};}
  return {code:'internal_error',message:'Command execution failed',requestId,details:[]};
}
export function rejected(deviceId:string,error:ErrorDetail):DeviceResult {return {deviceId,status:'failed',confirmation:'unconfirmed',warnings:[],transport:null,fallback:null,fieldResults:[],error};}
export class OperationService {
  private tails=new Map<string,Promise<unknown>>();private pending=new Map<string,Promise<Operation>>();private reservations=new Map<string,string>();private groups:(id:string)=>string[]=()=>{throw new GatewayError(404,'not_found','Group not found');};private closing=false;
  constructor(private store:CoreStore,readonly registry:DeviceRegistry,readonly runtime:AdapterRuntime,private bus:OperationEvents,private logger?:Logger,private options:{maxPending?:number}={}){}
  setGroupResolver(resolve:(id:string)=>string[]):void{this.groups=resolve;}
  resolve(target:Target):string[]{if(target.type==='device'){this.registry.get(target.id);return [target.id];}return [...this.groups(target.id)];}
  get(id:string):Operation {const operation=this.store.getOperation<Operation>(id);if(!operation)throw new GatewayError(404,'not_found','Operation not found');return operation;}
  async wait(id:string):Promise<Operation>{return structuredClone(await (this.pending.get(id)??Promise.resolve(this.get(id))));}
  assertUnreserved(ids:string[],owner?:string):void {if(ids.some(id=>this.reservations.has(id)&&this.reservations.get(id)!==owner))throw new GatewayError(409,'effect_conflict','An active effect reserves a target device');}
  reserve(ids:string[],runId:string):void{this.assertUnreserved(ids);for(const id of ids)this.reservations.set(id,runId);}
  release(runId:string):void{for(const [id,owner]of this.reservations)if(owner===runId)this.reservations.delete(id);}
  submitCommand(target:Target,state:DeviceState,opts:SubmitOptions={}):Operation {const command:Command={state,...(opts.transitionMs===undefined?{}:{transitionMs:opts.transitionMs})};const ids=this.resolve(target);return this.submitPrepared(target.type==='device'?'device.command':'group.command',command as unknown as Record<string,unknown>,ids.map(deviceId=>({deviceId,command})),opts);}
  submitPrepared(kind:Operation['kind'],request:Record<string,unknown>,targets:PreparedTarget[],opts:SubmitOptions={}):Operation {
    if(this.closing)throw new GatewayError(503,'gateway_stopping','Gateway is stopping');
    if(this.pending.size>=(this.options.maxPending??1000))throw new GatewayError(429,'rate_limited','Operation queue is full');
    if(!targets.length)throw new GatewayError(422,'no_eligible_targets','Target set is empty');
    if(new Set(targets.map(t=>t.deviceId)).size!==targets.length)throw new GatewayError(422,'overlapping_targets','Expanded targets overlap');
    this.assertUnreserved(targets.map(t=>t.deviceId),opts.ownerRunId);
    const frozen=structuredClone(targets);for(const t of frozen){if(t.rejection)continue;try{const d=this.registry.get(t.deviceId);validateState(d.capabilities,t.command.state,t.deviceId,opts.requestId,t.command.transitionMs);if(d.availability==='offline')throw new GatewayError(409,'device_offline','Device is offline',[],opts.requestId);}catch(error){if(kind==='device.command')throw error;t.rejection=publicError(error,opts.requestId);}}
    if(frozen.every(t=>t.rejection))throw new GatewayError(422,'no_eligible_targets','No target can execute',frozen.flatMap(t=>t.rejection?.details.length?t.rejection.details:[{path:'/state',code:t.rejection?.code??'failed',message:t.rejection?.message??'Failed',deviceId:t.deviceId}]),opts.requestId);
    const operation:Operation={id:randomUUID(),kind,status:'queued',createdAt:new Date().toISOString(),completedAt:null,request:structuredClone(request),targetDeviceIds:frozen.map(t=>t.deviceId),results:[]};
    this.store.saveOperation(operation);
    const work=Promise.resolve().then(async()=>{operation.status='running';this.store.saveOperation(operation);const tasks=frozen.map(t=>this.serial(t.deviceId,()=>this.execute(t,operation.id,opts)));operation.results=await Promise.all(tasks);return this.finish(operation);}).catch(error=>{operation.results=operation.targetDeviceIds.map(id=>rejected(id,publicError(error,opts.requestId)));return this.finish(operation);}).finally(()=>this.pending.delete(operation.id));
    this.pending.set(operation.id,work);return structuredClone(operation);
  }
  private serial<T>(id:string,fn:()=>Promise<T>):Promise<T>{const work=(this.tails.get(id)??Promise.resolve()).catch(()=>undefined).then(fn);this.tails.set(id,work);void work.finally(()=>{if(this.tails.get(id)===work)this.tails.delete(id);}).catch(()=>undefined);return work;}
  private finish(operation:Operation):Operation {const successes=operation.results.filter(r=>r.status!=='failed').length;operation.status=successes===0?'failed':operation.results.every(r=>r.status==='succeeded')?'succeeded':'partial';operation.completedAt=new Date().toISOString();this.store.saveOperation(operation);this.bus.publish('operation.completed',{type:'operation',id:operation.id},{operation:structuredClone(operation)},operation.id);return operation;}
  executeFrame(target:PreparedTarget,operationId:string,opts:SubmitOptions={}):Promise<DeviceResult>{return this.serial(target.deviceId,()=>this.execute(target,operationId,opts));}
  async execute(target:PreparedTarget,operationId:string,opts:SubmitOptions={}):Promise<DeviceResult> {
    if(target.rejection)return rejected(target.deviceId,target.rejection);
    const started=Date.now();const result:DeviceResult={deviceId:target.deviceId,status:'succeeded',confirmation:'unconfirmed',warnings:target.warnings??[],transport:null,fallback:null,fieldResults:[]};
    try {
      if(opts.signal?.aborted)throw new AdapterError('CANCELED','Canceled');
      const {device,adapter,nativeId}=this.registry.resolve(target.deviceId);const {state,transitionMs}=target.command;
      validateState(device.capabilities,state,device.id,opts.requestId,transitionMs);
      if(device.availability==='offline')throw new GatewayError(409,'device_offline','Device is offline',[],opts.requestId);
      if(device.availability==='unknown'){await this.registry.refresh(device.id);if(this.registry.get(device.id).availability!=='online')throw new GatewayError(409,'device_offline','Device could not be reached',[],opts.requestId);}
      this.registry.desired(device.id,state,operationId);
      const unavailableCapability=(capability:string,path:string)=>new GatewayError(422,'capability_mismatch',`Device does not support ${capability}`,[{path,code:'unsupported_capability',message:`Required capability ${capability} is absent`,deviceId:device.id,capability}],opts.requestId);
      const calls:{paths:string[];call:(ctx:CallContext)=>Promise<WriteReceipt>}[]=[];
      if(transitionMs!==undefined){if(!adapter.transitions)throw unavailableCapability('transitions','/transitionMs');calls.push({paths:Object.keys(state).map(k=>`/${k}`),call:ctx=>adapter.transitions!.apply(nativeId,state,transitionMs,ctx)});}
      else {
        if(state.power!==undefined)calls.push({paths:['/power'],call:ctx=>adapter.setPower(nativeId,state.power!,ctx)});
        if(state.brightness!==undefined)calls.push({paths:['/brightness'],call:ctx=>adapter.setBrightness(nativeId,state.brightness!,ctx)});
        if(state.rgb)calls.push({paths:['/rgb'],call:ctx=>adapter.setColor(nativeId,{mode:'rgb',value:state.rgb!},ctx)});
        if(state.rgbw)calls.push({paths:['/rgbw'],call:ctx=>adapter.setColor(nativeId,{mode:'rgbw',value:state.rgbw!},ctx)});
        if(state.rgbww)calls.push({paths:['/rgbww'],call:ctx=>adapter.setColor(nativeId,{mode:'rgbww',value:state.rgbww!},ctx)});
        if(state.colorTemperature!==undefined)calls.push({paths:['/colorTemperature'],call:ctx=>adapter.setTemperature(nativeId,state.colorTemperature!,ctx)});
        if(state.effect!==undefined){if(!adapter.effects)throw unavailableCapability('effects','/state/effect');calls.push({paths:['/effect'],call:ctx=>state.effect===null?adapter.effects!.stop(nativeId,ctx):adapter.effects!.start(nativeId,state.effect!,ctx)});}
        if(state.segments){if(!adapter.segments)throw unavailableCapability('segments','/state/segments');calls.push({paths:['/segments'],call:ctx=>adapter.segments!.apply(nativeId,state.segments!,ctx)});}
      }
      const observations:DeviceState={};
      for(const call of calls){try{if(opts.signal?.aborted)throw new AdapterError('CANCELED','Canceled');const receipt=await this.runtime.call(adapter.id,operationId,nativeId,call.call,opts.signal?{signal:opts.signal}:{});result.transport=receipt.transport;result.confirmation='acknowledged';for(const path of call.paths)result.fieldResults.push({path,status:'applied'});if(receipt.observation){this.registry.observe(device.id,receipt.observation,operationId);Object.assign(observations,receipt.observation.state);}this.registry.completeWrite(device.id);}catch(error){result.transport??=device.address?.transport??null;if(error instanceof AdapterError&&error.delivery==='unknown')result.confirmation='unconfirmed';for(const path of call.paths)result.fieldResults.push({path,status:error instanceof AdapterError&&error.delivery==='unknown'?'unconfirmed':'failed'});throw error;}}
      const matches=(actual:DeviceState)=>Object.entries(state).every(([key,value])=>isDeepStrictEqual(actual[key as keyof DeviceState],value));
      if(matches(observations))result.confirmation='observed';else {
        await this.registry.refresh(device.id);const actual=this.registry.get(device.id);
        if(!actual.stateStale&&matches(actual.state))result.confirmation='observed';
        else if(!actual.stateStale&&Object.entries(state).some(([key,value])=>key in actual.state&&!isDeepStrictEqual(actual.state[key as keyof DeviceState],value)))throw new GatewayError(409,'state_mismatch','Observed state differs from requested state',[],opts.requestId);
      }
      result.state=this.registry.get(device.id).state;
      if(result.warnings.length){result.status='degraded';result.fieldResults.push({path:'/transitionMs',status:'omitted',reason:'unsupported_transition'});}
    }catch(error){result.status='failed';result.error=publicError(error,opts.requestId);if(result.fieldResults.length)result.state=this.registry.get(target.deviceId).state;}finally{this.registry.completeWrite(target.deviceId);}
    this.logger?.info({operationId,deviceId:target.deviceId,latencyMs:Date.now()-started,success:result.status!=='failed',errorCategory:result.error?.code},'Command completed');return result;
  }
  control(kind:Operation['kind'],request:Record<string,unknown>,ids:string[],work:(operation:Operation)=>Promise<void>,effectRunId?:string):Operation {
    if(this.closing)throw new GatewayError(503,'gateway_stopping','Gateway is stopping');
    if(this.pending.size>=(this.options.maxPending??1000))throw new GatewayError(429,'rate_limited','Operation queue is full');
    const operation:Operation={id:randomUUID(),kind,status:'queued',createdAt:new Date().toISOString(),completedAt:null,request:structuredClone(request),targetDeviceIds:[...ids],results:[],...(effectRunId?{effectRunId}:{})};
    this.store.saveOperation(operation);
    const pending=Promise.resolve().then(async()=>{operation.status='running';this.store.saveOperation(operation);await work(operation);if(operation.kind==='discovery'){const results=operation.adapterResults??[];operation.status=results.every(r=>r.status==='succeeded')?'succeeded':results.some(r=>r.status==='succeeded')?'partial':'failed';}else operation.status=operation.results.every(r=>r.status==='succeeded')?'succeeded':operation.results.some(r=>r.status!=='failed')?'partial':'failed';operation.completedAt=new Date().toISOString();this.store.saveOperation(operation);this.bus.publish('operation.completed',{type:'operation',id:operation.id},{operation:structuredClone(operation)},operation.id);return operation;}).catch(error=>{operation.error=publicError(error);operation.results=ids.map(id=>rejected(id,operation.error!));return this.finish(operation);}).finally(()=>this.pending.delete(operation.id));
    this.pending.set(operation.id,pending);return structuredClone(operation);
  }
  discover(adapterIds:string[]):Operation {
    if(!adapterIds.length||new Set(adapterIds).size!==adapterIds.length)throw new GatewayError(422,'validation_error','Select distinct configured adapters');
    for(const id of adapterIds)this.runtime.get(id);
    return this.control('discovery',{adapterIds},[],async operation=>{operation.adapterResults=await Promise.all(adapterIds.map(async adapterId=>{try{const discovered=await this.registry.discover(adapterId,operation.id);return {adapterId,status:'succeeded' as const,discoveredDeviceIds:discovered.map(d=>d.id)};}catch(error){return {adapterId,status:'failed' as const,discoveredDeviceIds:[],error:publicError(error,operation.id)};}}));operation.discoveredDeviceIds=[...new Set(operation.adapterResults.flatMap(r=>r.discoveredDeviceIds))];});
  }
  async drain():Promise<void>{this.closing=true;await Promise.allSettled([...this.pending.values()]);}
}
