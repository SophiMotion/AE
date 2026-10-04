import {Matrix4,Vector3} from 'three';
import {joints,neutralPose,withHandDefaults,type ArmPose} from './arms';
import {defaults,type Params} from './parameters';
export const limbKeys=['arm_l','arm_r','leg_l','leg_r'] as const;
export type LimbKey=typeof limbKeys[number];
export type LimbPoses=Record<LimbKey,ArmPose>;
export type LimbModes=Record<LimbKey,boolean>;
export const limbLabels:Record<LimbKey,string>={arm_l:'Arm L',arm_r:'Arm R',leg_l:'Leg L',leg_r:'Leg R'};
export const neutralLimbs=():LimbPoses=>Object.fromEntries(limbKeys.map(k=>[k,{...neutralPose}])) as LimbPoses;
export const fixedModes=():LimbModes=>({arm_l:false,arm_r:false,leg_l:false,leg_r:false});
export const legJoints=[{key:'shoulder_lift',label:'Hip lift',min:-90,max:90,axis:'X shaft'},{key:'elbow_bend',label:'Knee bend',min:0,max:135,axis:'X shaft'}] as typeof joints;
export const limbJoints=(key:LimbKey)=>key.startsWith('arm')?joints:legJoints;
export function validateLimb(key:LimbKey,pose:ArmPose){return limbJoints(key).filter(j=>!Number.isFinite(pose[j.key])||pose[j.key]<j.min||pose[j.key]>j.max).map(j=>`${j.label}: use ${j.min}–${j.max}°.`);}
export function parseLimbConfig(value:unknown):{pose:LimbPoses;movable:LimbModes}{
 if(value===undefined)return {pose:neutralLimbs(),movable:fixedModes()};
 const v=value as {pose?:LimbPoses;movable?:LimbModes};
 if(!v||!v.pose||!v.movable)throw new Error('Invalid limb configuration.');
 const pose=neutralLimbs();
 for(const k of limbKeys){
  if(typeof v.movable[k]!=='boolean'||!v.pose[k])throw new Error(`Invalid ${limbLabels[k]} configuration.`);
  pose[k]=withHandDefaults(v.pose[k]);
  if(validateLimb(k,pose[k]).length||!Number.isFinite(pose[k].arm_twist)||k.startsWith('leg')&&(pose[k].arm_twist!==0||pose[k].shoulder_swing!==0||pose[k].wrist_rotation!==0||pose[k].clamp!==0))throw new Error(`Invalid ${limbLabels[k]} configuration.`);
 }
 return {pose,movable:{...v.movable}};
}
import tubeReference from './model4-tubes.json';
export interface LimbPart {limb:LimbKey;stage:number;lengthShift:0|1|2;tube?:'upper_arm_length'|'lower_arm_length'|'thigh_length'|'lower_leg_length'}
const parts=new Map<number,LimbPart>();
const range=(a:number,b:number)=>Array.from({length:b-a+1},(_,i)=>a+i);
function assign(limb:LimbKey,stage:number,lengthShift:0|1|2,ids:number[],tube?:LimbPart['tube']){for(const id of ids){if(parts.has(id))throw new Error(`Duplicate model 4 mapping ${id}`);parts.set(id,{limb,stage,lengthShift,tube});}}
// Covers and motor housings stay with their parent; output brackets carry the distal chain.
assign('arm_l',0,0,[...range(25,88),165]);
assign('arm_l',1,0,[...range(89,152),166,167]);
assign('arm_l',2,0,[168,169,170,171]);assign('arm_l',2,0,[153],'upper_arm_length');
assign('arm_l',2,1,[154,155,172,173]);
assign('arm_l',3,1,[156,157,174,175,179]);
assign('arm_l',4,1,[176,177,178,180]);assign('arm_l',4,1,[158],'lower_arm_length');
assign('arm_l',4,2,[267,268,269,...range(271,280),300,301]);
assign('arm_l',5,2,[270,...range(281,285),...range(287,296)]);
assign('arm_l',6,2,[286,297,298,299]);
assign('arm_r',0,0,[302,...range(303,366)]);
assign('arm_r',1,0,[367,368,...range(369,432)]);
assign('arm_r',2,0,[433,434,435,436]);assign('arm_r',2,0,[437],'upper_arm_length');
assign('arm_r',2,1,[438,439,440,441]);
assign('arm_r',3,1,[442,443,444,445,446]);
assign('arm_r',4,1,[447,448,449,450]);assign('arm_r',4,1,[451],'lower_arm_length');
assign('arm_r',4,2,[...range(452,456),...range(458,467)]);
assign('arm_r',5,2,[457,...range(468,472),...range(474,483)]);
assign('arm_r',6,2,[473,484,485,486]);
assign('leg_l',0,0,[159,160,181,182,183,184,185]);
assign('leg_l',2,0,[186,187]);assign('leg_l',2,0,[161],'thigh_length');
assign('leg_l',2,1,[162,163,188,189,190,191]);
assign('leg_l',3,1,[192,193]);assign('leg_l',3,1,[164],'lower_leg_length');
assign('leg_r',0,0,range(487,493));
assign('leg_r',2,0,[494,495]);assign('leg_r',2,0,[496],'thigh_length');
assign('leg_r',2,1,range(497,502));
assign('leg_r',3,1,[503,504]);assign('leg_r',3,1,[505],'lower_leg_length');
export const limbPart=(id:number)=>parts.get(id);
export const tubeIds=new Set([153,158,161,164,437,451,496,505]);
export const motorCoverIds=new Set([179,182,183,263,446,490,491]);
export const isHead=(id:number)=>id>=194&&id<=266;
export function deformLimb(id:number,positions:number[],p:Params){
 const part=parts.get(id),a=Float64Array.from(positions);
 if(isHead(id)){for(let i=2;i<a.length;i+=3)a[i]+=p.total_height-defaults.total_height;return a;}
 if(!part)return a;
 const arm=part.limb.startsWith('arm'),side=part.limb.endsWith('_l')?1:-1;
 const dx=side*((arm?p.shoulder_length-450:p.hip_length-400)/2);
 const dz=arm?p.total_height-defaults.total_height:p.base_height-200+p.hip_position-800;
 const proximal=arm?p.upper_arm_length-200:p.thigh_length-250,distal=arm?p.lower_arm_length-300:p.lower_leg_length-250;
 const shift=part.lengthShift===0?0:proximal+(part.lengthShift===2?distal:0);
 const tube=part.tube?tubeReference[String(id) as keyof typeof tubeReference]:undefined;
 for(let i=0;i<a.length;i+=3){let x=a[i],y=a[i+1],z=a[i+2];
  if(tube&&part.tube){const [cx,cy]=tube.center,r=Math.hypot(x-cx,y-cy),nr=p.tube_diameter/2-p.tube_thickness+(r-23)*p.tube_thickness/2;
   x=cx+(x-cx)*nr/r;y=cy+(y-cy)*nr/r;
   const original=part.tube==='upper_arm_length'?200:part.tube==='lower_arm_length'?300:250;
   z=tube.top-(tube.top-z)*p[part.tube]/original;
  }
  a[i]=x+dx;a[i+1]=y;a[i+2]=z+dz-shift;
 }
 return a;
}
function rotate(pivot:number[],axis:Vector3,degrees:number){return new Matrix4().makeTranslation(pivot[0],pivot[1],pivot[2]).multiply(new Matrix4().makeRotationAxis(axis,degrees*Math.PI/180)).multiply(new Matrix4().makeTranslation(-pivot[0],-pivot[1],-pivot[2]));}
export function limbPivots(key:LimbKey,p:Params){
 const side=key.endsWith('_l')?1:-1,arm=key.startsWith('arm'),dx=side*(arm?p.shoulder_length-450:p.hip_length-400)/2;
 const dz=arm?p.total_height-defaults.total_height:p.base_height-200+p.hip_position-800;
 const armOffset=side===1?0:-30;
 const x=side*320.5+dx;
 const handShift=dz-(p.upper_arm_length-200)-(p.lower_arm_length-300);
 // Shaft centers inferred from the exported servo output mounts; preserve source asymmetry.
 const wrist=side===1?[320.5+dx,-20,995.5193+handShift]:[-320.480+dx,-20.020,965.300+handShift];
 const clamp=side===1?[318.51543774+dx,-46.50605813,970.11952428+handShift]:[-322.45936475+dx,-46.53703852,939.65064290+handShift];
 return arm?{shoulder:[side*250+dx,-20,1724+dz],swing:[x,-20,1724+dz],twist:[x,-20,1403+armOffset+dz-(p.upper_arm_length-200)],elbow:[x,-20,1374.75+armOffset+dz-(p.upper_arm_length-200)],wrist,clamp}:
 {hip:[side*169.45+dx,-20,1008.75+dz],knee:[side*169.45+dx,-20,697.5+dz-(p.thigh_length-250)]};
}
export function limbMatrix(id:number,p:Params,poses:LimbPoses){
 const part=parts.get(id),m=new Matrix4();if(!part)return m;
 const pose=poses[part.limb],q=limbPivots(part.limb,p),side=part.limb.endsWith('_l')?1:-1;
 if(part.limb.startsWith('arm')){
  if(part.stage>=1)m.multiply(rotate(q.shoulder!,new Vector3(1,0,0),pose.shoulder_lift));
  if(part.stage>=2)m.multiply(rotate(q.swing!,new Vector3(0,1,0),side*pose.shoulder_swing));
  if(part.stage>=3)m.multiply(rotate(q.twist!,new Vector3(0,0,1),side*pose.arm_twist));
  if(part.stage>=4)m.multiply(rotate(q.elbow!,new Vector3(1,0,0),pose.elbow_bend));
  if(part.stage>=5&&pose.wrist_rotation)m.multiply(rotate(q.wrist!,new Vector3(0,0,1),pose.wrist_rotation));
  if(part.stage>=6&&pose.clamp)m.multiply(rotate(q.clamp!,new Vector3(1,-1,0).normalize(),pose.clamp));
 }else{
  if(part.stage>=2)m.multiply(rotate(q.hip!,new Vector3(1,0,0),pose.shoulder_lift));
  if(part.stage>=3)m.multiply(rotate(q.knee!,new Vector3(1,0,0),-pose.elbow_bend));
 }
 return m;
}
