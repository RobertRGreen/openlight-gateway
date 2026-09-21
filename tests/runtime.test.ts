import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AdapterRuntime} from '../src/adapters/runtime.js';
import {MockAdapter} from '../src/adapters/mock/index.js';
import {AdapterError} from '../src/adapters/types.js';
import type {AdapterEvent} from '../src/adapters/types.js';
import {DomainBus} from '../src/core/events.js';
import {DeviceRegistry} from '../src/core/devices/index.js';
import {GatewayStore} from '../src/persistence/index.js';

describe('adapter isolation and reconciliation',()=>{
 it('leaves endpoint-specific budgets to adapters that enforce their own quotas',async()=>{
  const runtime=new AdapterRuntime(new DomainBus(randomUUID()),undefined,{timeoutMs:100});
  const adapter=new MockAdapter({latencyMs:0});
  Object.assign(adapter.scheduling,{budgetManagement:'adapter',minUpdateIntervalMs:0,budgets:[{scope:'account',key:'endpoint-specific',maxRequests:1,windowMs:60000,burst:1,maxConcurrent:1}]});
  runtime.register(adapter);
  try {
   await runtime.connect(adapter.id);
   await expect(runtime.call(adapter.id,'first',null,c=>adapter.getDevices(c))).resolves.toHaveLength(5);
   await expect(runtime.call(adapter.id,'second',null,c=>adapter.getDevices(c))).resolves.toHaveLength(5);
  } finally {await runtime.close();}
 });
 it('contains a thrown adapter failure while unrelated adapters remain usable',async()=>{
  const bus=new DomainBus(randomUUID());const events:string[]=[];bus.subscribe(event=>events.push(event.type));
  const runtime=new AdapterRuntime(bus,undefined,{timeoutMs:500});const broken=new MockAdapter({id:'broken'});const healthy=new MockAdapter({id:'healthy'});runtime.register(broken);runtime.register(healthy);
  await runtime.connect('broken');await runtime.connect('healthy');
  await expect(runtime.call('broken','op',null,()=>{throw new Error('private native error');})).rejects.toMatchObject({code:'TRANSPORT_ERROR'});
  expect(events).toContain('adapter.error');expect(events).toContain('adapter.disconnected');
  const receipt=await runtime.call('healthy','op','white',c=>healthy.setPower('white',true,c));expect(receipt.observation?.state.power).toBe(true);
  await expect(runtime.call('broken','op','white',c=>broken.setPower('white',true,c))).rejects.toMatchObject({code:'TRANSPORT_ERROR'});
  await runtime.close();
 });
 it('provides bounded context and cancellation for timeouts without blocking other adapters',async()=>{
  const runtime=new AdapterRuntime(new DomainBus(randomUUID()),undefined,{timeoutMs:100});const slow=new MockAdapter({id:'slow'});const healthy=new MockAdapter({id:'healthy'});runtime.register(slow);runtime.register(healthy);await runtime.connect('slow');await runtime.connect('healthy');let signal:AbortSignal|undefined;
  await expect(runtime.call('slow','operation-id','white',async context=>{signal=context.signal;expect(context.operationId).toBe('operation-id');expect(context.deadlineAt).toBeGreaterThanOrEqual(Date.now());return new Promise<never>(()=>{});},{timeoutMs:30})).rejects.toMatchObject({code:'TIMEOUT',delivery:'unknown'});
  expect(signal?.aborted).toBe(true);expect((await runtime.call('healthy','op',null,c=>healthy.getDevices(c))).length).toBe(5);await runtime.close();
 });
 it('separates desired intent and rejects observations from an obsolete read generation',async()=>{
  const store=new GatewayStore();const bus=new DomainBus(store.gatewayId);const runtime=new AdapterRuntime(bus);const adapter=new MockAdapter();runtime.register(adapter);const registry=new DeviceRegistry(store,runtime,bus);await runtime.connect(adapter.id);await registry.discover(adapter.id);
  const device=registry.list().find(d=>d.model==='white')!;expect(device.state.power).toBe(false);
  registry.desired(device.id,{power:true},'operation');expect(registry.getDesired(device.id)?.state.power).toBe(true);expect(registry.get(device.id).state.power).toBe(false);
  const old=registry.revisionToken(device.id);registry.completeWrite(device.id);
  expect(registry.observe(device.id,{state:{power:true},observedAt:new Date().toISOString(),complete:false},undefined,old)).toBe(false);expect(registry.get(device.id).state.power).toBe(false);
  expect(registry.observe(device.id,{state:{brightness:23},observedAt:new Date().toISOString(),complete:false})).toBe(true);expect(registry.get(device.id).state).toMatchObject({power:false,brightness:23});await runtime.close();await registry.close();store.close();
 });
});

