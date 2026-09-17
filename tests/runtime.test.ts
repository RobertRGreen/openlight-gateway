import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AdapterRuntime} from '../src/adapters/runtime.js';
import {MockAdapter} from '../src/adapters/mock/index.js';
import {DomainBus} from '../src/core/events.js';
import {DeviceRegistry} from '../src/core/devices/index.js';
import {GatewayStore} from '../src/persistence/index.js';

describe('adapter isolation and reconciliation',()=>{
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
