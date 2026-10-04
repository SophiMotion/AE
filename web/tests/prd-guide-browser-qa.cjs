// PRD guide acceptance. Writes only drafts created by this test; no AI/ROS.
const {chromium}=require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'), server='http://127.0.0.1:8877';
const host=process.env.GUIDE_QA_URL||'http://127.0.0.1:5178';
const legacyId='0c2512be926e4290bb064c2537aa9cf1';
(async()=>{
 const before=await (await fetch(`${server}/api/projects/${legacyId}`)).json();
 const model=await (await fetch(`${server}/api/structures/builtin-joint`)).json();
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1536,height:1100},deviceScaleFactor:1});page.setDefaultTimeout(30000);
 const out={url:host,scope:'own_PRD_draft_only',errors:[],blocked:[],writes:[],ai_or_ros_started:false,feishu_written:false};
 const ids=new Set();let holdSave=false,holdReady=false,holdUpload=false,releaseSave=null,releaseReady=null,releaseUpload=null,lastPreview=null;
 page.on('pageerror',e=>out.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')out.errors.push(m.text());});
 await page.route('**/api/**',async route=>{
  const request=route.request(),p=new URL(request.url()).pathname,m=request.method();
  if(['GET','HEAD','OPTIONS'].includes(m))return route.continue();
  if(p==='/api/prd/preview'&&m==='POST'){
   lastPreview=request.postDataJSON();
   if(holdReady){holdReady=false;const response=await route.fetch();const json=await response.json();await new Promise(resolve=>releaseReady=resolve);return route.fulfill({response,json});}
   return route.continue();
  }
  if(p==='/api/structures'&&m==='POST'&&holdUpload){holdUpload=false;await new Promise(resolve=>releaseUpload=resolve);return route.fulfill({json:model});}
  if((p==='/api/projects'&&m==='POST')||(m==='PUT'&&ids.has(p.split('/').pop()))){
   out.writes.push({m,p});
   if(holdSave){holdSave=false;await new Promise(resolve=>releaseSave=resolve);}
   return route.continue();
  }
  out.blocked.push({m,p});return route.abort();
 });
 const step=index=>page.locator('.guide-steps button').nth(index).click();
 async function save(){
  const waiter=page.waitForResponse(r=>['POST','PUT'].includes(r.request().method())&&/^\/api\/projects(?:\/[^/]+)?$/.test(new URL(r.url()).pathname));
  await page.getByRole('button',{name:'保存需求',exact:true}).click();const response=await waiter;const project=await response.json();
  assert.equal(response.status(),200,JSON.stringify(project));ids.add(project.id);assert.equal(project.status,'draft');assert.equal(project.approval,null);assert.equal(project.plan,null);return project;
 }
 async function waitPreview(predicate){await page.waitForFunction(()=>document.querySelector('.guide-readiness')?.textContent&&!document.querySelector('.guide-readiness.checking'));if(predicate)assert.ok(predicate(lastPreview),JSON.stringify(lastPreview));}
 try{
  await page.goto(`${host}/?project=${legacyId}`,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'修改需求',exact:true}).click();
  await page.getByRole('button',{name:'按新表单整理',exact:true}).waitFor();
  assert.equal(await page.locator('.intake-guide').count(),0);out.legacyUnmigrated=true;
  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  await page.getByLabel('需求引导表单').waitFor();
  assert.equal(await page.getByLabel('你希望机器人做什么',{exact:true}).inputValue(),'');
  assert.equal(await page.locator('[role=radio][aria-checked=true]').count(),0);
  const empty=await save();out.emptyDraftId=empty.id;assert.equal(empty.prd.intake.intent,null);assert.equal(empty.prd.intake.answers.board,null);assert.equal(empty.prd.intake.answers.target_rad,null);assert.equal(empty.task_type,null);
  await page.reload({waitUntil:'networkidle'});await page.getByLabel('需求引导表单').waitFor();
  assert.equal(await page.getByLabel('工程名称',{exact:true}).inputValue(),'');out.emptyRoundTrip=true;
  await page.getByLabel('工程名称',{exact:true}).fill('PRD 界面验收 · 招手需求');
  await page.getByLabel('你希望机器人做什么',{exact:true}).fill('让机器人右手来回招手三次，最后回到原位。');
  await page.getByRole('radio',{name:/来回摆动/}).click();
  await page.locator('.intake-guide').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-step1.png')});
  await step(1);await page.getByLabel('结构模型',{exact:true}).selectOption('builtin-joint');
  await page.getByLabel('本轮控制的关节',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="本轮控制的关节"]')?.options.length>1);
  assert.equal(await page.getByLabel('本轮控制的关节',{exact:true}).inputValue(),'');out.noAutomaticJoint=true;
  await page.getByLabel('本轮控制的关节',{exact:true}).selectOption('test_joint');
  // A deliberately held upload response tests UI locking, not server import.
  holdUpload=true;await page.getByLabel('导入结构文件').setInputFiles({name:'ui-upload-lock.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(model))});
  await page.waitForFunction(()=>document.querySelector('.guide-steps button')?.disabled===true);
  assert.equal(await page.getByRole('button',{name:'保存需求',exact:true}).isDisabled(),true);out.uploadLocksNavigation=true;
  while(!releaseUpload)await new Promise(r=>setTimeout(r,20));releaseUpload();
  await page.waitForFunction(()=>document.querySelector('.guide-steps button')?.disabled===false);
  await page.getByLabel('本轮控制的关节',{exact:true}).selectOption('test_joint');
  await step(2);await page.getByLabel('位置 A',{exact:true}).fill('10');await page.getByLabel('位置 B',{exact:true}).fill('30');
  await page.getByRole('button',{name:'采用空白项建议',exact:true}).click();
  await page.getByLabel('结束姿态',{exact:true}).selectOption('return_start');
  await page.getByLabel('位置 A',{exact:true}).fill('');
  await new Promise(r=>setTimeout(r,500));assert.equal(lastPreview.prd.intake.answers.wave_start_rad,null);out.blankNotZero=true;
  await page.getByRole('button',{name:'弧度 rad',exact:true}).click();
  await page.getByLabel('位置 A',{exact:true}).fill('0.12345678901234567');
  await page.getByRole('button',{name:'度 °',exact:true}).click();
  await page.getByRole('button',{name:'弧度 rad',exact:true}).click();
  assert.equal(await page.getByLabel('位置 A',{exact:true}).inputValue(),'0.12345678901234566');
  await page.getByRole('button',{name:'度 °',exact:true}).click();
  await page.locator('.guide-step-heading').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-step3.png')});
  await step(3);assert.equal(await page.getByLabel('目标控制板',{exact:true}).inputValue(),'');
  await page.getByRole('radio',{name:/先在电脑里验证/}).click();await page.getByLabel('目标控制板',{exact:true}).selectOption('esp32s3');
  await step(4);await page.getByLabel('怎样才算完成',{exact:true}).fill('往返三次后回到位置A；不连接实物。');
  await page.getByLabel('必须遵守的限制',{exact:true}).fill('这是界面验收草稿，不启动AI或ROS。');
  await waitPreview();assert.equal(await page.getByRole('button',{name:'让 AI 拆分',exact:true}).isDisabled(),true);
  // Delay a genuine save to prove typing cannot be overwritten by its response.
  holdSave=true;const waveSave=save();
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="怎样才算完成"]')?.disabled===true);
  assert.equal(await page.locator('.guide-steps button').first().isDisabled(),true);out.saveLocksEditing=true;
  while(!releaseSave)await new Promise(r=>setTimeout(r,20));releaseSave();
  const wave=await waveSave;out.wave={id:wave.id,readiness:wave.intake_readiness.status,answers:wave.prd.intake.answers};
  assert.equal(wave.task_type,null);assert.equal(wave.intake_readiness.can_plan,false);assert.equal(wave.prd.intake.answers.wave_start_rad,Number('0.12345678901234567'));assert.ok(Math.abs(wave.prd.intake.answers.wave_end_rad-Math.PI/6)<1e-14);out.unitPrecisionRetained=true;
  await page.locator('.guide-review').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-summary.png')});
  await page.reload({waitUntil:'networkidle'});await step(0);assert.equal(await page.getByLabel('你希望机器人做什么',{exact:true}).inputValue(),wave.request);await step(4);assert.equal(await page.getByLabel('怎样才算完成',{exact:true}).inputValue(),wave.prd.acceptance);out.waveRoundTrip=true;
  // Separate own draft for the supported route; do not click the AI action.
  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  await page.getByLabel('工程名称',{exact:true}).fill('PRD 界面验收 · 固定位置');await page.getByLabel('你希望机器人做什么',{exact:true}).fill('让一个模拟关节到达目标位置，检查误差和通信。');
  await page.getByRole('radio',{name:/转到一个位置/}).click();await step(1);await page.getByLabel('结构模型',{exact:true}).selectOption('builtin-joint');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="本轮控制的关节"]')?.options.length>1);await page.getByLabel('本轮控制的关节',{exact:true}).selectOption('test_joint');
  await step(2);await page.getByLabel('转到哪个角度',{exact:true}).fill('20');await page.getByRole('button',{name:'采用空白项建议',exact:true}).click();
  await step(3);await page.getByRole('radio',{name:/先在电脑里验证/}).click();await page.getByLabel('目标控制板',{exact:true}).selectOption('esp32');
  await step(4);await page.getByLabel('怎样才算完成',{exact:true}).fill('到达目标角度，误差符合要求，软件通信检查通过。');
  await page.getByText('必要信息已齐，可以交给 AI 拆分',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'让 AI 拆分',exact:true}).isDisabled(),false);
  const ready=await save();out.ready={id:ready.id,can_plan:ready.intake_readiness.can_plan,target:ready.parameters.target};assert.equal(ready.intake_readiness.can_plan,true);assert.ok(Math.abs(ready.parameters.target-Math.PI/9)<1e-14);
  // Hold an old ready preview, edit to unsupported mode, then release the old response.
  holdReady=true;await page.getByLabel('必须遵守的限制',{exact:true}).fill('仅在电脑中测试。');
  while(!releaseReady)await new Promise(r=>setTimeout(r,30));
  await step(3);await page.getByRole('radio',{name:/先整理实物资料/}).click();await step(4);
  assert.equal(await page.getByRole('button',{name:'让 AI 拆分',exact:true}).isDisabled(),true);
  releaseReady();await new Promise(r=>setTimeout(r,700));
  assert.equal(await page.getByRole('button',{name:'让 AI 拆分',exact:true}).isDisabled(),true);out.staleReadyIgnored=true;
  await step(3);await page.getByLabel('电机或舵机型号',{exact:true}).fill('待核对的电机');await page.getByLabel('电机或舵机型号的出处',{exact:true}).fill('用户准备后续提供的手册');
  const notes=await save();out.hardwareNotes=notes.prd.intake.hardware_notes.motor_model;assert.equal(notes.intake_readiness.can_plan,false);assert.equal(out.hardwareNotes.status,'documented');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);await step(4);await page.locator('.guide-step-heading').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-mobile.png')});
  out.mobile=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(out.mobile.width,out.mobile.scroll);
  const after=await (await fetch(`${server}/api/projects/${legacyId}`)).json();assert.deepEqual(after,before);out.legacyUnchanged=true;
  assert.deepEqual(out.blocked,[]);assert.deepEqual(out.errors,[]);out.passed=true;
 }catch(error){out.passed=false;out.error=String(error);process.exitCode=1;await page.screenshot({path:path.join(root,'docs/prd-guide-ui-error.png')});}
 finally{if(releaseSave)releaseSave();if(releaseReady)releaseReady();if(releaseUpload)releaseUpload();out.createdProjects=[...ids];fs.writeFileSync(path.join(root,'docs/prd-guide-live-ui.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));await browser.close();}
})();
