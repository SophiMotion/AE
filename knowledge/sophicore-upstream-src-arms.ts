export const neutralPose=Object.freeze({shoulder_lift:0,shoulder_swing:0,arm_twist:0,elbow_bend:0,wrist_rotation:0,clamp:0});
export type ArmPose={-readonly [K in keyof typeof neutralPose]:number};
export type JointKey=keyof ArmPose;
export const joints:{key:JointKey;label:string;min:number;max:number;axis:string}[]=[
 {key:'shoulder_lift',label:'Shoulder lift',min:-180,max:180,axis:'X shaft'},
 {key:'shoulder_swing',label:'Shoulder swing',min:-100,max:40,axis:'Y shaft'},
 {key:'arm_twist',label:'Arm twist',min:-90,max:90,axis:'Z shaft'},
 {key:'elbow_bend',label:'Elbow bend',min:0,max:135,axis:'X shaft'},
 {key:'wrist_rotation',label:'Wrist rotation',min:-90,max:90,axis:'Servo · −90° to +90°'},
 {key:'clamp',label:'Clamping',min:0,max:45,axis:'Servo · 0° to 45°'},
];
// Older configuration files predate the two hand servos. Only missing fields default.
export function withHandDefaults(p:Omit<ArmPose,'wrist_rotation'|'clamp'>&Partial<Pick<ArmPose,'wrist_rotation'|'clamp'>>):ArmPose{return {wrist_rotation:0,clamp:0,...p};}
export function validatePose(p:ArmPose){return joints.filter(j=>!Number.isFinite(p[j.key])||p[j.key]<j.min||p[j.key]>j.max).map(j=>`${j.label}: use ${j.min}–${j.max}°.`);}
export function parseArmConfig(value:unknown):{pose:ArmPose;movable:boolean}{
 if(value===undefined)return {pose:{...neutralPose},movable:false};
 if(!value||typeof value!=='object')throw new Error('Invalid arm configuration.');
 const a=value as {pose?:ArmPose;movable?:boolean};
 if(typeof a.movable!=='boolean'||!a.pose)throw new Error('Invalid arm joint angles or mode.');
 const pose=withHandDefaults(a.pose);
 if(validatePose(pose).length)throw new Error('Invalid arm joint angles or mode.');
 return {pose,movable:a.movable};
}
