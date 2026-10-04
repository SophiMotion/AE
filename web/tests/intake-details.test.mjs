import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDetails,hasDetailExtras,adoptPlatformDetails,clearDetailGroup,upgradeIntake,reorderRow} from '../src/intakeDetails.ts';
import {newDraft,fromProject,draftIsChanged} from '../src/draft.ts';

test('新稿V2八组保持待确认，旧V1读取不自动升级',()=>{
 const draft=newDraft();assert.equal(draft.prd.intake.schema_version,2);
 assert.deepEqual(draft.prd.intake.details,emptyDetails());
 const v1=structuredClone(draft);v1.prd.intake.schema_version=1;delete v1.prd.intake.details;
 const project={...v1,id:'v1-test',status:'approved'};
 const read=fromProject(project);assert.equal(read.prd.intake.schema_version,1);
 assert.ok(!('details' in read.prd.intake));assert.equal(draftIsChanged(read,project),false);
 const upgrade=upgradeIntake(read.prd.intake);assert.equal(upgrade.schema_version,2);
 assert.deepEqual(upgrade.answers,read.prd.intake.answers);assert.equal(read.prd.intake.schema_version,1);
});

test('一次采用平台只补空白，没有覆盖自定义、资料档案或零值',()=>{
 const details=emptyDetails();
 details.lifecycle.selection='custom';details.lifecycle.start='看到人再开始';
 details.device_mapping.scope='reference_only';
 details.environment.load_kg=0;
 details.motion.pattern='parallel';
 const before=structuredClone(details),next=adoptPlatformDetails(details);
 assert.deepEqual(details,before);
 assert.deepEqual(next.lifecycle,before.lifecycle);
 assert.deepEqual(next.motion,before.motion);
 assert.deepEqual(next.device_mapping,before.device_mapping);
 assert.deepEqual(next.environment,before.environment);
 assert.equal(next.coordinates.selection,'platform');
 assert.equal(next.acceptance.selection,'platform');
});

test('切回平台仍能识别残留内容；明确清空只删除选定组',()=>{
 let details=emptyDetails();details.communication.selection='platform';details.communication.rate_hz=0;
 details.faults.selection='custom';details.faults.recovery='必须人工复位';
 assert.equal(hasDetailExtras('communication',details.communication),true);
 details=clearDetailGroup(details,'communication');
 assert.equal(details.communication.selection,'platform');assert.equal(details.communication.rate_hz,null);
 assert.equal(hasDetailExtras('communication',details.communication),false);
 assert.equal(details.faults.recovery,'必须人工复位');
 const clean=clearDetailGroup(details,'motion');assert.equal(clean.motion.pattern,'from_answers');assert.equal(clean.motion.completion,'all');
});

test('步骤排序保持内容与稳定id，边界不会丢行',()=>{
 const rows=[{id:'a',target_rad:0},{id:'b',target_rad:.3},{id:'c',target_rad:null}];
 assert.deepEqual(reorderRow(rows,1,-1).map(x=>x.id),['b','a','c']);
 assert.deepEqual(reorderRow(rows,2,1),rows);
 assert.deepEqual(rows.map(x=>x.id),['a','b','c']);
});

test('详细需求读写不丢失原话、映射身份、并行动作和检查条件',()=>{
 const draft=newDraft();draft.request='招手三次后再点头';draft.prd.acceptance='不碰桌面';
 const details=draft.prd.intake.details;
 details.motion.pattern='parallel';details.motion.completion='custom';details.motion.completion_note='全部回到起点';
 details.motion.steps=[{id:'s1',kind:'move',joint_name:'arm',target_rad:.1234567890123456,duration_s:null,condition:'',timeout_s:5,on_failure:'停止全部动作',description:'和另一只手同时'}];
 details.device_mapping={scope:'reference_only',entries:[{id:'d1',structure_id:'original',joint_name:'arm',source_sha256:'a'.repeat(64),device:'电机型号待核',driver:'驱动',interface:'CAN1',address:'0',wiring:'见手册',feedback:'编码器',source:'手册第3页',status:'documented'}]};
 details.acceptance={selection:'custom',criteria:[{id:'c1',metric:'往返次数',expected:'3',method:'查看位置记录'}]};
 const read=fromProject({...structuredClone(draft),id:'v2-test',status:'draft'});
 assert.deepEqual(read,draft);read.prd.intake.details.motion.steps[0].description='已修改';
 assert.equal(draft.prd.intake.details.motion.steps[0].description,'和另一只手同时');
});
