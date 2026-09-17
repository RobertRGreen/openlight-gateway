import type { DomainBus } from '../events.js';
import { randomUUID } from 'node:crypto';
import { GatewayError } from '../errors.js';
import type { DeviceRegistry } from '../devices/index.js';
import type { CoreStore } from '../operations/storage.js';
import type { Device } from '../model.js';
export interface Room { id: string; name: string }
export interface AggregateState { deviceStates: {deviceId:string; availability:Device['availability'];state:Device['state'];observedAt:string|null;stale:boolean;revision:number}[]; mixed:boolean }
export function aggregate(devices: Device[]): AggregateState {
  const comparable = new Map<string,string>(); let mixed = false;
  for (const device of devices) for (const [key,value] of Object.entries(device.state)) {
    const serialized=canonical(value); if(comparable.has(key)&&comparable.get(key)!==serialized) mixed=true;
    comparable.set(key,serialized);
  }
  return {deviceStates:devices.map(d=>({deviceId:d.id,availability:d.availability,state:d.state,observedAt:d.stateObservedAt,stale:d.stateStale,revision:d.revision})),mixed};
}
export function validName(name:string):void {if(typeof name!=='string'||!name.trim()) throw new GatewayError(422,'validation_error','Name must not be empty');}
function canonical(value:unknown):string {if(Array.isArray(value))return JSON.stringify(value.map(canonical));if(value!==null&&typeof value==='object'&&!Array.isArray(value))return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])));return JSON.stringify(value);}
export class AggregateEvents {
 private scheduled=false;private closed=false;private previous=new Map<string,string>();private unsubscribe:()=>void;
 constructor(private type:'room'|'group',private bus:DomainBus,private snapshots:()=>{id:string;state:AggregateState}[]){this.unsubscribe=bus.subscribe(event=>{if(event.subject.type==='device')this.schedule();});}
 schedule():void{if(this.scheduled||this.closed)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;if(this.closed)return;const present=new Set<string>();for(const {id,state}of this.snapshots()){present.add(id);const json=canonical(state);if(this.previous.get(id)!==json){this.previous.set(id,json);this.bus.publish(`${this.type}.state_changed`,{type:this.type,id},state);}}for(const id of this.previous.keys())if(!present.has(id)){this.previous.delete(id);this.bus.publish(`${this.type}.state_changed`,{type:this.type,id},{deviceStates:[],mixed:false});}});}
 close():void{this.closed=true;this.unsubscribe();}
}
export class RoomService {
  private events:AggregateEvents;
  constructor(private store:CoreStore,private registry:DeviceRegistry,bus:DomainBus) {this.events=new AggregateEvents('room',bus,()=>this.list().map(room=>({id:room.id,state:this.state(room.id)})));}
  close():void{this.events.close();}
  list():Room[]{return this.store.list<Room>('rooms');}
  get(id:string):Room {const value=this.store.get<Room>('rooms',id);if(!value)throw new GatewayError(404,'not_found','Room not found');return value;}
  create(name:string):Room {validName(name);const room={id:randomUUID(),name};this.store.put('rooms',room.id,room);this.events.schedule();return room;}
  update(id:string,name:string):Room {validName(name);const room={...this.get(id),name};this.store.put('rooms',id,room);return room;}
  assign(deviceId:string,roomId:string|null):void {if(roomId)this.get(roomId);const d=this.registry.get(deviceId);this.registry.setMembership(deviceId,roomId,d.groups);this.events.schedule();}
  delete(id:string):void {this.get(id);const devices=this.registry.list().filter(d=>d.room===id).map(d=>({...d,room:null}));this.store.transaction(()=>{for(const d of devices)this.store.put('device_snapshots',d.id,d);this.store.delete('rooms',id);});for(const d of devices)this.registry.applyPersistedMetadata(d.id,{room:null});this.events.schedule();}
  state(id:string):AggregateState {this.get(id);return aggregate(this.registry.list().filter(d=>d.room===id));}
}
