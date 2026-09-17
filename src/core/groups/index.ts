import type { DomainBus } from '../events.js';
import { randomUUID } from 'node:crypto';
import { GatewayError } from '../errors.js';
import type { DeviceRegistry } from '../devices/index.js';
import type { CoreStore } from '../operations/storage.js';
import { AggregateEvents, aggregate, validName, type AggregateState } from '../rooms/index.js';
export interface Group {id:string;name:string;deviceIds:string[]}
export class GroupService {
  private events:AggregateEvents;
  constructor(private store:CoreStore,private registry:DeviceRegistry,bus:DomainBus) {this.events=new AggregateEvents('group',bus,()=>this.list().map(group=>({id:group.id,state:this.state(group.id)})));}
  close():void{this.events.close();}
  list():Group[]{return this.store.list<Group>('groups');}
  get(id:string):Group {const group=this.store.get<Group>('groups',id);if(!group)throw new GatewayError(404,'not_found','Group not found');return group;}
  private validate(ids:string[]):void {if(new Set(ids).size!==ids.length)throw new GatewayError(422,'validation_error','Duplicate device membership');for(const id of ids)this.registry.get(id);}
  create(name:string,deviceIds:string[]):Group {validName(name);this.validate(deviceIds);const group={id:randomUUID(),name,deviceIds:[...deviceIds]};this.write(group);return group;}
  update(id:string,patch:{name?:string;deviceIds?:string[]}):Group {const group={...this.get(id),...patch};validName(group.name);this.validate(group.deviceIds);this.write(group);return group;}
  private write(group:Group):void {const devices=this.registry.list().map(d=>{const groups=d.groups.filter(id=>id!==group.id);if(group.deviceIds.includes(d.id))groups.push(group.id);return {...d,groups};});this.store.transaction(()=>{this.store.put('groups',group.id,group);for(const d of devices)this.store.put('device_snapshots',d.id,d);});for(const d of devices)this.registry.applyPersistedMetadata(d.id,{groups:d.groups});this.events.schedule();}
  delete(id:string):void {this.get(id);const scenes=this.store.list<{entries:{target:{type:string;id:string}}[]}>('scenes');if(scenes.some(s=>s.entries.some(e=>e.target.type==='group'&&e.target.id===id)))throw new GatewayError(409,'resource_in_use','Group is referenced by a scene');const devices=this.registry.list().filter(d=>d.groups.includes(id)).map(d=>({...d,groups:d.groups.filter(g=>g!==id)}));this.store.transaction(()=>{for(const d of devices)this.store.put('device_snapshots',d.id,d);this.store.delete('groups',id);});for(const d of devices)this.registry.applyPersistedMetadata(d.id,{groups:d.groups});this.events.schedule();}
  state(id:string):AggregateState {return aggregate(this.get(id).deviceIds.map(id=>this.registry.get(id)));}
}
