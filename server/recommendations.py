"""Small explicit-format rules for draft assistance, with no AI or execution."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re

from .intake_details import GROUPS, mapping_source_fingerprint
from .schemas import GuidedDraftInput, RecommendationRecord
from .structures import get_structure

RULE = 'prd-fill-v1'
TOOL = '平台规则推荐（非 AI）'
PREFIX = 'prd.intake.answers.'
NUM = r'(?<![A-Za-z0-9_.负正])([-+]?(?:\d+(?:\.\d+)?|\.\d+))'
ANGLE = NUM + r'\s*(度|°|rad|弧度)(?!\s*(?:/|每|秒|s\b))'
SPEED = NUM + r'\s*(度|°|rad|弧度)\s*(?:/|每)\s*(?:秒|s\b)(?!\s*(?:/|每|²|2|\^2))'
TIME = NUM + r'\s*(毫秒|ms\b|秒|s\b)'
SEP = r'\s*(?:为|是|[:：=])?\s*'
LABELS = {'target_rad':'目标角度','wave_start_rad':'摆动起点','wave_end_rad':'摆动终点',
          'repetitions':'往返次数','dwell_s':'端点停留','max_velocity_rad_s':'最高速度',
          'tolerance_rad':'允许角度误差','duration_s':'观察时长','threshold':'触发阈值',
          'end_behavior':'结束位置','end_position_rad':'自定结束角度'}
UNITS = {'target_rad':'rad','wave_start_rad':'rad','wave_end_rad':'rad','end_position_rad':'rad',
         'tolerance_rad':'rad','repetitions':'次','dwell_s':'s','duration_s':'s','max_velocity_rad_s':'rad/s',
         'threshold':'0–1','end_behavior':None}
BOUNDS = {'target_rad':(-2*math.pi,2*math.pi),'wave_start_rad':(-2*math.pi,2*math.pi),
          'wave_end_rad':(-2*math.pi,2*math.pi),'end_position_rad':(-2*math.pi,2*math.pi),
          'repetitions':(1,1000),'dwell_s':(0,60),'max_velocity_rad_s':(.1,2),
          'tolerance_rad':(.005,.15),'duration_s':(4,30),'threshold':(.1,.9)}
ANGLE_FIELDS = ('target_rad','wave_start_rad','wave_end_rad','end_position_rad')


def _blank(value):
    return value is None or isinstance(value, str) and not value.strip()


def _get(value, path):
    for key in path.split('.'):
        if not isinstance(value, dict):return None
        value = value.get(key)
    return value


def _angle(number, unit):
    value = float(number)
    return math.radians(value) if unit in ('度','°') else value


def _time(number, unit):
    return float(number) / 1000 if unit.lower() in ('毫秒','ms') else float(number)


def _count(text):
    if text.lstrip('+-').isdigit():return int(text)
    digits = dict(zip('零〇一二两三四五六七八九', (0,0,1,2,2,3,4,5,6,7,8,9)))
    if text in digits:return digits[text]
    if text == '一百':return 100
    if text.count('十') == 1:
        tens, ones = text.split('十')
        if (not tens or tens in digits) and (not ones or ones in digits):
            return (digits[tens] if tens else 1)*10+(digits[ones] if ones else 0)
    raise ValueError('次数写法需要人工核对')


def selected_model(root, answers):
    ident, name = answers.get('structure_id'), answers.get('joint_name')
    if not ident:return None, None
    model = get_structure(root, ident)
    if not name:return model, None
    from worker.robot_model import build_execution_model
    execution = build_execution_model(model, name)
    return model, next(j for j in execution['joints'] if j['name'] == name)


def basis_for(root, draft, intent, model=None):
    form = draft['prd']['intake'];answers = form['answers']
    return {'request_text':draft['request'], 'intent':intent,
            'structure_id':answers.get('structure_id'), 'joint_name':answers.get('joint_name'),
            'model_source_sha256':mapping_source_fingerprint(root, model) if model else None}


def recommend(root, body: GuidedDraftInput):
    draft = body.model_dump();form = draft['prd']['intake'];answers = form['answers']
    if form['schema_version'] != 2:
        raise ValueError('请先点击“补全详细需求”明确升级，再使用推荐填写。')
    if not draft['request'].strip():
        raise ValueError('请先用自己的话写出需求，再根据原话推荐填写。')
    text = draft['request'];suggestions=[];not_filled=[];warnings=[];blocked=set();working=dict(answers)
    checksum = hashlib.sha256(json.dumps(draft,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    model=joint=None
    try:model,joint=selected_model(root, answers)
    except (ValueError, OSError, KeyError, StopIteration):
        warnings.append('所选结构或关节不能作为有界转轴读取；请先核对选择，角度保持空白。')

    def skip(path, label, reason, section=3):
        if not any(x['path']==path and x['reason']==reason for x in not_filled):
            not_filled.append({'path':path,'label':label,'reason':reason,'section':section})

    def block(key, reason):
        blocked.add(key);skip(PREFIX+key,LABELS[key],reason)

    cues=set()
    if re.search(r'来回|往返|招手|摆动',text):cues.add('oscillate')
    if re.search(r'转到|目标角度',text):cues.add('position')
    if re.search(r'模拟[^。；;\n]*(?:阈值|达到[^。；;\n]*触发)',text):cues.add('threshold')

    # Supported upper-bound phrases are handled explicitly. Other negation,
    # inequalities, conditional/sequence language are not partially interpreted.
    guarded=re.sub(r'(?:误差|容差)(?:不超过|小于等于|≤|<=)\s*'+ANGLE,'',text)
    guarded=re.sub(r'(?:最高|最大)?(?:角)?速度(?:不超过|小于等于|≤|<=)\s*'+SPEED,'',guarded)
    ambiguous = bool(re.search(r'不要|不许|不得|不能|不是|不到|不想|不需要|禁止|别(?:转|动|抬|摆|招)|不超过|不低于|至少|最多|如果|除非|否则|先[^。；;\n]*(?:再|然后)|然后|接着|随后|再(?:转|到|抬|放|摆|招|移动|控制|回到)|[<>≤≥]|(?:\d+|[一二两三四五六七八九十]+)\s*(?:到|至|或|[-~～])\s*(?:\d+|[一二两三四五六七八九十]+)\s*次',guarded))
    # A single selected joint cannot represent a sequence or several targets.
    # Preserve the full request for review instead of extracting a convenient part.
    named_targets=set(re.findall(r'(?:左|右)(?:肩|臂|肘|腕|手|腿|膝|脚)',text))
    if len(named_targets)>1 or re.search(r'两个关节|两侧|双侧|双臂|双肩|多(?:个)?关节|整机|全身|相对|当前位置',text):
        ambiguous=True
    selected_targets=set(re.findall(r'(?:左|右)(?:肩|臂|肘|腕|手|腿|膝|脚)',joint.get('label',''))) if joint else set()
    if named_targets and selected_targets and not named_targets & selected_targets:
        ambiguous=True
        warnings.append('原话所指部位与已选关节不一致；保留当前选择和原话，请先核对，不填写动作参数。')
        skip(PREFIX+'joint_name','要控制的关节','原话所指部位与已选关节名称不一致，请手动核对。',2)
    if len(cues)>1:ambiguous=True
    intent=form['intent']
    inferred=next(iter(cues)) if len(cues)==1 and not ambiguous else None
    if intent and inferred and intent != inferred:
        ambiguous=True;warnings.append('已选动作类型与原话不一致；保留已选项，请先核对，不替你换成另一类任务。')
    if not intent and inferred:intent=inferred
    if ambiguous:
        warnings.append('原话含否定、限制、条件、顺序或多类动作，简单规则不能完整理解；动作参数留待核对，不用示例替代这些要求。')
        skip('prd.intake.intent','动作类型','请核对原话的完整动作与限制；未自动解释为一个简单任务。',1)
    elif not intent:
        skip('prd.intake.intent','动作类型','未读到足够明确的单一动作类型，请手动选择。',1)
    basis=basis_for(root,draft,intent,model)

    def propose(path, value, label, source, reason, section, unit=None):
        current=_get(draft,path)
        if not _blank(current):
            if source=='request' and current != value:
                warnings.append(f'{label}已有填写值，与原话提取值不同；保留已有值，请核对冲突。')
            return False
        if any(row['path']==path for row in suggestions):return False
        row={'path':path,'label':label,'value':value,'source':source,'reason':reason,'section':section,'unit':unit,
             'rule_version':RULE,'tool':TOOL,'basis':copy.deepcopy(basis)}
        suggestions.append(RecommendationRecord.model_validate(row).model_dump())
        return True

    if not form['intent'] and inferred and not ambiguous:
        propose('prd.intake.intent',inferred,'动作类型','request','原话明确提到了这类动作；未理解的其它文字仍保留待核对。',1)
    if intent:
        names={'position':'关节定点需求','oscillate':'往返摆动需求','threshold':'模拟阈值需求','other':'机器人需求草稿'}
        propose('name',names[intent],'工程名称','example','仅给草稿一个简短名字，可以自行修改。',1)
        uses={'position':'整理所选关节到目标角度的需求。','oscillate':'整理往返摆动的需求；当前仅记录，不支持往返执行。',
              'threshold':'整理模拟数值达到阈值时触发的需求。','other':'整理机器人任务需求，具体能力待核对。'}
        propose('prd.use_case',uses[intent],'简短用途','example','根据动作类型给一句草稿用途，不表示代码已实现或验证。',1)

    def add(key,value,source,reason):
        if key in blocked:return
        if isinstance(value,(int,float)) and (not -1e12 <= value <= 1e12 or not math.isfinite(value)):
            block(key,'数值不是有限数，请人工核对。');return
        if key in BOUNDS and not BOUNDS[key][0] <= value <= BOUNDS[key][1]:
            block(key,'原话或已有值超出当前表单允许范围；保留原话，不换成示例。');return
        if key in ANGLE_FIELDS:
            if joint is None:
                block(key,'还没有选定有效的有界转动关节，不替你猜角度。');return
            if not joint['limits']['lower'] <= value <= joint['limits']['upper']:
                block(key,'该角度超出已选模型范围；保留原话，不替换成示例。');return
        if propose(PREFIX+key,value,LABELS[key],source,reason,3,UNITS[key]):working[key]=value

    def extract(key, pattern, convert, mentioned=None):
        matches=list(re.finditer(pattern,text,re.I))
        values=[]
        try:
            for match in matches:
                value=convert(*match.groups())
                if value not in values:values.append(value)
        except (ValueError,OverflowError):
            block(key,'提到了这个参数，但写法不能可靠转换，请人工确认。');return
        if len(values)>1:
            block(key,'原话出现多个不同的数值，不能确定应填哪一个；请核对。');return
        if values:add(key,values[0],'request','从原话的明确字段及单位提取，仍请核对。')
        elif mentioned and re.search(mentioned,text,re.I):
            block(key,'原话提到了这个参数，但单位或格式不明确；请补单位，不用示例盖过原要求。')

    if intent in ('position','oscillate','threshold') and not ambiguous:
        if intent in ('position','oscillate'):
            # Normalize only this explicit word order, keeping the same units.
            speed_text=text
            text=re.sub(r'(?:最快)?每秒\s*'+NUM+r'\s*(度|°|rad|弧度)',lambda m:m[1]+m[2]+'/秒',text,flags=re.I)
            extract('max_velocity_rad_s',r'(?:(?:最高|最大)?(?:角)?速度\s*(?:不超过|小于等于|≤|<=)?'+SEP+r')?'+SPEED,_angle,r'速度|限速|最快|每秒|(?:度|°|rad|弧度)\s*(?:/|每)')
            text=speed_text
            extract('tolerance_rad',r'(?:误差|容差)\s*(?:不超过|小于等于|≤|<=)?'+SEP+ANGLE,_angle,r'误差|容差')
        extract('duration_s',r'观察(?:时长|时间)?'+SEP+TIME,_time,r'观察(?:时长|时间)|观察\s*\d')
        if intent=='position':
            target_pattern=r'(?:转到|目标角度)'+SEP+ANGLE
            extract('target_rad',target_pattern,_angle,r'转到|目标角度')
            leftover=text
            for pattern in (target_pattern,r'(?:误差|容差)\s*(?:不超过|小于等于|≤|<=)?'+SEP+ANGLE,SPEED,r'(?:最快)?每秒\s*'+ANGLE):
                leftover=re.sub(pattern,'',leftover,flags=re.I)
            if re.search(ANGLE,leftover,re.I) and _blank(working['target_rad']):
                block('target_rad','原话还有未明确是目标位置还是幅度的角度；请明确目标，不用示例替代。')
        elif intent=='oscillate':
            pairs=list(re.finditer(ANGLE+r'\s*(?:到|至|和|与|~|～|—|–)\s*'+ANGLE,text,re.I))
            if len(pairs)>1:
                block('wave_start_rad','原话包含多组角度，需人工核对动作顺序。');block('wave_end_rad','原话包含多组角度，需人工核对动作顺序。')
            elif pairs:
                first=pairs[0];add('wave_start_rad',_angle(first[1],first[2]),'request','从原话两端角度提取起点，请核对方向。')
                add('wave_end_rad',_angle(first[3],first[4]),'request','从原话两端角度提取终点，请核对方向。')
            else:
                start_pattern=r'(?:起点|起始角度|端点\s*A|A\s*点)'+SEP+ANGLE
                end_pattern=r'(?:终点|结束角度|端点\s*B|B\s*点)'+SEP+ANGLE
                extract('wave_start_rad',start_pattern,_angle,r'起点\s*[:：=]?\s*\d|起始角度|端点\s*A|A\s*点')
                extract('wave_end_rad',end_pattern,_angle,r'终点\s*[:：=]?\s*\d|结束角度|端点\s*B|B\s*点')
                # Explicit but unsupported pair syntax must not become 30/60.
                if re.search(r'\d[^，。；;\n]*(?:和|到|至|~)[^，。；;\n]*\d',text) and not any(k in blocked for k in ('wave_start_rad','wave_end_rad')):
                    block('wave_start_rad','两端角度写法或单位不明确，请明确两个端点及单位。')
                    block('wave_end_rad','两端角度写法或单位不明确，请明确两个端点及单位。')
                leftover=text
                for pattern in (start_pattern,end_pattern,r'(?:误差|容差)\s*(?:不超过|小于等于|≤|<=)?'+SEP+ANGLE,SPEED,r'(?:最快)?每秒\s*'+ANGLE):
                    leftover=re.sub(pattern,'',leftover,flags=re.I)
                if re.search(ANGLE,leftover,re.I):
                    block('wave_start_rad','原话还有未明确是端点还是幅度的角度；请明确两个端点，不用示例替代。')
                    block('wave_end_rad','原话还有未明确是端点还是幅度的角度；请明确两个端点，不用示例替代。')
            extract('repetitions',r'(?<![A-Za-z0-9_.])([-+]?[0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百]+)\s*次',_count,r'次')
            extract('dwell_s',r'(?:端点)?停(?:留)?(?:时间)?'+SEP+TIME,_time,r'停留|(?:端点|位置)[^，。；;\n]*停|停\s*\d')
            return_start=bool(re.search(r'(?:结束|完成)后[^，。；;\n]*(?:返回|回到)(?:摆动)?(?:起点|A点)',text))
            hold_end=bool(re.search(r'(?:结束|完成)后[^，。；;\n]*(?:停在|保持)(?:终点|最后位置|B点)',text))
            if return_start and hold_end:
                block('end_behavior','原话包含不同结束要求，请核对结束后应停在哪里。')
                block('end_position_rad','结束要求不唯一，请人工核对。')
            elif return_start:
                add('end_behavior','return_start','request','原话明确要求结束后回到摆动起点；仅记录结束要求。')
            elif hold_end:
                add('end_behavior','hold_end','request','原话明确要求结束后保持终点；仅记录结束要求。')
            elif re.search(r'(?:结束|完成)后|最后(?:停|回|到|保持)|结束位置|初始位置',text):
                block('end_behavior','提到了结束位置，但无法确认是否指摆动起点、终点或模型零位；请手动选择，不替换成示例。')
                block('end_position_rad','请先核对结束位置的含义和角度，不自动猜测。')
        else:
            if re.search(r'温度|湿度|压力|电流|电压|距离|重量|摄氏|华氏|百分比|%|％|伏|安培|公斤|千克|帕斯卡',text) or re.search(r'阈值'+SEP+NUM+r'\s*[A-Za-z°]',text):
                block('threshold','当前阈值是 0–1 的模拟数值；原话带有物理量或单位，不能直接当作归一化阈值，请核对换算。')
            else:
                extract('threshold',r'(?:模拟(?:传感器|数值|值)?[^，。；;\n]*?)?阈值'+SEP+NUM,lambda x:float(x),r'阈值')

        examples={'max_velocity_rad_s':math.radians(30) if intent=='oscillate' else .8,
                  'tolerance_rad':math.radians(2) if intent=='oscillate' else .04}
        if intent=='oscillate':examples.update(repetitions=3,dwell_s=.3,end_behavior='return_start')
        if intent=='threshold':examples={'threshold':.5}
        for key,value in examples.items():
            if _blank(working[key]):add(key,value,'example','这是本机需求草稿的示例值，可以修改；不是硬件安全参数，也不表示已验证。')

        if intent in ('position','oscillate'):
            keys=('target_rad',) if intent=='position' else ('wave_start_rad','wave_end_rad')
            if joint is None:
                for key in keys:
                    if _blank(working[key]):block(key,'请先选模型和有界转动关节，才有依据推荐角度。')
            else:
                low=max(joint['limits']['lower'],-2*math.pi);high=min(joint['limits']['upper'],2*math.pi)
                initial=joint['initial_position']
                if high-low < math.radians(1):
                    for key in keys:
                        if _blank(working[key]):block(key,'模型可用角度范围太窄，无法给出有意义的两个不同点，请手动填写。')
                elif any(working[key] is not None and not low <= working[key] <= high for key in keys):
                    warnings.append('已有角度超出模型范围；保留已有值，暂不补其它角度。')
                    for key in keys:
                        if _blank(working[key]):block(key,'已有端点越界，请先核对它，再补另一个端点。')
                elif intent=='position' and 'target_rad' not in blocked and _blank(working['target_rad']):
                    delta=min(math.radians(30),(high-low)/3)
                    target=.6 if low<=.6<=high else initial+(delta if high-initial>=initial-low else -delta)
                    if low<=target<=high:add('target_rad',target,'example','按已选关节范围给出一个草稿目标；不是实物安全角度。')
                elif intent=='oscillate' and not any(k in blocked for k in keys):
                    a,b=working['wave_start_rad'],working['wave_end_rad']
                    if a is None and b is None:
                        if low<=math.pi/6<math.pi/3<=high:a,b=math.pi/6,math.pi/3
                        else:
                            a=initial;delta=min(math.pi/6,max(high-a,a-low)/2)
                            b=a+(delta if high-a>=a-low else -delta)
                    elif a is None:
                        delta=min(math.pi/6,max(high-b,b-low)/2);a=b+(delta if high-b>=b-low else -delta)
                    elif b is None:
                        delta=min(math.pi/6,max(high-a,a-low)/2);b=a+(delta if high-a>=a-low else -delta)
                    if a is not None and b is not None and low<=a<=high and low<=b<=high and abs(a-b)>=math.radians(.5):
                        for key,value in zip(keys,(a,b)):
                            if _blank(working[key]):add(key,value,'example','参考已选关节初始角度、可用范围和已有端点给出示例；请核对，不代表实物安全范围。')
                    else:
                        for key in keys:
                            if _blank(working[key]):block(key,'无法给出两个可靠且不同的端点，请手动确认。')

        def usable(key):
            value=working[key]
            return isinstance(value,(int,float)) and BOUNDS[key][0]<=value<=BOUNDS[key][1]

        duration=None;velocity=working['max_velocity_rad_s']
        if intent=='threshold':duration=8.0
        elif usable('max_velocity_rad_s'):
            if intent=='position' and joint and usable('target_rad'):
                duration=max(8.0,math.ceil(abs(working['target_rad']-joint['initial_position'])/velocity*1.5+2))
            elif intent=='oscillate' and all(usable(k) for k in ('wave_start_rad','wave_end_rad','repetitions','dwell_s')):
                duration=max(8.0,math.ceil((2*abs(working['wave_end_rad']-working['wave_start_rad'])/velocity+2*working['dwell_s'])*working['repetitions']*1.25+2))
        if duration is not None:
            current=working['duration_s']
            if current is not None and current<duration:warnings.append(f'已有观察时长可能不足：按路程、速度和停留粗估约 {duration:g} 秒；保留原值，请核对。')
            if current is None and 'duration_s' not in blocked:
                if duration<=30:add('duration_s',float(duration),'example','按路程、速度和停留粗估并加余量；不是实际完成时间保证。')
                else:skip(PREFIX+'duration_s',LABELS['duration_s'],f'粗估需要约 {duration:g} 秒，超过当前表单 30 秒范围；不能随便截短，请调整或人工核对。')
    elif intent=='other':
        skip('prd.intake.answers.other_action','其它动作','规则未实现这类动作的自动参数推荐，请自行补充细节。',3)

    for key,label,section in [('structure_id','机器人结构',2),('joint_name','要控制的关节',2),('board','ESP32 编译目标',4)]:
        if _blank(answers[key]) and (intent!='threshold' or key=='board'):
            skip(PREFIX+key,label,'需要用户明确选择，推荐功能不会替你猜。',section)
    if form['mode'] is None:skip('prd.intake.mode','本轮用途','需要确认做本机仿真还是整理硬件资料，不自动选择。',4)
    for group,(label,section) in GROUPS.items():
        data=form['details'][group];selector=data.get('pattern') if group=='motion' else data.get('scope') if group=='device_mapping' else data.get('selection')
        if selector is None:skip('prd.intake.details.'+group,label,'这组设置仍需你核对，推荐功能不会自动确认。',section)
    if not suggestions:warnings.append('没有可明确补入的空白项；已有内容保持不变。')
    warnings.append('只识别少量明确格式，未解释的原话仍须人工核对；推荐不保证需求已完整或代码正确。')
    return {'schema_version':1,'base_draft_hash':checksum,'suggestions':suggestions,'not_filled':not_filled,
            'warnings':list(dict.fromkeys(warnings)),'notice':'仅填写需求草稿；不保存、不调用 AI、不生成代码、不运行设备。示例值可改，未知硬件仍待确认。'}


def apply_recommendation_origins(root, draft, form, model, resolved):
    records=form.get('recommendation_records') or []
    if not records:return
    # Old recommendations remain data. Only equal current values receive an
    # annotation, with explicit stale context; they never become test evidence.
    if model is None and form['answers'].get('structure_id'):
        try:model=get_structure(root,form['answers']['structure_id'])
        except (ValueError,OSError):pass
    current=basis_for(root,draft,form['intent'],model)
    for record in records:
        value=_get(draft,record['path'])
        if value != record['value'] or isinstance(value,bool):continue
        basis=record['basis']
        same_source=(basis['model_source_sha256']==current['model_source_sha256']
                     and (basis['model_source_sha256'] is not None or basis['structure_id']==current['structure_id']))
        stale=(basis['request_text']!=current['request_text'] or basis['intent']!=current['intent']
               or basis['joint_name']!=current['joint_name'] or not same_source)
        description=('从需求提取' if record['source']=='request' else '示例建议')+'：'+record['reason']
        source=('先前建议，需重新核对。'+description) if stale else description
        item=next((x for x in resolved if x['path']==record['path']),None)
        if item is None:
            item={'path':record['path'],'label':record['label'],'value':value,'unit':record['unit']}
            resolved.append(item)
        item.update(origin='suggested',source_ref=source)