describe('adapter failure containment and recovery',()=>{
 const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
 it('degrades only the device whose call timed out and keeps the adapter usable',async()=>{
  const runtime=new AdapterRuntime(new DomainBus(randomUUID()),undefined,{timeoutMs:100});const adapter=new MockAdapter({id:'feit-like'});runtime.register(adapter);await runtime.connect(adapter.id);
  const events:{id:string;event:AdapterEvent}[]=[];runtime.onEvent((id,event)=>events.push({id,event}));
  await expect(runtime.call(adapter.id,'op','white',()=>new Promise<never>(()=>{}),{timeoutMs:30})).rejects.toMatchObject({code:'TIMEOUT'});
  expect(events).toContainEqual({id:adapter.id,event:{type:'availability',nativeId:'white',status:'unknown'}});
  expect(events.some(e=>e.event.type==='connection')).toBe(false);
  const receipt=await runtime.call(adapter.id,'op','temperature',c=>adapter.setPower('temperature',true,c));expect(receipt.observation?.state.power).toBe(true);
  await runtime.close();
 });
 it('reconnects a quarantined adapter on its own after a session-level failure',async()=>{
  const bus=new DomainBus(randomUUID());const types:string[]=[];bus.subscribe(event=>types.push(event.type));
  const runtime=new AdapterRuntime(bus,undefined,{timeoutMs:100,reconnectDelayMs:20});const adapter=new MockAdapter({id:'flaky'});runtime.register(adapter);await runtime.connect(adapter.id);
  await expect(runtime.call(adapter.id,'op',null,()=>{throw new Error('socket died');})).rejects.toMatchObject({code:'TRANSPORT_ERROR'});
  await expect(runtime.call(adapter.id,'op','white',c=>adapter.setPower('white',true,c))).rejects.toMatchObject({message:'Adapter unavailable'});
  await sleep(150);
  expect(types).toContain('adapter.connected');
  const receipt=await runtime.call(adapter.id,'op','white',c=>adapter.setPower('white',true,c));expect(receipt.observation?.state.power).toBe(true);
  await runtime.close();
 });
 it('does not reconnect after an explicit disconnect',async()=>{
  const runtime=new AdapterRuntime(new DomainBus(randomUUID()),undefined,{timeoutMs:100,reconnectDelayMs:20});const adapter=new MockAdapter({id:'stopped'});runtime.register(adapter);await runtime.connect(adapter.id);
  await expect(runtime.call(adapter.id,'op',null,()=>{throw new Error('socket died');})).rejects.toMatchObject({code:'TRANSPORT_ERROR'});
  await runtime.disconnect(adapter.id);await sleep(150);
  await expect(runtime.call(adapter.id,'op','white',c=>adapter.setPower('white',true,c))).rejects.toMatchObject({message:'Adapter unavailable'});
 });
 it('does not retry an adapter that never connected successfully',async()=>{
  const runtime=new AdapterRuntime(new DomainBus(randomUUID()),undefined,{timeoutMs:100,reconnectDelayMs:20});const adapter=new MockAdapter({id:'misconfigured'});runtime.register(adapter);
  const connect=vi.spyOn(adapter,'connect').mockRejectedValue(new AdapterError('TRANSPORT_ERROR','bad config',true));
  await expect(runtime.connect(adapter.id)).rejects.toMatchObject({code:'TRANSPORT_ERROR'});await sleep(150);
  expect(connect).toHaveBeenCalledTimes(1);await runtime.close();
 });
});
