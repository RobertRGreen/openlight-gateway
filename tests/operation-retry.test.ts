import { beforeEach, afterEach, expect, it } from 'vitest';
import { GatewayStore } from '../src/persistence/index.js';
import { DomainBus } from '../src/core/events.js';
import { AdapterRuntime } from '../src/adapters/runtime.js';
import { DeviceRegistry } from '../src/core/devices/index.js';
import { MockAdapter } from '../src/adapters/mock/index.js';
import { AdapterError } from '../src/adapters/types.js';
import { OperationService } from '../src/core/operations/index.js';
let store:GatewayStore, runtime:AdapterRuntime, registry:DeviceRegistry, service:OperationService, id:string;
beforeEach(async()=>{
 store=new GatewayStore(':memory:');const bus=new DomainBus(store.gatewayId);runtime=new AdapterRuntime(bus);
 runtime.register(new MockAdapter());registry=new DeviceRegistry(store,runtime,bus);
 service=new OperationService(store,registry,runtime,bus,undefined,{retryDelayMs:1});
 await runtime.connect('mock');await registry.discover('mock');id=registry.list().find(d=>d.name.includes('RGB'))!.id;
});
afterEach(async()=>{await service.drain();await registry.close();await runtime.close();store.close();});
it('retries a transient write within one operation and confirms final observed state',async()=>{
 const adapter=runtime.get('mock'),original=adapter.setPower.bind(adapter);let writes=0;
 adapter.setPower=async(...args)=>{if(++writes===1)throw new AdapterError('RATE_LIMITED','busy',true,'not_sent',1);return original(...args);};
 const admission=service.submitCommand({type:'device',id},{power:true});
 const done=await service.wait(admission.id);
 expect(done.status).toBe('succeeded');expect(done.results[0]?.confirmation).toBe('observed');expect(writes).toBe(2);
 expect(store.listOperations()).toHaveLength(1);
});
it('does not retry authentication failures',async()=>{
 let writes=0;runtime.get('mock').setPower=async()=>{writes++;throw new AdapterError('AUTH_FAILED','invalid credentials');};
 const done=await service.wait(service.submitCommand({type:'device',id},{power:true}).id);
 expect(done.status).toBe('failed');expect(writes).toBe(1);
});
it('bounds persistent transient failures to three attempts',async()=>{
 let writes=0;runtime.get('mock').setPower=async()=>{writes++;throw new AdapterError('RATE_LIMITED','busy',true,'not_sent',1);};
 const done=await service.wait(service.submitCommand({type:'device',id},{power:true}).id);
 expect(done.status).toBe('failed');expect(writes).toBe(3);
});
it('serializes a later command behind all retries so old retries cannot overwrite it',async()=>{
 const adapter=runtime.get('mock'),original=adapter.setPower.bind(adapter);const seen:boolean[]=[];
 adapter.setPower=async(native,power,ctx)=>{seen.push(power);if(seen.length===1)throw new AdapterError('RATE_LIMITED','busy',true,'not_sent',1);return original(native,power,ctx);};
 const first=service.submitCommand({type:'device',id},{power:true});const last=service.submitCommand({type:'device',id},{power:false});
 await Promise.all([service.wait(first.id),service.wait(last.id)]);
 expect(seen).toEqual([true,true,false]);expect(registry.get(id).state.power).toBe(false);
});
it('cancellation interrupts retry backoff without another write',async()=>{
 const controller=new AbortController();let writes=0;
 runtime.get('mock').setPower=async()=>{writes++;controller.abort();throw new AdapterError('TIMEOUT','busy',true);};
 const done=await service.wait(service.submitCommand({type:'device',id},{power:true},{signal:controller.signal}).id);
 expect(done.status).toBe('failed');expect(writes).toBe(1);
});

it('retries a temporary TCP disconnect after the adapter marks the bulb offline',async()=>{
 const adapter=runtime.get('mock'),original=adapter.setPower.bind(adapter);let writes=0;
 adapter.setPower=async(...args)=>{if(++writes===1){registry.availability(id,'offline','temporary_disconnect');throw new AdapterError('OFFLINE','connection dropped',true,'unknown');}return original(...args);};
 const done=await service.wait(service.submitCommand({type:'device',id},{power:true}).id);
 expect(done.status).toBe('succeeded');expect(writes).toBe(2);expect(done.results[0]?.confirmation).toBe('observed');
 expect(store.listOperations()).toHaveLength(1);
});
it('a stale offline poll does not block an otherwise reachable bulb assignment',async()=>{
 registry.availability(id,'offline','poll_failed');
 const done=await service.wait(service.submitCommand({type:'device',id},{power:true}).id);
 expect(done.status).toBe('succeeded');expect(registry.get(id).availability).toBe('online');
});

it('a late failed background poll cannot mark a freshly observed bulb offline',async()=>{
 let fail!:(error:unknown)=>void;let entered!:()=>void;
 const reading=new Promise<void>(resolve=>{entered=resolve;});
 runtime.get('mock').getState=async()=>{entered();return new Promise((_,reject)=>{fail=reject;});};
 const pending=registry.refresh(id);await reading;
 registry.observe(id,{state:{power:true},observedAt:new Date().toISOString(),complete:true,nativeSequence:'99999'});
 fail(new AdapterError('OFFLINE','old poll disconnected',true));await pending;
 expect(registry.get(id).availability).toBe('online');expect(registry.get(id).stateStale).toBe(false);
});
