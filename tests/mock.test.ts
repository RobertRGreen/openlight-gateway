import { describe,it,expect } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import { validateState } from '../src/core/capabilities/index.js';
import { GatewayError } from '../src/core/errors.js';
const context=()=>({operationId:'test',correlationId:null,signal:new AbortController().signal,deadlineAt:Date.now()+5000});
describe('mock adapter',()=>{
 it('exposes exactly five deterministic devices and rejects RGB on both non-color bulbs',async()=>{
  const adapter=new MockAdapter();await adapter.connect(context());expect((await adapter.getDevices(context())).map(d=>d.nativeId)).toEqual(['rgb','temperature','white','rgbw','offline']);
  for(const id of ['temperature','white']) {
   await expect(adapter.setColor(id,{mode:'rgb',value:{r:255,g:0,b:0}},context())).rejects.toMatchObject({code:'UNSUPPORTED_CAPABILITY'});
   const capabilities=await adapter.getCapabilities(id,context());
   try{validateState(capabilities,{rgb:{r:255,g:0,b:0}},id,'req-28');throw new Error('Expected rejection');}catch(error){expect(error).toBeInstanceOf(GatewayError);expect((error as GatewayError).toJSON()).toEqual({error:{code:'capability_mismatch',message:'Device does not support rgb',requestId:'req-28',details:[{path:'/state/rgb',code:'unsupported_capability',message:'Required capability rgb is absent',deviceId:id,capability:'rgb'}]}});}
  }
 });
 it('offline device always rejects commands',async()=>{const adapter=new MockAdapter();await adapter.connect(context());await expect(adapter.setPower('offline',true,context())).rejects.toMatchObject({code:'OFFLINE',delivery:'not_sent'});});
});
