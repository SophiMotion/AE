// Production PRD smoke: readonly API + previews. Upload-race fixture is labelled.
const {chromium}=require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),host='http://127.0.0.1:8877';
function specZip(spec){
 const name=Buffer.from('spec.json'),data=Buffer.from(JSON.stringify(spec));let crc=0xffffffff;
 for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);head.writeUInt32LE(crc,14);head.writeUInt32LE(data.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+name.length,12);end.writeUInt32LE(30+name.length+data.length,16);
 return Buffer.concat([head,name,data,central,name,end]);
}
(async()=>{
 const wave=await (await fetch(`${host}/api/projects/b647607ebcb44983a604ebe7b57d6c23`)).json();
 const model=await (await fetch(`${host}/api/structures/builtin-joint`)).json();
 const empty=structuredClone(wave);empty.name='空白需求导入预览';empty.task_type=null;empty.structure=null;empty.execution_model=null;empty.manifest=null;empty.prd.intake.intent=null;empty.prd.intake.answers.board=null;empty.prd.intake.answers.joint_name=null;empty.prd.intake.answers.structure_id=null;
 const out={url:host,readonly:true,ai_or_ros_started:false,errors:[],blocked:[]};
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});const page=await browser.newPage({viewport:{width:1536,height:1100},deviceScaleFactor:1});page.setDefaultTimeout(30000);
 let uploadHeld=false,releaseUpload=null,lastBody=null,lastReadiness=null;
 page.on('pageerror',e=>out.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')out.errors.push(m.text());});
 await page.route('**/api/**',async route=>{
  const req=route.request(),p=new URL(req.url()).pathname,m=req.method();
  if(['GET','HEAD','OPTIONS'].includes(m))return route.continue();
  if(p==='/api/prd/preview'){lastBody=req.postDataJSON();const response=await route.fetch();lastReadiness=await response.json();return route.fulfill({response,json:lastReadiness});}
  if(p==='/api/projects/import/preview')return route.continue();
  if(p==='/api/structures'&&uploadHeld){uploadHeld=false;await new Promise(resolve=>releaseUpload=resolve);return route.fulfill({json:model});}
  out.blocked.push({m,p});return route.abort();
 });
 const step=i=>page.locator('.guide-steps button').nth(i).click();
 try{
  await page.goto(`${host}/?project=${wave.id}`,{waitUntil:'networkidle'});await step(4);
  await page.getByText('这份需求可以保存，当前还不能执行',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.toast'));
  await page.locator('.guide-review').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-release-summary.png')});
  out.waveOnlyRequirements=await page.getByRole('button',{name:'让 AI 拆分',exact:true}).isDisabled();assert.equal(out.waveOnlyRequirements,true);
  await step(2);await page.locator('.guide-step-heading').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-release-action.png')});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);await step(4);await page.getByText('这份需求可以保存，当前还不能执行',{exact:true}).waitFor();await page.locator('.guide-review').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-release-mobile.png')});
  out.mobile=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(out.mobile.width,out.mobile.scroll);
  await page.setViewportSize({width:1536,height:1100});await page.waitForTimeout(250);
  await page.getByRole('button',{name:'新建任务',exact:true}).click();await step(4);
  await page.getByText('还需要补充一些信息',{exact:true}).waitFor();
  const modeIssue=lastReadiness.missing.find(i=>i.path.endsWith('.mode'));assert.equal(modeIssue.section,4);
  await page.locator('.guide-issues li').filter({hasText:modeIssue.label}).getByRole('button').click();
  await page.getByRole('radio',{name:/先在电脑里验证/}).waitFor();out.missingLinksToMode=true;
  await step(0);await page.getByRole('radio',{name:/达到条件后触发/}).click();await step(2);assert.equal(await page.getByLabel('允许多大误差',{exact:true}).count(),0);out.thresholdNoIgnoredTolerance=true;
  await step(0);await page.getByRole('radio',{name:/转到一个位置/}).click();await step(4);await page.getByText('还需要补充一些信息',{exact:true}).waitFor();
  const durationIssue=lastReadiness.missing.find(i=>i.path.endsWith('.duration_s'));assert.equal(durationIssue.section,3);
  await page.locator('.guide-issues li').filter({hasText:durationIssue.label}).getByRole('button').click();await page.getByLabel('本轮观察多久',{exact:true}).waitFor();out.missingLinksToAction=true;
  // An upload response from a departed form cannot affect a newly opened form.
  await step(1);uploadHeld=true;await page.getByLabel('导入结构文件').setInputFiles({name:'late-ui-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(model))});
  await page.waitForFunction(()=>document.querySelector('.guide-steps button')?.disabled===true);
  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  while(!releaseUpload)await new Promise(resolve=>setTimeout(resolve,20));releaseUpload();await new Promise(resolve=>setTimeout(resolve,400));
  await page.getByRole('radio',{name:/转到一个位置/}).click();await step(1);assert.equal(await page.getByLabel('结构模型',{exact:true}).inputValue(),'');assert.equal(await page.getByRole('button',{name:'保存需求',exact:true}).isDisabled(),false);out.oldUploadIgnoredAfterSwitch={passed:true,scope:'delayed_upload_fixture_only_no_server_write'};
  await page.getByRole('button',{name:'导入工程 ZIP',exact:true}).click();
  const waiter=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects/import/preview');
  await page.getByLabel('选择工程 ZIP 文件').setInputFiles({name:'blank-guided-prd.zip',mimeType:'application/zip',buffer:specZip(empty)});
  const response=await waiter,preview=await response.json();assert.equal(response.status(),200,JSON.stringify(preview));assert.equal(preview.board,null);assert.equal(preview.task_type,null);
  await page.getByText('待整理 / 仅保存需求 / 板型待选',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'导入为新草稿',exact:true}).isDisabled(),true);out.nullableImportPreview=preview;
  await page.locator('.project-tools').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-guide-release-import.png')});
  assert.deepEqual(out.errors,[]);assert.deepEqual(out.blocked,[]);out.passed=true;
 }catch(error){out.passed=false;out.error=String(error);process.exitCode=1;await page.screenshot({path:path.join(root,'docs/prd-guide-release-error.png')});}
 finally{if(releaseUpload)releaseUpload();fs.writeFileSync(path.join(root,'docs/prd-guide-release-ui.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));await browser.close();}
})();
