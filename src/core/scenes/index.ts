import {randomUUID} from 'node:crypto';
import {validateSyntax} from '../capabilities/index.js';
import {GatewayError} from '../errors.js';
import type {CoreStore} from '../operations/storage.js';
import {OperationService,type OperationEvents,type SubmitOptions} from '../operations/index.js';
import type {Command,Operation,PreparedTarget,Target} from '../operations/types.js';
import type {GroupService} from '../groups/index.js';
import {validName} from '../rooms/index.js';
export interface SceneEntry extends Command {target:Target}
export interface Scene {id:string;name:string;entries:SceneEntry[]}
export class SceneService {
 constructor(private store:CoreStore,private groups:GroupService,private operations:OperationService,private bus:OperationEvents){}
 list():Scene[]{return this.store.list<Scene>('scenes');}
 get(id:string):Scene {const scene=this.store.get<Scene>('scenes',id);if(!scene)throw new GatewayError(404,'not_found','Scene not found');return scene;}
 private expand(entries:SceneEntry[]):PreparedTarget[]{if(!entries.length)throw new GatewayError(422,'validation_error','Scene requires entries');const targets:PreparedTarget[]=[];for(const entry of entries){validateSyntax(entry.state,'core',entry.transitionMs);if(!entry.state||typeof entry.state!=='object'||Array.isArray(entry.state)||!Object.keys(entry.state).length)throw new GatewayError(422,'validation_error','Scene state must be nonempty');if(entry.transitionMs!==undefined&&(!Number.isInteger(entry.transitionMs)||entry.transitionMs<0))throw new GatewayError(422,'validation_error','Invalid transition duration');if('effect'in entry.state||entry.state.segments?.some(s=>'effect'in s.state))throw new GatewayError(422,'validation_error','Scenes cannot select effects');const ids=entry.target.type==='group'?this.groups.get(entry.target.id).deviceIds:this.operations.resolve(entry.target);for(const deviceId of ids)targets.push({deviceId,command:{state:structuredClone(entry.state),...(entry.transitionMs===undefined?{}:{transitionMs:entry.transitionMs})}});}if(new Set(targets.map(t=>t.deviceId)).size!==targets.length)throw new GatewayError(422,'overlapping_targets','Scene targets overlap after expansion');return targets;}
 create(name:string,entries:SceneEntry[]):Scene {validName(name);this.expand(entries);const scene={id:randomUUID(),name,entries:structuredClone(entries)};this.store.put('scenes',scene.id,scene);return scene;}
 update(id:string,patch:{name?:string;entries?:SceneEntry[]}):Scene {const scene={...this.get(id),...structuredClone(patch)};validName(scene.name);this.expand(scene.entries);this.store.put('scenes',id,scene);return scene;}
 delete(id:string):void{this.get(id);this.store.delete('scenes',id);}
 activate(id:string,options:SubmitOptions&{allowDegraded?:boolean}={}):Operation {
  const scene=this.get(id);const targets=this.expand(scene.entries);
  if(options.allowDegraded===true)for(const target of targets){const d=this.operations.registry.get(target.deviceId);if(target.command.transitionMs!==undefined&&!d.capabilities.some(c=>c.type==='transitions')){target.warnings=[{code:'unsupported_transition',requested:`transitionMs=${target.command.transitionMs}`,applied:'transition omitted; immediate application'}];delete target.command.transitionMs;}}
  const operation=this.operations.submitPrepared('scene.activate',{sceneId:id,entries:scene.entries,allowDegraded:options.allowDegraded??false},targets,options);
  this.bus.publish('scene.started',{type:'scene',id},{operationId:operation.id,status:operation.status},operation.id);
  void this.operations.wait(operation.id).then(final=>this.bus.publish(final.status==='failed'?'scene.failed':'scene.completed',{type:'scene',id},{operationId:final.id,status:final.status},final.id)).catch(()=>this.bus.publish('scene.failed',{type:'scene',id},{operationId:operation.id,status:'failed'},operation.id));return operation;
 }
}
