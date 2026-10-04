"""Sophicore frame ledger: preserve source FK, metres/radians, +Z up.

Gazebo zero is the saved CAD pose, so logical q = simulator q + source initial.
All active axes retain source joint frames/limits. Other axes are fixed at their
saved pose. This fixed-base zero-gravity model has numerical inertia and visual
proxies, and does not test balance, contacts, loads or physical motor ratings.
"""
import xml.etree.ElementTree as ET
from .motion_spec_v5 import validate_motion_model
from .robot_model import build_execution_model, gen_urdf
from .physics_v3 import generate_sdf, fmt


def scalar_view(model):
    validate_motion_model(model)
    return build_execution_model({'id': model['model_id'], 'links': model['links'],
        'joints': model['joints']}, model['active_joint_names'][0])


def generate_sdf_v5(model, namespace, max_velocity):
    root = ET.fromstring(generate_sdf(scalar_view(model), namespace, max_velocity))
    root.insert(0, ET.Comment('V5 model_sha256=' + model['model_sha256'] + '; fixed base, zero gravity, numerical inertia, no contacts'))
    robot = root.find('world/model')
    joints = {j['name']: j for j in model['joints']}
    active = model['active_joint_names']
    for node in robot.findall('joint'):
        name = node.get('name')
        if name not in active:
            continue
        item = joints[name]
        node.set('type', 'revolute')
        for old in node.findall('axis'):
            node.remove(old)
        axis = ET.SubElement(node, 'axis')
        ET.SubElement(axis, 'xyz').text = fmt(item['axis'])
        limit = ET.SubElement(axis, 'limit')
        values = {'lower': item['limits']['lower'] - item['initial_position'],
            'upper': item['limits']['upper'] - item['initial_position'],
            'velocity': max_velocity, 'effort': 1000}
        for key, value in values.items():
            ET.SubElement(limit, key).text = str(value)
    for plugin in robot.findall('plugin'):
        robot.remove(plugin)
    for index, name in enumerate(active):
        controller = ET.SubElement(robot, 'plugin', filename='ignition-gazebo-joint-controller-system', name='gz::sim::systems::JointController')
        ET.SubElement(controller, 'joint_name').text = name
        ET.SubElement(controller, 'topic').text = namespace + '/velocity_' + str(index)
    state = ET.SubElement(robot, 'plugin', filename='ignition-gazebo-joint-state-publisher-system', name='gz::sim::systems::JointStatePublisher')
    for name in active:
        ET.SubElement(state, 'joint_name').text = name
    ET.SubElement(state, 'topic').text = namespace + '/raw_joint_state'
    ET.SubElement(state, 'update_rate').text = '50'
    ET.indent(root)
    return ET.tostring(root, encoding='unicode', xml_declaration=True)


def generate_urdf_v5(model, program, namespace):
    root = ET.fromstring(gen_urdf(scalar_view(model)))
    control = ET.SubElement(root, 'ros2_control', name='SophicoreMotionSystem', type='system')
    hardware = ET.SubElement(control, 'hardware')
    ET.SubElement(hardware, 'plugin').text = 'ae_motion_hardware/TopicSystem'
    for key, value in {'namespace': namespace,
        'identity': model['model_sha256'] + ':' + program['program_sha256']}.items():
        ET.SubElement(hardware, 'param', name=key).text = value
    joints = {j['name']: j for j in model['joints']}
    for name in model['active_joint_names']:
        item = joints[name]
        node = ET.SubElement(control, 'joint', name=name)
        command = ET.SubElement(node, 'command_interface', name='position')
        for key, value in [('min', item['limits']['lower']), ('max', item['limits']['upper'])]:
            ET.SubElement(command, 'param', name=key).text = str(value)
        state = ET.SubElement(node, 'state_interface', name='position')
        ET.SubElement(state, 'param', name='initial_value').text = str(item['initial_position'])
    ET.indent(root)
    return ET.tostring(root, encoding='unicode', xml_declaration=True)
