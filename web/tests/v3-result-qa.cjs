// Read-only acceptance of real V3 evidence. All browser writes are blocked.
const { chromium } = require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
(async () => {
 const browser = await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
 const page = await browser.newPage({viewport:{width:1536,height:1100},deviceScaleFactor:1});
 page.setDefaultTimeout(20000);
 const errors=[], writes=[], meshes=[], out={};
 await page.route('**/api/**', async route=>{ const r=route.request(); if(!['GET','HEAD','OPTIONS'].includes(r.method())){writes.push(r.method()+' '+new URL(r.url()).pathname); return route.abort();} return route.continue(); });
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.on('request',r=>{if(r.url().endsWith('/mesh'))meshes.push(new URL(r.url()).pathname);});
 try {
  await page.goto('http://127.0.0.1:8877',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:/V3 界面验收 · 18轴与流程/}).first().click();
  await page.waitForFunction(()=>document.querySelectorAll('.structure-selectors select')[1]?.value==='arm_l_elbow_bend');
  out.draft={joint:await page.locator('.structure-selectors select').nth(1).inputValue(),order:await page.locator('.workflow-editor .workflow-order li').allTextContents(),manifest:await page.locator('.manifest-verdict').innerText()};
  if(out.draft.order[5]!=='编译 ESP32'||!out.draft.manifest.includes('6 / 6'))throw Error('Saved draft mismatch');
  await page.getByRole('button',{name:/V3 同模型验收 · 右肩关节/}).first().click();
  // Selecting the completed project opens its result stage automatically.
  await page.locator('.run-spec-note').filter({hasText:'430b8bfd'}).waitFor();
  const run=await (await page.request.get('http://127.0.0.1:8877/api/runs/430b8bfdc3dc4a4eaac2ed41b58bf04d')).json();
  out.run={id:run.id,status:run.status,checks:run.result.checks.length,passed:run.result.checks.filter(x=>x.passed).length,samples:run.result.series.length,model:run.spec_snapshot.execution_model.model_sha256,joint:run.spec_snapshot.execution_model.selected_joint,mesh:run.spec_snapshot.structure.mesh_url,order:run.result.execution_order,firmware:run.result.firmware.passed,communication:run.result.communication_test.passed,physical:run.result.physical_verified,plan:run.plan_snapshot.plan_id};
  await page.getByText('506 个部件 · 模型姿态预览',{exact:true}).waitFor({timeout:45000});
  out.identity=await page.locator('.result-panel .model-identity').innerText();
  out.evidence=await page.locator('.execution-evidence').innerText();
  out.checkLabels = await page.locator('.result-panel .check-detail summary span').allTextContents();
  if(out.checkLabels.includes('其他执行检查'))throw Error('Untranslated V3 check');
  if(!out.identity.includes(out.run.model.slice(0,16))||!out.identity.includes('右肩')||!out.evidence.includes('未烧录')||!out.evidence.includes('主机通信测试通过'))throw Error('Evidence labels mismatch');
  await page.locator('.result-panel').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v3-result.png')});
  const timeline=page.getByLabel('运行轨迹时间',{exact:true});
  out.replay={frames:Number(await timeline.getAttribute('max'))+1};
  await timeline.fill(String(run.result.series.length-1));
  out.replay.end=await timeline.inputValue();
  await page.getByRole('button',{name:'播放轨迹回放',exact:true}).click();
  await page.waitForTimeout(350);
  await page.getByRole('button',{name:'暂停轨迹回放',exact:true}).click();
  out.replay.playedTo=await timeline.inputValue();
  await page.locator('.result-replay').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v3-replay.png')});
  await page.getByRole('tab',{name:'两端代码',exact:true}).click();
  await page.getByRole('button',{name:'ROS · Python',exact:true}).click();
  out.pythonMatches=await page.locator('.generated-code > pre').textContent()===run.code_versions.at(-1).code;
  await page.getByRole('button',{name:'ESP32 · C++',exact:true}).click();
  out.cppMatches=await page.locator('.generated-code > pre').textContent()===run.code_versions.at(-1).firmware_code;
  await page.locator('.evidence').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v3-code.png')});
  await page.getByRole('tab',{name:'AI 记录',exact:true}).click();
  out.aiRecords=await page.locator('.ai-record').count();
  out.planPromptMatches=await page.locator('.ai-record').first().locator('pre').first().textContent()===run.plan_snapshot.provenance.prompt;
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(350);
  await page.locator('.execution-evidence').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'docs/ui-v3-result-mobile.png')});
  out.mobile=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  out.errors=errors;out.writes=writes;out.meshes=meshes;
  if(errors.length||writes.length||!out.pythonMatches||!out.cppMatches||!out.planPromptMatches||out.replay.frames!==162||out.replay.playedTo==='161'||out.mobile.width!==out.mobile.scroll||!meshes.includes(out.run.mesh))throw Error('Read-only acceptance assertion failed');
  console.log(JSON.stringify(out));
 }catch(e){console.log(JSON.stringify({error:String(e),out,errors,writes,meshes})); await page.screenshot({path:path.join(root,'docs/ui-v3-result-error.png')});process.exitCode=1;}
 finally{await browser.close();}
})();


