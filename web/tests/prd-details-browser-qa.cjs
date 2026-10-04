// Real PRD V2 API + browser checks. Writes only a new QA draft. No AI, ROS, firmware or Feishu.
const {chromium}=require('C:/Users/lx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),host=process.env.DETAILS_QA_URL||'http://127.0.0.1:8877';
const v1Id='14f05e71ac4d466c9f56895685b3a6dd';
(async()=>{
 const baseline=await(await fetch(`${host}/api/projects/${v1Id}`)).json();
 assert.equal(baseline.prd.intake.schema_version,1,'Requires untouched V1 QA baseline');
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1536,height:1100},deviceScaleFactor:1});page.setDefaultTimeout(20000);
 const result={url:host,scope:'one_new_QA_draft_only',errors:[],blocked:[],writes:[],ai_or_ros_started:false,feishu_written:false};
 const ids=new Set();let latestReadiness=null;
 page.on('pageerror',e=>result.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});
 await page.route('**/api/**',async route=>{
  const req=route.request(),m=req.method(),p=new URL(req.url()).pathname;
  if(['GET','HEAD','OPTIONS'].includes(m))return route.continue();
  if(p==='/api/prd/preview'&&m==='POST'){
   const response=await route.fetch();latestReadiness=await response.json();return route.fulfill({response,json:latestReadiness});
  }
  if((p==='/api/projects'&&m==='POST')||(m==='PUT'&&ids.has(p.split('/').pop()))){result.writes.push({m,p});return route.continue();}
  result.blocked.push({m,p});return route.abort();
 });
 const field=label=>page.getByLabel(label,{exact:true});
 const button=name=>page.getByRole('button',{name,exact:true});
 const step=n=>page.locator('.guide-steps button').nth(n-1).click();
 const group=name=>page.getByRole('region',{name,exact:true});
 async function save(){const pending=page.waitForResponse(r=>['POST','PUT'].includes(r.request().method())&&/^\/api\/projects(?:\/[^/]+)?$/.test(new URL(r.url()).pathname));await button('保存需求').click();const response=await pending,data=await response.json();assert.equal(response.status(),200,JSON.stringify(data));ids.add(data.id);assert.equal(data.status,'draft');assert.equal(data.plan,null);assert.equal(data.approval,null);return data;}
 async function preview(){await page.waitForFunction(()=>{const node=document.querySelector('.guide-readiness');return node&&!node.classList.contains('checking');});assert.ok(latestReadiness&&!latestReadiness.detail,JSON.stringify(latestReadiness));}
 try{
  await page.goto(`${host}/?project=${v1Id}`,{waitUntil:'networkidle'});await button('补全详细需求').waitFor();
  assert.equal(await page.locator('.prd-details').count(),0);result.v1NoAutomaticMigration=true;
  await button('补全详细需求').click();await step(5);await preview();assert.equal(await button('让 AI 拆分').isDisabled(),true);result.explicitUpgradeNeedsNewAnswers=true;
  await step(1);await button('采用当前本机测试设置').click();await step(5);await page.getByText('必要信息已齐，可以交给 AI 拆分',{exact:true}).waitFor();
  assert.equal(await button('让 AI 拆分').isDisabled(),false);assert.equal(await page.locator('.detail-coverage-row').count(),8);result.platformProfileReadyForPlanOnly=true;
  // The upgraded existing draft is deliberately not saved. A new isolated draft owns subsequent writes.
  await button('新建任务').click();const empty=await save();result.createdProjectId=empty.id;assert.equal(empty.prd.intake.schema_version,2);assert.equal(empty.prd.intake.details.motion.pattern,null);result.blankV2Saved=true;
  await field('工程名称').fill('PRD V2 界面验收 · 完整动作与设备需求');await field('你希望机器人做什么').fill('先等待，再转动关节；后续接电机，开始和取消条件都需要确认。');
  await page.getByRole('radio',{name:/转到一个位置/}).click();await button('采用当前本机测试设置').click();
  await step(2);await field('结构模型').selectOption('builtin-joint');await page.waitForFunction(()=>document.querySelector('select[aria-label="本轮控制的关节"]')?.options.length>1);await field('本轮控制的关节').selectOption('test_joint');
  await step(3);await field('转到哪个角度').fill('20');await button('采用空白项建议').click();
  await field('动作怎样安排').selectOption('sequence');await field('什么时候算这组动作完成').selectOption('custom');await field('整组动作完成的条件').fill('两步完成且回报结果');
  await button('增加一个步骤').click();await field('步骤1做什么').selectOption('wait');await field('步骤1等待多久').fill('0');await field('步骤1的说明').fill('首先等待，由条件决定是否继续');
  await button('增加一个步骤').click();await field('步骤2的关节').selectOption('test_joint');await field('步骤2的目标角度').fill('30');await field('步骤2的说明').fill('随后转到位置');
  await button('上移步骤2').click();assert.equal(await field('步骤1的说明').inputValue(),'随后转到位置');await button('下移步骤1').click();result.stepReorderRetainsValues=true;
  await field('开始、结束和取消的要求').selectOption('custom');await field('开始条件和开始前的状态').fill('收到开始按钮并确认模型姿态');await field('结束后要保持什么状态').fill('完成后保留结果，不自动重跑');await field('中途取消时怎么处理').fill('取消剩余步骤');
  await field('开始、结束和取消的要求').selectOption('platform');assert.equal(await field('开始条件和开始前的状态').inputValue(),'收到开始按钮并确认模型姿态');result.switchToPlatformKeepsCustomVisible=true;
  await field('开始、结束和取消的要求').selectOption('custom');
  await group('动作步骤').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-details-steps.png')});
  await step(4);await page.getByRole('radio',{name:/先在电脑里验证/}).click();await field('目标控制板').selectOption('esp32s3');
  await field('这些设备对应关系用在哪里').selectOption('reference_only');await button('增加设备对应').click();await button('关联当前结构与所选关节').click();
  await field('设备1的电机或舵机').fill('待核型号的电机');await field('设备1的驱动器').fill('待核型号的驱动器');await field('设备1的连接接口').fill('CAN1');await field('设备1的地址或通道号').fill('0');await field('设备1的接线').fill('之后按手册核对');await field('设备1从哪里获得反馈').fill('编码器');await field('设备1的资料出处').fill('QA记录，不是实物证据');await field('设备1的资料状态').selectOption('documented');
  await field('零位、方向和单位的要求').selectOption('custom');await field('零位怎么确定').fill('实物零位待测');await field('哪边算正方向').fill('按装配图确认');await field('指令的数值和单位').fill('速度rad/s');await field('反馈数值和单位').fill('编码器计数');await field('实物数值怎样换成模型数值').fill('减去零点后换算');await field('零位和单位的资料出处').fill('等待电机手册');
  await field('ROS / ESP32 分工与通信的要求').selectOption('custom');await field('两端通过什么连接').fill('串口');await field('ROS 负责什么').fill('拆动作并计算指令');await field('ESP32 负责什么').fill('读取反馈并执行限幅');await field('指令和反馈要包含什么').fill('身份、序号、时间、值');await field('每秒发送多少次').fill('20');await field('多久没有消息算失联').fill('600');
  await group('关节与设备对应').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-details-mapping.png')});
  await step(5);await field('怎样才算完成').fill('完整做完两步，检查记录，实物后续核对。');await field('必须遵守的限制').fill('本轮仅完善需求，不运行AI或ROS。');
  await field('在什么条件下测试的要求').selectOption('custom');await field('机器人怎么安装').fill('固定基座');await field('需要带多重的负载').fill('0');await field('周围有什么障碍或人').fill('桌边');await field('可活动的空间').fill('待实测');await field('其他环境条件').fill('只记录，未实测');
  await field('出错以后怎么办的要求').selectOption('custom');await field('通信断开时怎么办').fill('停止后等待人工确认');await field('反馈不对或丢失时怎么办').fill('报错');await field('碰到限制或超出范围时怎么办').fill('不再继续动作');await field('出错后怎样恢复').fill('人工重新确认');
  await field('怎样检查结果的要求').selectOption('custom');await button('增加检查条件').click();await field('条件1检查什么').fill('动作顺序');await field('条件1期望结果').fill('先等待再转动');await field('条件1怎么判断').fill('查看带时间的动作记录');
  await step(1);await button('采用当前本机测试设置').click();await step(5);await preview();
  const saved=await save();result.savedDetails=saved.prd.intake.details;assert.equal(saved.intake_readiness.can_plan,false);assert.equal(saved.prd.intake.details.lifecycle.start,'收到开始按钮并确认模型姿态');assert.equal(saved.prd.intake.details.environment.load_kg,0);assert.equal(saved.prd.intake.details.motion.steps[0].duration_s,0);assert.equal(saved.prd.intake.details.communication.rate_hz,20);assert.equal(saved.prd.intake.details.acceptance.criteria[0].metric,'动作顺序');assert.match(saved.prd.intake.details.device_mapping.entries[0].source_sha256,/^[a-f0-9]{64}$/);result.allEightGroupsPersisted=true;result.globalAdoptPreservesCustom=true;
  await page.reload({waitUntil:'networkidle'});await step(5);await preview();assert.equal(await button('让 AI 拆分').isDisabled(),true);assert.equal(await page.locator('.detail-coverage-row').count(),8);result.reloadPreservesUnsupported=true;
  await page.waitForFunction(()=>!document.querySelector('.toast'));await page.locator('.detail-coverage').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-details-summary.png')});
  await page.locator('.detail-coverage-row').filter({hasText:'开始、结束'}).getByRole('button').click();await field('开始条件和开始前的状态').waitFor();result.summaryLinkToAction=true;
  // Clear only lifecycle, with explicit confirmation, and verify other requirements remain.
  await group('开始、结束和取消').getByRole('button',{name:'清空本组补充并采用本机设置',exact:true}).click();await group('开始、结束和取消').getByRole('button',{name:'确认清空本组',exact:true}).click();assert.equal(await field('开始条件和开始前的状态').count(),0);assert.equal(await field('整组动作完成的条件').inputValue(),'两步完成且回报结果');result.explicitClearIsScoped=true;
  await step(4);await field('设备1的地址或通道号').fill('0');await step(2);await field('本轮控制的关节').selectOption('');await step(4);assert.equal(await field('设备对应1的关节').inputValue(),'test_joint');result.jointChangePreservesMapping=true;
  // Do not save exploratory clear/change tests; stored QA remains the full eight-group example.
  await page.reload({waitUntil:'networkidle'});await page.setViewportSize({width:390,height:844});await step(5);await preview();await page.locator('.detail-coverage').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/prd-details-mobile.png')});result.mobile=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.equal(result.mobile.viewport,result.mobile.width);
  await page.setViewportSize({width:1536,height:1100});await button('新建任务').click();await page.getByRole('radio',{name:/达到条件后触发/}).click();await step(3);await group('开始、结束和取消').locator('.detail-platform-fact summary').click();assert.match(await group('开始、结束和取消').innerText(),/合成测试值/);assert.doesNotMatch(await group('开始、结束和取消').innerText(),/从模型初始角度/);result.thresholdProfileHasNoJointAssumption=true;
  const after=await(await fetch(`${host}/api/projects/${v1Id}`)).json();assert.deepEqual(after,baseline);result.v1BaselineUnchanged=true;
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.blocked,[]);result.passed=true;
 } catch(error){result.passed=false;result.error=String(error);process.exitCode=1;await page.screenshot({path:path.join(root,'docs/prd-details-ui-error.png')});}
 finally {result.createdProjects=[...ids];fs.writeFileSync(path.join(root,'docs/prd-details-live-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();}
})();
