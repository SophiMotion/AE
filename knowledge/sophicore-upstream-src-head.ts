import {Matrix4,Vector3} from 'three';
import {defaults,type Params} from './parameters';
export interface HeadPose{rotation:number;tilt:number}
export const neutralHead=():HeadPose=>({rotation:0,tilt:0});
export const headJoints=[{key:'rotation',label:'Head rotation',min:-90,max:90},{key:'tilt',label:'Look up / down',min:-30,max:30}] as const;
export function validateHead(p:HeadPose){return headJoints.filter(j=>!Number.isFinite(p[j.key])||p[j.key]<j.min||p[j.key]>j.max).map(j=>`${j.label}: use ${j.min}° to ${j.max}°.`);}
export function parseHeadConfig(value:unknown):{pose:HeadPose;movable:boolean}{
 if(value===undefined)return {pose:neutralHead(),movable:false};
 if(!value||typeof value!=='object')throw new Error('Invalid head configuration.');
 const v=value as {pose?:HeadPose;movable?:boolean};if(!v.pose||typeof v.movable!=='boolean'||validateHead(v.pose).length)throw new Error('Invalid head angles or mode.');
 return {pose:{rotation:v.pose.rotation,tilt:v.pose.tilt},movable:v.movable};
}
const yawOutput=new Set([195,201,202,211,...Array.from({length:15},(_,i)=>243+i),258,259,260,262,263,264,266]);
export const headStage=(id:number)=>id===265?2:yawOutput.has(id)?1:0;
export const headPivots=(p:Params)=>({rotation:[0,-20,1787+p.total_height-defaults.total_height],tilt:[0,-20,1824.75+p.total_height-defaults.total_height]});
function rotate(q:number[],axis:Vector3,angle:number){return new Matrix4().makeTranslation(q[0],q[1],q[2]).multiply(new Matrix4().makeRotationAxis(axis,angle*Math.PI/180)).multiply(new Matrix4().makeTranslation(-q[0],-q[1],-q[2]));}
export function headMatrix(id:number,p:Params,pose:HeadPose){const stage=headStage(id),m=new Matrix4();if(!stage)return m;const q=headPivots(p);if(pose.rotation)m.multiply(rotate(q.rotation,new Vector3(0,0,1),pose.rotation));if(stage===2&&pose.tilt)m.multiply(rotate(q.tilt,new Vector3(1,0,0),-pose.tilt));return m;}
