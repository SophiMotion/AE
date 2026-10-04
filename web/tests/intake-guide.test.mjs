import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyIntake, changeIntent, changeAnswer, acceptSuggestions, migrateLegacyIntake, parseDisplayNumber, formatDisplayNumber, matchingPreview} from '../src/intakeGuide.ts';
import {newDraft, fromProject, draftIsChanged, emptyDraft} from '../src/draft.ts';

test('新稿没有替用户选择意图、板型或关节，数值保持空白',()=>{
 const draft=newDraft();
 assert.equal(draft.prd.intake.intent,null);
 assert.equal(draft.prd.intake.answers.board,null);
 assert.equal(draft.prd.intake.answers.joint_name,null);
 assert.equal(draft.prd.intake.answers.target_rad,null);
 assert.equal(draft.request,'');
});
test('切换意图保留原话和自定义条件，改变答案撤销相应建议来源',()=>{
 const draft={...newDraft(),request:'让机器人跟我招手',prd:{...newDraft().prd,constraints:'只在电脑里试',acceptance:'挥三次再回到原位'}};
 const changed=changeIntent(draft,'oscillate');
 assert.equal(changed.request,draft.request);assert.equal(changed.prd.acceptance,draft.prd.acceptance);assert.equal(changed.prd.constraints,draft.prd.constraints);
 const suggested=acceptSuggestions(changed,{duration_s:8,tolerance_rad:.04});
 assert.ok(suggested.prd.intake.accepted_suggestions.includes('answers.duration_s'));
 const edited=changeAnswer(suggested,'duration_s',9);
 assert.ok(!edited.prd.intake.accepted_suggestions.includes('answers.duration_s'));
 assert.ok(edited.prd.intake.accepted_suggestions.includes('answers.tolerance_rad'));
 assert.equal(edited.parameters.target,draft.parameters.target,'前端不能另写legacy执行参数');
});
test('空白及无效数字不变成0，度数输入转换且单位显示不改源数值',()=>{
 for(const text of ['', ' ', '-', 'abc','Infinity'])assert.equal(parseDisplayNumber(text,'deg'),null);
 assert.equal(parseDisplayNumber('0','deg'),0);
 assert.ok(Math.abs(parseDisplayNumber('90','deg')-Math.PI/2)<1e-14);
 const rad=.12345678901234567;
 assert.equal(formatDisplayNumber(rad,'rad'),String(rad));
 formatDisplayNumber(rad,'deg');assert.equal(rad,.12345678901234567);
 assert.equal(formatDisplayNumber(null,'deg'),'');
});
test('旧工程浏览不自动迁移或变脏，只有明确操作才生成intake',()=>{
 const p={...structuredClone(emptyDraft),id:'legacy',prd:{...emptyDraft.prd},status:'approved'};
 delete p.prd.intake;
 const draft=fromProject(p);
 assert.equal(draft.prd.intake,undefined);assert.equal(draftIsChanged(draft,p),false);
 const migrated=migrateLegacyIntake(draft);
 assert.equal(migrated.prd.intake.answers.target_rad,p.parameters.target);
 assert.equal(migrated.prd.intake.answers.board,p.hardware.board);
 assert.equal(migrated.request,p.request);assert.equal(draftIsChanged(migrated,p),true);
});
test('预览只认可同一草稿快照；旧ready不能启用新需求',()=>{
 const ready={can_plan:true,status:'ready_for_plan'};
 assert.equal(matchingPreview('new',{key:'old',data:ready}),null);
 assert.equal(matchingPreview('same',{key:'same',data:ready}),ready);
});
