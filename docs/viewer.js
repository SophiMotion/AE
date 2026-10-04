import * as THREE from 'three';
import {OrbitControls} from './OrbitControls.js';

export async function createViewer(container, progress){
  const response=await fetch('./structure.json');if(!response.ok)throw Error('structure');
  const definition=await response.json();
  progress('正在读取完整模型，请稍候…');
  const meshResponse=await fetch('./model.bin');if(!meshResponse.ok)throw Error('mesh');
  const buffer=await meshResponse.arrayBuffer();
  const renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label','Sophicore 原始结构，可拖动旋转和双指缩放');renderer.domElement.setAttribute('role','img');
  const scene=new THREE.Scene();scene.background=new THREE.Color('#101619');
  const camera=new THREE.PerspectiveCamera(38,1,.001,100);camera.up.set(0,0,1);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.09;
  scene.add(new THREE.HemisphereLight(0xdce9f2,0x39423c,2.2));
  const key=new THREE.DirectionalLight(0xffffff,3.2);key.position.set(4,-4,7);scene.add(key);
  const fill=new THREE.DirectionalLight(0xe87b61,.8);fill.position.set(-3,4,2);scene.add(fill);
  const group=new THREE.Group();scene.add(group);
  const links=new Map(),joints=new Map(),owners=new Map();
  for(const link of definition.links){links.set(link.name,new THREE.Group());for(const id of link.mesh_ids)owners.set(id,link);}
  for(const mesh of definition.meshes){
    const geometry=new THREE.BufferGeometry();
    const packed=new Uint16Array(buffer,mesh.positionOffset,mesh.positionCount),positions=new Float32Array(mesh.positionCount);
    for(let i=0;i<positions.length;i++)positions[i]=mesh.positionMin[i%3]+packed[i]/65535*mesh.positionSpan[i%3];
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    const Index=mesh.indexBits===16?Uint16Array:Uint32Array;
    geometry.setIndex(new THREE.BufferAttribute(new Index(buffer,mesh.indexOffset,mesh.indexCount),1));
    geometry.scale(.001,.001,.001);
    const owner=owners.get(mesh.id);if(owner){const p=owner.mesh_origin_m;geometry.translate(-p[0],-p[1],-p[2]);}
    geometry.computeVertexNormals();const rgb=mesh.color,divisor=Math.max(...rgb.slice(0,3))>1?255:1;
    const part=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:new THREE.Color(rgb[0]/divisor,rgb[1]/divisor,rgb[2]/divisor),metalness:.32,roughness:.48}));
    (owner?links.get(owner.name):group).add(part);
  }
  const children=new Set();
  for(const joint of definition.joints){
    const origin=new THREE.Group();origin.position.fromArray(joint.origin.xyz);origin.rotation.set(...joint.origin.rpy,'ZYX');
    const moving=new THREE.Group();origin.add(moving);links.get(joint.parent).add(origin);moving.add(links.get(joint.child));children.add(joint.child);
    joints.set(joint.name,{object:moving,axis:new THREE.Vector3().fromArray(joint.axis).normalize(),initial:joint.initial_position||0});
  }
  for(const [name,node] of links)if(!children.has(name))group.add(node);
  const box=new THREE.Box3().setFromObject(group),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),extent=Math.max(size.x,size.y,size.z);
  const grid=new THREE.GridHelper(4,24,0x3a4d56,0x26353d);grid.rotation.x=Math.PI/2;grid.position.z=box.min.z-.02;scene.add(grid);
  controls.minDistance=extent*.4;controls.maxDistance=extent*5;
  function reset(){camera.position.set(center.x+extent*1.05,center.y-extent*1.6,center.z+extent*.6);controls.target.copy(center);controls.update();}
  function resize(){const width=container.clientWidth,height=container.clientHeight;if(!width||!height)return;renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();}
  function pose(positions){for(const [name,j] of joints)j.object.quaternion.setFromAxisAngle(j.axis,positions[name]??j.initial);}
  container.append(renderer.domElement);resize();reset();
  new ResizeObserver(resize).observe(container);
  renderer.setAnimationLoop(()=>{if(!document.hidden&&container.offsetParent!==null){controls.update();renderer.render(scene,camera);}});
  return {reset,resize,pose};
}
