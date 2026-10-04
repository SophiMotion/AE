// Uses real V4 API only for newly created drafts and one removable experience.
// Blocks plan, run, deploy, settings, and mutations of existing user projects.
const { chromium } = require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const runId = '430b8bfdc3dc4a4eaac2ed41b58bf04d';
const server = 'http://127.0.0.1:8877';
(async () => {
 const originalRun=await (await fetch(server+'/api/runs/'+runId)).json();
 const original=await (await fetch(server+'/api/projects/'+originalRun.project_id)).json();
 const initialExperience=await (await fetch(server+'/api/runs/'+runId+'/experience')).json();
 if(!initialExperience.preview_hash)throw Error(JSON.stringify(initialExperience));
 const qaIds=new Set(),writes=[],blocked=[],errors=[],out={scope:'real_api_new_drafts_only',source_run:runId,ai_or_ros_started:false,feishu_written:false};
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1536,height:1100},deviceScaleFactor:1});page.setDefaultTimeout(30000);
 await page.route('**/api/**',async route=>{
   const r=route.request(),p=new URL(r.url()).pathname,m=r.method();
   if(['GET','HEAD','OPTIONS'].includes(m))return route.continue();
   const project=p.match(/^\/api\/projects\/([^/]+)(\/history\/[^/]+\/clone)?$/);
   const allowed=(m==='POST'&&['/api/projects/import/preview','/api/projects/import',`/api/runs/${runId}/clone`,`/api/runs/${runId}/experience`].includes(p))||(project&&qaIds.has(project[1])&&((m==='PUT'&&!project[2])||(m==='POST'&&project[2])))||(m==='DELETE'&&!initialExperience.published_document_id&&p===`/api/knowledge/documents/experience-${runId}`);
   if(!allowed){blocked.push({m,p});return route.abort();}
   writes.push({m,p});return route.continue();
 });
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 async function createdFrom(action, suffix){const waiter=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(suffix));await action();const response=await waiter;const value=await response.json();assert.equal(response.status(),200,JSON.stringify(value));qaIds.add(value.id);assert.equal(value.status,'draft');assert.equal(value.approval,null);assert.equal(value.plan,null);return value;}
 async function rename(name){await page.getByLabel('工程名称',{exact:true}).fill(name);const waiter=page.waitForResponse(r=>r.request().method()==='PUT'&&qaIds.has(new URL(r.url()).pathname.split('/').pop()));await page.getByRole('button',{name:'保存',exact:true}).click();const r=await waiter;assert.equal(r.status(),200);return await r.json();}
 try {
   await page.goto('http://127.0.0.1:5178',{waitUntil:'networkidle'});
   await page.getByRole('button',{name:new RegExp(original.name)}).first().click();await page.locator('.run-spec-note').filter({hasText:runId.slice(0,8)}).waitFor();
   await page.getByRole('button',{name:'版本与复用',exact:true}).click();
   const cloned=await createdFrom(()=>page.getByRole('button',{name:'复制本轮为新草稿'}).click(),`/runs/${runId}/clone`);
   assert.equal(cloned.prd.joint_name,originalRun.spec_snapshot.prd.joint_name);out.runClone={id:cloned.id,joint:cloned.prd.joint_name,status:cloned.status};
   const saved=await rename('V4 界面验收 · 历史与导入');
   await page.getByLabel('必须遵守的限制',{exact:true}).fill(saved.prd.constraints+'\n这是界面验收草稿，尚未请求生成。');
   await rename('V4 界面验收 · 历史与导入');
   await page.getByRole('button',{name:'版本与复用',exact:true}).click();
   await page.locator('.history-entry').first().waitFor();out.historyCount=await page.locator('.history-entry').count();assert.ok(out.historyCount>=3);
   await page.locator('.history-entry > summary').first().click();await page.screenshot({path:path.join(root,'docs/ui-v4-live-history.png')});
   const historical=await createdFrom(()=>page.getByRole('button',{name:'从这个版本新建'}).first().click(),'/clone');out.historyClone={id:historical.id,status:historical.status};
   await rename('V4 界面验收 · 从历史复制');
   await page.getByRole('button',{name:'导入工程 ZIP',exact:true}).click();
   const previewWait=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects/import/preview');
   await page.getByLabel('选择工程 ZIP 文件').setInputFiles(path.join(root,'runs',runId,'engineering-bundle.zip'));
   const previewResponse=await previewWait,preview=await previewResponse.json();assert.equal(previewResponse.status(),200,JSON.stringify(preview));
   await page.getByLabel('已核对，作为新草稿导入；不继承旧批准或通过状态').waitFor();assert.equal(await page.getByRole('button',{name:'导入为新草稿'}).isDisabled(),true);
   await page.screenshot({path:path.join(root,'docs/ui-v4-live-import.png')});
   await page.getByLabel('已核对，作为新草稿导入；不继承旧批准或通过状态').check();
   const imported=await createdFrom(()=>page.getByRole('button',{name:'导入为新草稿'}).click(),'/projects/import');
   assert.equal(imported.prd.joint_name,originalRun.spec_snapshot.prd.joint_name);assert.equal(imported.parameters.target,originalRun.spec_snapshot.parameters.target);out.imported={id:imported.id,joint:imported.prd.joint_name,target:imported.parameters.target,preview};
   await rename('V4 界面验收 · ZIP导入');
   await page.getByRole('button',{name:new RegExp(original.name)}).first().click();await page.locator('.run-spec-note').filter({hasText:runId.slice(0,8)}).waitFor();
   await page.getByRole('button',{name:'查看并保存经验'}).click();await page.getByRole('heading',{name:initialExperience.title,exact:true}).waitFor();
   if(!initialExperience.published_document_id){await page.getByLabel('已核对范围、代码和结果，允许后续匹配任务作为参考').check();const publish=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/runs/${runId}/experience`);await page.getByRole('button',{name:'核对后存入资料库'}).click();assert.equal((await publish).status(),200);out.experiencePublished=true;}else out.experienceAlreadyExisted=true;
   await page.getByText(/已存入资料库/).waitFor();await page.locator('.experience-panel').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/ui-v4-live-experience.png')});
   await page.getByRole('button',{name:'资料库',exact:true}).click();await page.getByLabel('按资料来源筛选').selectOption('experience');await page.getByLabel('搜索资料').fill(runId);
   const article=page.locator('.source-item').filter({hasText:`experience-${runId}`}).first();await article.waitFor();out.experienceSearchHit=true;
   await article.getByRole('button',{name:'查看完整内容'}).click();await page.locator('.document-pages').waitFor();out.fullOriginal=await page.locator('.document-pages pre').first().textContent();assert.ok(out.fullOriginal.includes(runId));
   await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);await page.locator('.document-detail').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/ui-v4-live-mobile.png')});out.mobile=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(out.mobile.width,out.mobile.scroll);
   await page.setViewportSize({width:1536,height:1100});await page.waitForTimeout(250);
   if(out.experiencePublished){await article.getByRole('button',{name:/删除资料/}).click();await article.getByRole('button',{name:'确认移除',exact:true}).click();await page.getByText('没有匹配的资料',{exact:true}).waitFor();out.experienceRemoved=true;}
   assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);out.passed=true;
 }catch(error){out.error=String(error);out.passed=false;process.exitCode=1;await page.screenshot({path:path.join(root,'docs/ui-v4-live-error.png')});}
 finally{out.created_projects=[...qaIds];out.writes=writes;out.blocked=blocked;out.errors=errors;fs.writeFileSync(path.join(root,'docs/frontend-v4-live-qa.json'),JSON.stringify(out,null,2));console.log(JSON.stringify({...out,fullOriginal:out.fullOriginal?'verified, see record':undefined}));await browser.close();}
})();
