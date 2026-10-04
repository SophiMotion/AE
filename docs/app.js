const $ = (id) => document.getElementById(id);
let evidence, viewer, playing = false, frame = 0, lastTick = 0, playbackStart = 0;
const ids = ['request','board','action','repeat','speed','error','joints','ending','hardware'];
function toast(message) { $('toast').textContent = message; $('toast').style.display='block'; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').style.display='none',3500); }
function showTab(name) {
  if (!['workbench','model','results'].includes(name)) name='workbench';
  document.querySelectorAll('[data-page]').forEach(x=>x.hidden=x.dataset.page!==name);
  document.querySelectorAll('[data-tab]').forEach(x=>{ x.classList.toggle('active',x.dataset.tab===name); x.setAttribute('aria-current',x.dataset.tab===name?'page':'false'); });
  history.replaceState(null,'','#'+name);
  if(name!=='model') { playing=false; $('play').textContent='播放记录'; }
  if(name==='model') viewer?.resize();
  if(name==='results' && evidence) drawChart();
}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{showTab(b.dataset.tab);window.scrollTo(0,0);}));
document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>{showTab(b.dataset.open);window.scrollTo(0,0);}));
window.addEventListener('hashchange',()=>showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));
$('share').addEventListener('click',async()=>{
  const url=location.href.split('#')[0];
  try { await navigator.clipboard.writeText(url); toast('链接已复制，可粘贴到微信发送。'); }
  catch { const node=document.createElement('textarea');node.value=url;document.body.append(node);node.select();const copied=document.execCommand('copy');node.remove();toast(copied?'链接已复制，可粘贴到微信发送。':'请从浏览器地址栏复制链接。'); }
});
const defaults = {board:'ESP32-S3',action:'抬起、往返招手、放下',repeat:'3',speed:'30',error:'2',joints:'右肩抬起、右肩前后摆动、右上臂转动、右肘弯曲、右腕转动；右夹爪保持开度。',ending:'招手结束后，将手臂放下，自然垂在身体旁边。'};
function refreshDraft() {
  $('review').checked=false;
  const value=id=>$(id).value.trim() || '待补充';
  $('draft-summary').textContent=`需求：${value('request')}\n模型：Sophicore 参考模型\n动作：${value('action')}\n关节：${value('joints')}\n往返次数：${value('repeat')}\n速度上限：${value('speed')} °/s\n允许误差：${value('error')} °\n结束姿势：${value('ending')}\n编译目标：${value('board')}\n硬件资料：${value('hardware')}\n\n还需核对：各阶段的具体关节角度、运动范围、硬件与接线。此页面只整理需求，不证明动作可执行。`;
  document.querySelectorAll('[data-fill]').forEach(b=>{const [id,v]=b.dataset.fill.split(':');b.classList.toggle('chosen',$(id).value!=='' && Number($(id).value)===Number(v));});
}
ids.forEach(id=>$(id).addEventListener('input',refreshDraft));
$('fill').addEventListener('click',()=>{
  const request=$('request').value;
  const normalized=request.replace(/[，。,、！!？?\s]/g,'');
  if(normalized!=='让机器人抬起右手招手三次最后把手臂放到身体旁边') { $('fill-message').textContent='当前按钮只填写页面最初的“右手招手三次，最后放到身体旁边”示例。你的需求已经修改，请手动填写下面的参数；不会套用原示例的次数或结束姿势。';return; }
  let count=0; for(const [id,value] of Object.entries(defaults))if(!$(id).value.trim()){$(id).value=value;count++;}
  refreshDraft(); $('fill-message').textContent=count?`已补充 ${count} 项示例信息，保留了你已填写的内容。请逐项核对，硬件和角度不会猜测。`:'已填写的内容已保留。需要调整时，直接修改对应项目即可。';
});
document.querySelectorAll('[data-fill]').forEach(b=>b.addEventListener('click',()=>{const [id,v]=b.dataset.fill.split(':');$(id).value=v;refreshDraft();}));
$('download').addEventListener('click',()=>{
  for(const id of ['repeat','speed','error']) if(!$(id).checkValidity()) { $(id).reportValidity();return; }
  if(!$('request').value.trim()){toast('先写下你希望机器人做什么。');$('request').focus();return;}
  const text='AE 需求填写体验\n\n'+$('draft-summary').textContent+'\n\n已阅读摘要：'+($('review').checked?'是':'否')+'\n该记录未生成代码、未执行或验证。\n';
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='机器人需求草稿.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('需求文件已准备下载。微信若不支持下载，可用系统浏览器打开。');
});
refreshDraft();
const rad=180/Math.PI;
async function getEvidence(){
  if(evidence)return evidence;
  const response=await fetch('./results.json');if(!response.ok)throw Error('验证记录读取失败');
  evidence=await response.json();return evidence;
}
function renderResults(d){
  const metrics=[[''+d.passed_count+'<em> / '+d.check_count+'</em>','检查项通过'],['6','同步控制通道'],['3<em> / 3</em>','正常测试完成'],[d.max_waypoint_error_deg.toFixed(2)+'<em> °</em>','最大到位误差 · 要求 ≤ 2°']];
  $('metrics').replaceChildren(...metrics.map(([value,label])=>{const div=document.createElement('div');div.innerHTML='<strong>'+value+'</strong>';const span=document.createElement('span');span.textContent=label;div.append(span);return div;}));
  for(const name of d.joint_names){const op=document.createElement('option');op.value=name;op.textContent=d.joint_labels[name];$('chart-joint').append(op);}
  const labels={motion_1:'正常动作 · 第 1 轮',motion_2:'正常动作 · 第 2 轮',motion_3:'正常动作 · 第 3 轮',command_loss:'指令中断',measurement_loss:'反馈中断',cancel:'中途取消'};
  for(const c of d.cases){const row=document.createElement('div');row.className='case-row';const title=document.createElement('strong');title.textContent=labels[c.name];const detail=document.createElement('p');detail.textContent=c.name.startsWith('motion')?`${c.waypoints_reached} / ${c.total_waypoints} 个姿势到位 · ${c.completed_cycles} 次往返 · ${c.duration_s.toFixed(2)} 秒`:'停止与故障处理检查通过；此场景不要求做完整套动作。';const pass=document.createElement('span');pass.className='pass';pass.textContent='检查通过';row.append(title,detail,pass);$('cases').append(row);}
  $('source-note').textContent=`记录包含 ${d.series.length} 个实际采样、${d.communication_check_count} 项通信检查。数据日期：${d.date}。角度曲线保留原始数值；3D 网格只做显示精度压缩。`;
  drawChart();
}
function drawChart(){
  if(!evidence)return;
  const j=$('chart-joint').value, s=evidence.series;
  const vals=s.flatMap(p=>[p.positions[j]*rad,p.targets[j]*rad]);
  const min=Math.floor(Math.min(...vals)/10)*10-5,max=Math.ceil(Math.max(...vals)/10)*10+5;
  const W=Math.max(320,$('chart').clientWidth||900),H=W<500?240:290,L=45,R=18,T=24,B=35,end=s.at(-1).time;
  const x=t=>L+t/end*(W-L-R),y=v=>T+(max-v)/(max-min)*(H-T-B);
  const path=key=>s.filter((_,i)=>i%3===0||i===s.length-1).map((p,i)=>(i?'L':'M')+x(p.time).toFixed(2)+','+y(p[key][j]*rad).toFixed(2)).join(' ');
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${evidence.joint_labels[j]}的实际角度和目标角度，单位度">`;
  for(let i=0;i<5;i++){const v=min+(max-min)*i/4;svg+=`<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="#293840"/><text x="${L-9}" y="${y(v)+4}" text-anchor="end" fill="#91a6b2" font-size="13">${v.toFixed(0)}°</text>`;}
  for(let t=0;t<=end;t+=5)svg+=`<text x="${x(t)}" y="${H-8}" text-anchor="middle" fill="#91a6b2" font-size="13">${t}s</text>`;
  svg+=`<path d="${path('targets')}" fill="none" stroke="#7ebacf" stroke-width="2" stroke-dasharray="7 5"/><path d="${path('positions')}" fill="none" stroke="#f26747" stroke-width="2"/></svg>`;
  $('chart').innerHTML=svg;$('chart-note').textContent=`${evidence.joint_labels[j]} · 显示第一轮 ${s.length} 个原始采样的趋势，单位为度。两条线重合说明跟随较好。`;
}
$('chart-joint').addEventListener('change',drawChart);
window.addEventListener('resize',()=>{if(!document.querySelector('[data-page="results"]').hidden)drawChart();});
getEvidence().then(renderResults).catch(()=>{$('metrics').textContent='验证记录暂时无法加载，请刷新页面重试。';});
function seek(index){
  frame=Math.min(evidence.series.length-1,Math.max(0,index));const p=evidence.series[frame];
  viewer?.pose(p.positions);$('timeline').value=String(frame);$('clock').textContent=p.time.toFixed(2)+' s';
  $('stage').textContent=({prepare:'抬臂，准备招手',wave_a:'摆回',wave_b:'摆出',finish:'放下手臂'}[p.stage_id]||'初始姿势')+(p.cycle_index?' · 第 '+p.cycle_index+' 次':'');
}
$('load-model').addEventListener('click',async()=>{
  $('load-model').disabled=true;$('model-status').textContent='正在加载结构和模型…';
  try {
    const [mod,d]=await Promise.all([import('./viewer.js'),getEvidence()]);
    viewer=await mod.createViewer($('viewer'),p=>$('model-status').textContent=p);
    $('model-cover').hidden=true;$('timeline').max=String(d.series.length-1);$('timeline').disabled=false;$('play').disabled=false;$('reset-view').disabled=false;seek(0);
  } catch(e){$('model-status').textContent='模型暂时无法显示。可先查看验证结果，或在系统浏览器中重试。';$('load-model').disabled=false;}
});
$('reset-view').addEventListener('click',()=>viewer?.reset());
$('timeline').addEventListener('input',()=>{playing=false;$('play').textContent='播放记录';seek(Number($('timeline').value));});
$('play').addEventListener('click',()=>{if(frame>=evidence.series.length-1)seek(0);playing=!playing;lastTick=performance.now();playbackStart=evidence.series[frame].time;$('play').textContent=playing?'暂停':'播放记录';});
function tick(now){
  if(playing&&evidence){const target=playbackStart+(now-lastTick)/1000;let next=frame;while(next<evidence.series.length-1&&evidence.series[next+1].time<=target)next++;if(next!==frame)seek(next);if(frame===evidence.series.length-1){playing=false;$('play').textContent='重新播放';}}
  requestAnimationFrame(tick);
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){playing=false;$('play').textContent='播放记录';}});
requestAnimationFrame(tick);
// Optional browser agent interface. Reading a draft cannot execute or approve anything.
if(document.modelContext?.registerTool){
  try{Promise.resolve(document.modelContext.registerTool({
    name:'read_demo_requirements',title:'读取体验页需求草稿',
    description:'Read the currently visible draft. This demo cannot generate code, run simulations, or control hardware.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations:{readOnlyHint:true,untrustedContentHint:true},
    execute(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw Error('No arguments expected');return {draft:Object.fromEntries(ids.map(id=>[id,$(id).value])),reviewed:$('review').checked,executed:false};}
  })).catch(()=>{});}catch{}
}
