"""Execution-model SDF: source pose is q_gazebo=0, logical q=q+initial."""
import math
import xml.etree.ElementTree as ET
from .robot_model import validate_execution_model

def identity(): return [[float(i==j) for j in range(4)] for i in range(4)]
def multiply(a,b): return [[sum(a[i][k]*b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
def transform(xyz,rpy):
    x,y,z=rpy;cx,sx,cy,sy,cz,sz=math.cos(x),math.sin(x),math.cos(y),math.sin(y),math.cos(z),math.sin(z)
    return [[cz*cy,cz*sy*sx-sz*cx,cz*sy*cx+sz*sx,xyz[0]],[sz*cy,sz*sy*sx+cz*cx,sz*sy*cx-cz*sx,xyz[1]],[-sy,cy*sx,cy*cx,xyz[2]],[0,0,0,1]]
def axis_rotation(axis,angle):
    x,y,z=axis;c=math.cos(angle);s=math.sin(angle);v=1-c
    return [[x*x*v+c,x*y*v-z*s,x*z*v+y*s,0],[y*x*v+z*s,y*y*v+c,y*z*v-x*s,0],[z*x*v-y*s,z*y*v+x*s,z*z*v+c,0],[0,0,0,1]]
def pose(matrix):
    pitch=math.asin(max(-1,min(1,-matrix[2][0])))
    if abs(math.cos(pitch))>1e-8: roll=math.atan2(matrix[2][1],matrix[2][2]);yaw=math.atan2(matrix[1][0],matrix[0][0])
    else: roll=0;yaw=math.atan2(-matrix[0][1],matrix[1][1])
    return [matrix[i][3] for i in range(3)]+[roll,pitch,yaw]
def fmt(values): return ' '.join(format(v,'.16g') for v in values)

def source_poses(model):
    matrices={model['root_link']:identity()};pending=list(model['joints']);joint_matrices={}
    while pending:
        found=False
        for joint in pending[:]:
            if joint['parent'] not in matrices: continue
            neutral=multiply(matrices[joint['parent']],transform(joint['origin']['xyz'],joint['origin']['rpy']))
            q=joint['initial_position'] if joint['type']!='fixed' else 0
            child=multiply(neutral,axis_rotation(joint['axis'],q))
            matrices[joint['child']]=child;joint_matrices[joint['name']]=child;pending.remove(joint);found=True
        if not found: raise ValueError('model tree disconnected')
    return matrices,joint_matrices

def generate_sdf(model,namespace,max_velocity):
    validate_execution_model(model);matrices,joint_matrices=source_poses(model)
    sdf=ET.Element('sdf',version='1.8');sdf.append(ET.Comment('model_sha256='+model['model_sha256']+'; numerical inertia placeholders; zero gravity; no contact or motor fidelity'))
    world=ET.SubElement(sdf,'world',name='ae_world');ET.SubElement(world,'gravity').text='0 0 0'
    physics=ET.SubElement(world,'physics',name='dart',type='dart');ET.SubElement(physics,'max_step_size').text='0.001';ET.SubElement(physics,'real_time_factor').text='1'
    plugin=ET.SubElement(world,'plugin',filename='ignition-gazebo-physics-system',name='gz::sim::systems::Physics');engine=ET.SubElement(plugin,'engine');ET.SubElement(engine,'filename').text='/usr/lib/x86_64-linux-gnu/ign-physics-5/engine-plugins/libignition-physics5-dartsim-plugin.so.5'
    ET.SubElement(world,'plugin',filename='ignition-gazebo-user-commands-system',name='gz::sim::systems::UserCommands')
    robot=ET.SubElement(world,'model',name='ae_robot')
    for link in model['links']:
        node=ET.SubElement(robot,'link',name=link['name']);ET.SubElement(node,'pose',relative_to='__model__').text=fmt(pose(matrices[link['name']]))
        inertial=ET.SubElement(node,'inertial');ET.SubElement(inertial,'pose').text=fmt(link['center_of_mass']+[0,0,0]);ET.SubElement(inertial,'mass').text=str(link['mass']);inertia=ET.SubElement(inertial,'inertia')
        for key,value in link['inertia'].items(): ET.SubElement(inertia,key).text=str(value)
        for index,visual in enumerate(link.get('visuals',[])):
            vis=ET.SubElement(node,'visual',name='visual_'+str(index));ET.SubElement(vis,'pose').text=fmt(visual.get('xyz',[0,0,0])+visual.get('rpy',[0,0,0]));geometry=ET.SubElement(vis,'geometry');shape=ET.SubElement(geometry,visual['type'])
            if visual['type']=='box': ET.SubElement(shape,'size').text=fmt(visual['size'])
            elif visual['type']=='sphere': ET.SubElement(shape,'radius').text=str(visual['radius'])
            elif visual['type']=='cylinder': ET.SubElement(shape,'radius').text=str(visual['radius']);ET.SubElement(shape,'length').text=str(visual['length'])
            else: raise ValueError('unsupported execution visual')
    anchor='ae_world_fixed';existing={j['name'] for j in model['joints']}
    while anchor in existing: anchor+='_'  # Imported legal names cannot collide with trusted anchor.
    fixed=ET.SubElement(robot,'joint',name=anchor,type='fixed');ET.SubElement(fixed,'parent').text='world';ET.SubElement(fixed,'child').text=model['root_link']
    for item in model['joints']:
        selected=item['name']==model['selected_joint'];joint=ET.SubElement(robot,'joint',name=item['name'],type='revolute' if selected else 'fixed')
        ET.SubElement(joint,'parent').text=item['parent'];ET.SubElement(joint,'child').text=item['child'];ET.SubElement(joint,'pose',relative_to='__model__').text=fmt(pose(joint_matrices[item['name']]))
        if selected:
            axis=ET.SubElement(joint,'axis');ET.SubElement(axis,'xyz').text=fmt(item['axis']);limit=ET.SubElement(axis,'limit')
            for key,value in {'lower':item['limits']['lower']-item['initial_position'],'upper':item['limits']['upper']-item['initial_position'],'velocity':max_velocity,'effort':1000}.items(): ET.SubElement(limit,key).text=str(value)
    controller=ET.SubElement(robot,'plugin',filename='ignition-gazebo-joint-controller-system',name='gz::sim::systems::JointController');ET.SubElement(controller,'joint_name').text=model['selected_joint'];ET.SubElement(controller,'topic').text=namespace+'/velocity'
    state=ET.SubElement(robot,'plugin',filename='ignition-gazebo-joint-state-publisher-system',name='gz::sim::systems::JointStatePublisher');ET.SubElement(state,'joint_name').text=model['selected_joint'];ET.SubElement(state,'topic').text=namespace+'/raw_joint_state';ET.SubElement(state,'update_rate').text='20'
    return ET.tostring(sdf,encoding='unicode',xml_declaration=True)
