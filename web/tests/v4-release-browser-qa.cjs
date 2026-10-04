// Final release QA: reads the accepted run, previews a ZIP, and round-trips one
// tiny removable SDK-metadata document. Never starts AI, compilation or ROS.
const { chromium } = require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const server = 'http://127.0.0.1:8877';
const pid = '0c2512be926e4290bb064c2537aa9cf1';
const rid = '34ddb1dd80904d709188269625799313';
(async () => {
 const project = await (await fetch(`${server}/api/projects/${pid}`)).json();
 const run = await (await fetch(`${server}/api/runs/${rid}`)).json();
 const out = {scope:'production_8877_readonly_plus_removable_sdk_document',project_id:pid,run_id:rid,errors:[],blocked:[],writes:[],ai_or_ros_started:false,feishu_written:false};
 let uploadedId = null;
 const browser = await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
 const page = await browser.newPage({viewport:{width:1536,height:1100},deviceScaleFactor:1});
 page.setDefaultTimeout(30000);
 page.on('pageerror',e=>out.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')out.errors.push(m.text());});
 await page.route('**/api/**',async route=>{
  const req=route.request(), p=new URL(req.url()).pathname, m=req.method();
  if(['GET','HEAD','OPTIONS'].includes(m))return route.continue();
  if((m==='POST'&&['/api/projects/import/preview','/api/knowledge/documents'].includes(p))||(m==='DELETE'&&uploadedId&&p===`/api/knowledge/documents/${uploadedId}`)){
   out.writes.push({m,p});return route.continue();
  }
  out.blocked.push({m,p});return route.abort();
 });
 try {
  await page.goto(`${server}/?project=${pid}`,{waitUntil:'networkidle'});
  await page.locator('.run-spec-note').filter({hasText:rid.slice(0,8)}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('project'),pid);
  assert.equal(run.result.passed,true);
  assert.ok(run.integrity.fingerprint);
  await page.getByText('本轮运行检查通过',{exact:true}).waitFor();
  await page.getByText(/通过版本指纹/).first().waitFor();
  out.actualCheckCount=run.result.checks.length;
  out.actualPassedChecks=run.result.checks.filter(check=>check.passed).length;
  await page.locator('.result-panel').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v4-release-result.png')});
  await page.getByRole('button',{name:'导入工程 ZIP',exact:true}).click();
  const previewWait=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects/import/preview');
  await page.getByLabel('选择工程 ZIP 文件').setInputFiles(path.join(root,'runs','430b8bfdc3dc4a4eaac2ed41b58bf04d','engineering-bundle.zip'));
  const previewResponse=await previewWait;out.zipPreview=await previewResponse.json();
  assert.equal(previewResponse.status(),200,JSON.stringify(out.zipPreview));
  assert.equal(await page.getByRole('button',{name:'导入为新草稿'}).isDisabled(),true);
  await page.locator('.project-tools').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v4-release-import.png')});
  await page.getByRole('button',{name:'关闭工程工具'}).click();
  await page.getByRole('button',{name:'资料库',exact:true}).click();
  await page.getByRole('button',{name:'导入资料',exact:true}).click();
  await page.locator('.model-scope > summary').click();
  assert.equal(await page.getByLabel('资料适用结构',{exact:true}).inputValue(),'unknown');
  assert.equal(await page.getByLabel('ESP32 核心版本',{exact:true}).inputValue(),'unknown');
  assert.equal(await page.getByLabel('ArduinoJson 版本',{exact:true}).inputValue(),'unknown');
  await page.getByLabel('资料适用结构',{exact:true}).selectOption('any');
  await page.getByLabel('ESP32 核心版本',{exact:true}).selectOption('custom');
  await page.getByLabel('ESP32 核心版本具体值',{exact:true}).fill(project.manifest.dependencies.esp32_core);
  await page.getByLabel('ArduinoJson 版本',{exact:true}).selectOption('custom');
  await page.getByLabel('ArduinoJson 版本具体值',{exact:true}).fill(project.manifest.dependencies.arduinojson);
  await page.getByLabel('选择知识资料文件').setInputFiles({name:'v4-sdk-ui-roundtrip.cpp',mimeType:'text/plain',buffer:Buffer.from('// Temporary UI metadata QA; not a driver or deployment example.\nint metadata_qa() { return 0; }\n')});
  await page.getByLabel('资料名称',{exact:true}).fill('V4 UI SDK 元数据往返测试（随后移除）');
  await page.getByLabel('适用版本',{exact:true}).fill('1.0');
  await page.getByLabel('适用板型',{exact:true}).selectOption(project.hardware.board);
  await page.getByLabel('适用 ROS 版本',{exact:true}).selectOption(project.manifest.ros_distro||'humble');
  await page.getByLabel('关节位置',{exact:true}).check();
  await page.locator('.model-scope').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v4-release-rag-scope.png')});
  const uploadWait=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/knowledge/documents');
  await page.getByRole('button',{name:'导入并建立索引',exact:true}).click();
  const uploadResponse=await uploadWait, uploaded=await uploadResponse.json();
  assert.equal(uploadResponse.status(),200,JSON.stringify(uploaded));
  uploadedId=uploaded.document_id||uploaded.id;
  assert.ok(uploadedId,JSON.stringify(uploaded));
  const detail=await (await fetch(`${server}/api/knowledge/documents/${uploadedId}`)).json();
  assert.deepEqual(detail.document.software_versions,{esp32_core:project.manifest.dependencies.esp32_core,arduinojson:project.manifest.dependencies.arduinojson});
  assert.equal(detail.document.robot_model,'any');
  out.uploadedDocument={id:uploadedId,software_versions:detail.document.software_versions,robot_model:detail.document.robot_model,generation_eligible:detail.document.generation_eligible};
  await page.getByLabel('搜索资料',{exact:true}).fill('V4 UI SDK 元数据往返测试');
  const card=page.locator('.source-item').filter({hasText:'V4 UI SDK 元数据往返测试'}).first();
  await card.waitFor();
  await card.getByRole('button',{name:'查看完整内容'}).click();
  await page.locator('.document-detail').waitFor();
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);
  await page.locator('.document-detail').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v4-release-mobile.png')});
  out.mobile=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
  if(out.mobile.viewport!==out.mobile.document)out.overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].map(el=>({tag:el.tagName,cls:el.className,text:el.textContent.slice(0,90),right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width,scroll:el.scrollWidth,client:el.clientWidth,overflow:getComputedStyle(el).overflowX})).filter(x=>x.width>0&&(x.right>innerWidth+1||(x.scroll>x.client+1&&x.overflow==='visible'))).slice(-20));
  assert.equal(out.mobile.viewport,out.mobile.document);
  await page.setViewportSize({width:1536,height:1100});await page.waitForTimeout(250);
  await card.getByRole('button',{name:/删除资料/}).click();
  const deleteWait=page.waitForResponse(r=>r.request().method()==='DELETE'&&new URL(r.url()).pathname.endsWith(uploadedId));
  await card.getByRole('button',{name:'确认移除',exact:true}).click();
  assert.equal((await deleteWait).status(),200);out.uploadRemoved=true;
  await page.goto(`${server}/?project=${pid}`,{waitUntil:'networkidle'});
  await page.locator('.run-spec-note').filter({hasText:rid.slice(0,8)}).waitFor();
  await page.reload({waitUntil:'networkidle'});
  await page.locator('.run-spec-note').filter({hasText:rid.slice(0,8)}).waitFor();
  out.directProjectReload=true;
  assert.deepEqual(out.blocked,[]);assert.deepEqual(out.errors,[]);out.passed=true;
 }catch(error){out.passed=false;out.error=String(error);process.exitCode=1;await page.screenshot({path:path.join(root,'docs/ui-v4-release-error.png')});}
 finally{
  if(uploadedId&&!out.uploadRemoved){const r=await fetch(`${server}/api/knowledge/documents/${uploadedId}`,{method:'DELETE'});out.cleanupStatus=r.status;}
  fs.writeFileSync(path.join(root,'docs/frontend-v4-release-qa.json'),JSON.stringify(out,null,2));
  console.log(JSON.stringify(out));await browser.close();
 }
})();
