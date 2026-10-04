"""Strict, ROS-independent V3 identity and finite frame validation."""
import json
import math
from pathlib import Path


def load_binding():
    return json.loads(Path(__file__).with_name('binding.json').read_text(encoding='utf-8'))


def _pairs(items):
    result={}
    for key,value in items:
        if key in result: raise ValueError('duplicate field')
        result[key]=value
    return result


def parse_bound_frame(raw,binding,kind=None):
    if not isinstance(raw,str) or len(raw.encode('utf-8'))>511: raise ValueError('frame exceeds 511 bytes')
    frame=json.loads(raw,object_pairs_hook=_pairs,parse_constant=lambda x: (_ for _ in ()).throw(ValueError('nonfinite constant')))
    if not isinstance(frame,dict): raise ValueError('frame must be object')
    for key,value in binding['identity'].items():
        if frame.get(key)!=value: raise ValueError('identity mismatch: '+key)
    if kind is not None and frame.get('kind')!=kind: raise ValueError('unexpected frame kind')
    if frame.get('kind') not in ('command','measurement','state','event'): raise ValueError('unknown frame kind')
    seq=frame.get('seq')
    if isinstance(seq,bool) or not isinstance(seq,int) or not (-1 if frame['kind']=='event' else 0)<=seq<=2147483647: raise ValueError('invalid sequence')
    for key in ('time','value'):
        value=frame.get(key)
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value): raise ValueError('invalid finite '+key)
    if frame['time']<0: raise ValueError('negative time')
    if frame['kind'] in ('command','measurement') and set(frame)!={'kind','seq','time','value',*binding['identity']}: raise ValueError('unexpected fields')
    return frame


def frame(binding,kind,seq,stamp,value,**extra):
    return json.dumps({'kind':kind,'seq':seq,'time':stamp,'value':value,**binding['identity'],**extra},separators=(',',':'),allow_nan=False)


class SerialLines:
    """Consume each line independently so one bad line cannot poison recovery."""
    def __init__(self,binding): self.binding=binding;self.buffer=bytearray();self.overflow=False
    def feed(self,block):
        packets=[];errors=[]
        for byte in block:
            if byte==10:
                raw=bytes(self.buffer);overflow=self.overflow
                self.buffer.clear();self.overflow=False
                if overflow: errors.append('oversize_or_nul serial RX')
                elif raw:
                    try:
                        text=raw.decode('utf-8');packet=parse_bound_frame(text,self.binding)
                        if packet['kind'] not in ('state','event'): raise ValueError('unexpected serial RX kind')
                        packets.append((text,packet))
                    except Exception as error: errors.append(str(error))
            elif byte==0 or len(self.buffer)>=511: self.overflow=True
            elif not self.overflow: self.buffer.append(byte)
        return packets,errors
