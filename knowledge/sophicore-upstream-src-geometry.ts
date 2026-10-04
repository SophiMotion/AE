import {defaults,rampStart,type Params} from './parameters';
import {deformLimb,tubeIds,limbPart,isHead,motorCoverIds} from './limbs';
export interface Bounds {min:number[];max:number[];size:number[];center:number[]}
export interface SourceMesh {id:number;name:string;color?:number[];positions:number[];indices:number[];bounds:Bounds}
export interface Model {meshes:SourceMesh[];metadata:{source:string;sha256:string;units:string;meshCount:number;bounds:Bounds;hierarchy:unknown}}
export type Role='tray'|'cover'|'tire'|'rim'|'motor'|'hub'|'caster'|'spine'|'mount'|'frame'|'shoulder'|'hip'|'tube'|'actuator'|'housing'|'head';
// This source-specific map is audited against the supplied STEP hierarchy and extents.
export function roleOf(m:Pick<SourceMesh,'id'>):Role{
 const id=m.id;if(tubeIds.has(id))return 'tube';if(motorCoverIds.has(id))return 'housing';if(isHead(id))return 'head';
 if(id>=25)return 'actuator';if(id===0)return 'tray';if(id===1||id===2)return 'cover';
 if(id===4||id===8)return 'tire';if(id===3||id===7)return 'rim';
 if(id===5||id===21)return 'motor';if(id===6||id===22)return 'hub';
 if(id===9||id===10)return 'caster';if(id===11)return 'spine';
 if(id===17)return 'shoulder';if(id===23||id===24)return 'hip';return 'frame';
}
export function boundsOf(a:ArrayLike<number>):Bounds{
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<a.length;i++){const k=i%3;min[k]=Math.min(min[k],a[i]);max[k]=Math.max(max[k],a[i]);}
 return {min,max,size:max.map((v,i)=>v-min[i]),center:max.map((v,i)=>(v+min[i])/2)};
}
function map(v:number,from:number[],to:number[]){let i=0;while(i<from.length-2&&v>from[i+1])i++;return to[i]+(v-from[i])/(from[i+1]-from[i])*(to[i+1]-to[i]);}
const same=(p:Params)=>Object.keys(defaults).every(k=>p[k as keyof Params]===defaults[k as keyof Params]);
export function deform(m:SourceMesh,p:Params):Float64Array{
 const result=Float64Array.from(m.positions);
 if(same(p))return result;
 if(limbPart(m.id)||isHead(m.id))return deformLimb(m.id,m.positions,p);
 const role=roleOf(m),id=m.id,side=Math.sign(m.bounds.center[0]);
 const dx=side*(p.wheel_track-600)/2,dy=(p.wheel_base-500)/2,dz=(p.od_tire-150)/2;
 const t=p.thin_sheet,dh=p.base_height-200,deck=50+p.base_height;
 const upper=deck-t-2-40,lower=50+t+40;
 for(let i=0;i<result.length;i+=3){let x=m.positions[i],y=m.positions[i+1],z=m.positions[i+2];
  if(role==='tire'||role==='rim'){
   const ry=y-250,rz=z-75,r=Math.hypot(ry,rz);
   let nr=r;
   if(role==='tire') nr=map(r,[65,75],[(p.od_tire-p.tire_thickness)/2,p.od_tire/2]);
   // Preserve the hub bore, transition only the annular rim outside 25 mm radius.
   else if(r>25)nr=map(r,[25,65],[25,(p.od_tire-p.tire_thickness)/2]);
   x+=dx;y=250+dy+ry*(r?nr/r:1);z=75+dz+rz*(r?nr/r:1);
  }else if(role==='motor'||role==='hub'){x+=dx;y+=dy;z+=dz;}
  else if(role==='caster'){x+=dx;y-=dy;}
  else if(role==='spine'){z=map(z,[56,1704],[54+t,p.total_height-171.75]);}
  else if(role==='shoulder'){x*=p.shoulder_length/450;z+=p.total_height-defaults.total_height;}
  else if(role==='hip'){x=side*(40+(Math.abs(x)-40)*(p.hip_length/2-40)/160);z+=dh+p.hip_position-800;}
  else if(role==='frame'){
   if(id===12||id===13){x*=((p.base_width/2-t)/423);z+=dh-(t-2);}
   else {x+=side*((p.base_width-850)/2-(t-2));
    if(id===14||id===18)z+=t-2;
    else z=map(z,[92,206],[lower,upper]);
   }
  }else if(role==='tray'||role==='cover'){
   const sx=Math.sign(x),sy=Math.sign(y);
   x=sx*map(Math.abs(x),[0,40.2,273,300,342.5,403,421,422.8,423,425],[0,40.2,p.wheel_track/2-27,p.wheel_track/2,p.wheel_track/2+42.5,p.base_width/2-t-20,p.base_width/2-2*t,p.base_width/2-t-.2,p.base_width/2-t,p.base_width/2]);
   y=sy*map(Math.abs(y),[0,20.2,173,250,327,362.325662851831,450],[0,20.2,p.wheel_base/2-p.od_tire/2-2,p.wheel_base/2,p.wheel_base/2+p.od_tire/2+2,rampStart(p),p.base_length/2]);
   z=map(z,[50,52,100,170,200,248,250],[50,50+t,50+(p.base_height-p.base_middle_length)/2,50+(p.base_height+p.base_middle_length)/2-30,50+(p.base_height+p.base_middle_length)/2,deck-t,deck]);
  }
  result[i]=x;result[i+1]=y;result[i+2]=z;
 }
 return result;
}
