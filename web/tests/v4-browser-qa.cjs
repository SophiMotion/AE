// Frontend state acceptance only. API mutations are intercepted in memory;
// these fixtures are NOT backend, AI, compiler, or physical-device evidence.
const { chromium } = require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const clone = x => JSON.parse(JSON.stringify(x));

(async () => {
  const baseline = await (await fetch('http://127.0.0.1:8877/api/runs/430b8bfdc3dc4a4eaac2ed41b58bf04d')).json();
  const original = await (await fetch('http://127.0.0.1:8877/api/projects/' + baseline.project_id)).json();
  const pass = {...clone(original), id:'qa-project', name:'V4 界面验收 · 隔离数据', status:'passed', latest_run_id:'qa-run-one'};
  const source = clone(baseline.code_versions.at(-1));
  const rejected = {...clone(source), attempt:1, firmware_code:source.firmware_code.replace(';',''), status:'rejected', diagnostic:'界面测试夹具：缺少分号，未执行'};
  const accepted = {...source, attempt:2, status:'accepted'};
  const one = {...clone(baseline),id:'qa-run-one',project_id:pass.id,status:'passed',attempt:2,integrity:{fingerprint:'fixture-fingerprint-one'},code_versions:[rejected,accepted],spec_snapshot:{...clone(baseline.spec_snapshot),name:pass.name}};
  const two = {...clone(one),id:'qa-run-two',created_at:'2026-10-03T03:00:00Z',integrity:{fingerprint:'fixture-fingerprint-two'}};
  const review = {...clone(pass),id:'qa-review',name:'V4 人工核对 · 隔离数据',status:'awaiting_approval',latest_run_id:null};
  review.plan={...review.plan,requirement_coverage:{schema_version:1,scope:'本机软件任务',checks:[{id:'position',label:'关节位置误差',expected:{tolerance:0.04}}],items:[{id:'requirement',source_field:'request',text:'达到目标位置',status:'covered',check_ids:['position'],reason:'按运行轨迹检查误差。'},{id:'manual',source_field:'prd.constraints',text:'外观符合展示要求',status:'manual_review',check_ids:[],reason:'需要用户查看，不计作自动检查通过。'}],blocking_issues:[],review_note:'这张表是核对依据，结果以真实运行记录为准。'}};
  const failed = {...clone(pass),id:'qa-failed',name:'V4 失败调用 · 隔离数据',status:'failed',latest_run_id:null,plan:null,plan_failure_provenance:{tool:'UI fixture provider',model:'fixture',prompt:'这是界面测试的失败调用提示词',response:'界面夹具响应',error:'示例格式错误'}};
  let projects=[pass,review,failed], docs=[], fakeId=0;
  const runs={[one.id]:one,[two.id]:two};
  const history=[{id:'qa-history',project_id:pass.id,revision:1,event:'saved',created_at:'2026-10-03T03:00:00Z',snapshot:clone(review)}];
  const exp={run_id:one.id,kind:'repair',title:'界面测试经验 · 非实际入库',summary:'核对真实证据的展示夹具，不作为运行证明。',applicability:{task_type:'joint_position',board:'esp32',ros_distro:'humble',version:'fixture'},result:{passed:true,total_checks:55,passed_checks:55,failed_checks:[],firmware_compiled:true,communication_verified:true},code_versions:[{attempt:2,ros_sha256:'fixture',esp32_sha256:'fixture',ros_excerpt:source.code,esp32_excerpt:source.firmware_code}],evidence:[{label:'规格',path:'spec.json'}],physical_verified:false,publishable:true,preview_hash:'fixture-preview',published_document_id:null,notice:'界面测试，未写入服务数据库。'};
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1536,height:1100},deviceScaleFactor:1});
  page.setDefaultTimeout(25000);
  const errors=[],writes=[],unexpectedWrites=[],out={scope:'intercepted_frontend_fixtures_only',server_mutations:false};
  const fulfill=(route,value)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
  await page.route('**/api/**',async route=>{
    const request=route.request(), url=new URL(request.url()), p=url.pathname, method=request.method();
    if(method!=='GET')writes.push({method,path:p});
    if(p==='/api/projects'&&method==='GET')return fulfill(route,{items:projects});
    if(p==='/api/knowledge'&&method==='GET')return fulfill(route,{items:docs});
    if(p==='/api/knowledge/stats')return fulfill(route,{documents:docs.length,chunks:docs.length,experience_documents:docs.length,retrieval_mode:'sqlite_fts5_bm25'});
    if(p==='/api/projects/import/preview')return fulfill(route,{preview_hash:'fixture-zip-preview',name:'V4 ZIP导入 · 隔离数据',task_type:'joint_position',board:'esp32',joint_name:pass.prd.joint_name,source_run_id:one.id,warnings:['界面测试ZIP；不会交给后台解压。'],has_integrity:false});
    if(p==='/api/projects/import'||(method==='POST'&&p.endsWith('/clone'))){
      const value={...clone(pass),id:'qa-new-'+(++fakeId),name:p.includes('/import')?'V4 ZIP导入 · 隔离数据':'V4 复制草稿 · 隔离数据',status:'draft',plan:null,approval:null,latest_run_id:null};projects=[value,...projects];return fulfill(route,value);
    }
    if(p.endsWith('/history'))return fulfill(route,{items:history});
    if(p.endsWith('/experience')){
      if(method==='GET')return fulfill(route,exp);
      if(method==='POST') { const body=request.postDataJSON();assert.equal(body.confirm,true);assert.equal(body.preview_hash,exp.preview_hash);const doc={id:'experience-qa',document_id:'experience-qa',title:exp.title,content:exp.summary,version:'fixture',board:'esp32',ros_distro:'humble',origin:'experience',experience_kind:'repair',content_kind:'summary',url:'knowledge://fixture',tags:[],license:'界面测试',uploaded:false};docs=[doc];exp.published_document_id=doc.id;return fulfill(route,doc); }
    }
    if(p==='/api/knowledge/documents/experience-qa'){
      if(method==='DELETE'){docs=[];return fulfill(route,{deleted:true});}
      return fulfill(route,{document:docs[0],pages:[{page:null,text:'完整界面测试原文，未写入数据库。'}],chunks:[],source_bytes_sha256:'fixture',original_available:true,notice:'界面测试完整原文'});
    }
    const projectMatch=p.match(/^\/api\/projects\/([^/]+)$/);
    if(projectMatch&&projects.some(x=>x.id===projectMatch[1]))return fulfill(route,projects.find(x=>x.id===projectMatch[1]));
    if(/^\/api\/projects\/qa-[^/]+\/runs$/.test(p))return fulfill(route,{items:p.includes('/qa-project/')?[one,two]:[]});
    const runMatch=p.match(/^\/api\/runs\/([^/]+)$/);if(runMatch&&runs[runMatch[1]])return fulfill(route,runs[runMatch[1]]);
    if(!['GET','HEAD','OPTIONS'].includes(method)){unexpectedWrites.push(p);return route.abort();}
    return route.continue();
  });
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  try {
    await page.goto('http://127.0.0.1:5178',{waitUntil:'networkidle'});
    out.title=await page.title();assert.match(out.title,/AE|Engineering/);
    await page.locator('.run-spec-note').filter({hasText:'qa-run-o'}).waitFor();
    await page.getByRole('tab',{name:'两端代码',exact:true}).click();
    await page.getByRole('button',{name:'ESP32 · C++',exact:true}).click();
    await page.getByRole('button',{name:'与上一版比较',exact:true}).click();
    assert.equal(await page.locator('.diff-line.removed').count(),1);assert.equal(await page.locator('.diff-line.added').count(),1);out.realLineDiff=true;
    await page.locator('.evidence').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/ui-v4-diff.png')});
    await page.getByLabel('选择代码版本').selectOption('0');await page.getByText(/这版 AI 源码未通过代码检查/).waitFor();out.rejectedVisible=true;
    const deployment=page.locator('.result-panel > .approval-box');
    await deployment.locator('input').check();assert.equal(await deployment.getByRole('button',{name:'部署并复测'}).isEnabled(),true);
    await page.getByLabel('查看历史运行').selectOption(two.id);
    assert.equal(await deployment.locator('input').isChecked(),false);assert.equal(await deployment.getByRole('button',{name:'部署并复测'}).isDisabled(),true);out.confirmReset=true;
    await page.getByLabel('查看历史运行').selectOption(one.id);
    await page.getByRole('button',{name:'查看并保存经验'}).click();await page.getByText(exp.title,{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'核对后存入资料库'}).isDisabled(),true);
    await page.getByLabel('已核对范围、代码和结果，允许后续匹配任务作为参考').check();await page.getByRole('button',{name:'核对后存入资料库'}).click();await page.getByText(/已存入资料库/).waitFor();out.experienceReview=true;
    await page.getByRole('button',{name:'资料库',exact:true}).click();await page.getByLabel('按资料来源筛选').selectOption('experience');await page.getByRole('button',{name:'查看完整内容'}).click();await page.getByText('完整界面测试原文，未写入数据库。',{exact:true}).waitFor();out.originalView=true;
    await page.screenshot({path:path.join(root,'docs/ui-v4-library.png')});
    await page.getByRole('button',{name:/删除资料 界面测试经验/}).click();await page.getByRole('button',{name:'确认移除',exact:true}).click();await page.getByText('没有匹配的资料',{exact:true}).waitFor();out.experienceRemoved=true;
    await page.getByRole('button',{name:'工作台',exact:true}).click();await page.getByRole('button',{name:'版本与复用',exact:true}).click();await page.locator('.history-entry > summary').click();await page.getByText('从这个版本新建',{exact:true}).waitFor();await page.screenshot({path:path.join(root,'docs/ui-v4-history.png')});
    await page.getByRole('button',{name:'复制本轮为新草稿'}).click();await page.getByRole('heading',{name:'V4 复制草稿 · 隔离数据',exact:true}).waitFor();out.cloneDraft=true;
    await page.getByRole('button',{name:'导入工程 ZIP',exact:true}).click();
    await page.getByLabel('选择工程 ZIP 文件').setInputFiles({name:'qa.zip',mimeType:'application/zip',buffer:Buffer.from('frontend fixture only')});
    await page.getByRole('heading',{name:'V4 ZIP导入 · 隔离数据',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'导入为新草稿'}).isDisabled(),true);
    await page.getByLabel('已核对，作为新草稿导入；不继承旧批准或通过状态').check();await page.getByRole('button',{name:'导入为新草稿'}).click();await page.getByRole('heading',{name:'V4 ZIP导入 · 隔离数据',exact:true}).waitFor();out.zipPreviewConfirm=true;
    await page.getByRole('button',{name:/V4 人工核对 · 隔离数据/}).click();await page.getByText('外观符合展示要求',{exact:true}).waitFor();
    assert.equal(await page.locator('.coverage-item.manual_review').count(),1);assert.equal(await page.locator('.ai-plan-fields .plan-list').count(),4);out.coverageAndAILabels=true;
    await page.locator('.coverage-panel').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/ui-v4-coverage.png')});
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);await page.locator('.coverage-panel').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/ui-v4-mobile.png')});
    out.mobile=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(out.mobile.width,out.mobile.scroll);
    await page.setViewportSize({width:1536,height:1100});await page.getByRole('button',{name:/V4 失败调用 · 隔离数据/}).click();await page.getByRole('tab',{name:'AI 记录',exact:true}).click();await page.getByText('这是界面测试的失败调用提示词',{exact:true}).waitFor();out.failedPromptVisible=true;
    assert.equal(await page.locator('vite-error-overlay').count(),0);assert.deepEqual(unexpectedWrites,[]);assert.deepEqual(errors,[]);
    out.errors=errors;out.mockWrites=writes;out.passed=true;
  } catch(error) {out.error=String(error);out.errors=errors;out.mockWrites=writes;out.unexpectedWrites=unexpectedWrites;out.passed=false;await page.screenshot({path:path.join(root,'docs/ui-v4-error.png')});process.exitCode=1;}
  finally {fs.writeFileSync(path.join(root,'docs/frontend-v4-mock-qa.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));await browser.close();}
})();
