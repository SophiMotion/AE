"""Generate exportable V3 workspace with a single trusted feedback pipeline."""
import json
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from .contract import project_contract
from .templates import generate
from .physics_v3 import generate_sdf
from .robot_model import gen_urdf,validate_execution_model

LAUNCH='''from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
from pathlib import Path
def generate_launch_description():
    share=Path(get_package_share_directory('ae_generated'))
    config=str(share/'config'/'parameters.yaml')
    host=str(share/'config'/'host_protocol')
    namespace='ae_export'
    environment={'IGN_PARTITION':namespace,'GZ_PARTITION':namespace}
    nodes=[Node(package='ae_generated',executable='serial_bridge',namespace=namespace,parameters=[config,{'host_binary':host}]),Node(package='ae_generated',executable='task_node',namespace=namespace,parameters=[config])]
    __PHYSICS__
    return LaunchDescription(nodes)
'''
PHYSICS="""nodes.extend([ExecuteProcess(cmd=['ign','gazebo','-s','-r','-v','3',str(share/'config'/'joint.sdf')],additional_env=environment,output='screen'),Node(package='ros_gz_bridge',executable='parameter_bridge',arguments=['/ae_export/velocity@std_msgs/msg/Float64]ignition.msgs.Double','/ae_export/raw_joint_state@sensor_msgs/msg/JointState[ignition.msgs.Model'],additional_env=environment),Node(package='ae_generated',executable='gazebo_device',namespace=namespace,parameters=[config])])"""

def generate_v3(output,spec,code,firmware_code):
    contract=project_contract(spec)
    model=validate_execution_model(spec['execution_model']) if spec['task_type']=='joint_position' else {'schema_version':1,'model_id':'software_scalar_channel','model_sha256':contract['communication']['identity']['model_sha256'],'selected_joint':'scalar_channel','joints':[],'links':[],'held_positions':{},'assumptions':{'sensor':'software scalar pattern only; structure context is not actuated'}}
    package=generate(output,spec,code,firmware_code=firmware_code);module=package/'ae_generated';config=package/'config'
    joint=next((j for j in model['joints'] if j['name']==model['selected_joint']),None)
    binding={'identity':contract['communication']['identity'],'task_type':spec['task_type'],'parameters':spec['parameters'],
       'value_bounds':[joint['limits']['lower'],joint['limits']['upper']] if spec['task_type']=='joint_position' else [0.0,1.0],
       'initial_position':joint['initial_position'] if joint else 0.0,'physical_io':False}
    binding_json=json.dumps(binding,ensure_ascii=False,indent=2,allow_nan=False)
    (module/'binding.json').write_text(binding_json,encoding='utf-8');(output/'binding.json').write_text(binding_json,encoding='utf-8')
    # setuptools package_data needed for runtime identity (not inferred from cwd).
    setup=(package/'setup.py').read_text().replace("packages=['ae_generated'],","packages=['ae_generated'],package_data={'ae_generated':['binding.json']},").replace("'sim_device=ae_generated.runtime:device_main',",'')
    (package/'setup.py').write_text(setup,encoding='utf-8')
    for source,destination in [('runtime_v3.py','runtime.py'),('binding.py','binding.py'),('serial_bridge_v3.py','serial_bridge.py'),('gazebo_v3.py','gazebo_device.py')]: shutil.copyfile(Path(__file__).with_name(source),module/destination)
    (output/'execution-model.json').write_text(json.dumps(model,ensure_ascii=False,indent=2),encoding='utf-8')
    if joint:
        urdf=ET.fromstring(gen_urdf(model),parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
        for node in urdf.findall('joint'):
            if node.get('name')==model['selected_joint']: node.find('limit').set('velocity',str(spec['parameters']['max_velocity']))
        (config/'robot.urdf').write_text(ET.tostring(urdf,encoding='unicode',xml_declaration=True),encoding='utf-8')
    (config/'initial-positions.json').write_text(json.dumps({j['name']:j['initial_position'] for j in model['joints']},indent=2),encoding='utf-8')
    if spec['task_type']=='joint_position': (config/'joint.sdf').write_text(generate_sdf(model,'/ae_export',spec['parameters']['max_velocity']),encoding='utf-8')
    for launch in (package/'launch').glob('*.py'): launch.unlink()
    (package/'launch'/'bench.launch.py').write_text(LAUNCH.replace('__PHYSICS__',PHYSICS if spec['task_type']=='joint_position' else ''),encoding='utf-8')
    (output/'communication.json').write_text(json.dumps(contract,ensure_ascii=False,indent=2),encoding='utf-8')
    readme='''# V3 同模型 ROS / 固件测试台

此工程包含审批时的 execution-model.json 模型、全树 robot.urdf、源姿态和所选关节的 SDF。仅所选轴可动，其余轴固定在源姿态。质量/惯量等数值占位、零重力和理想速度驱动不代表真实电机或接触性能。

joint_position 的唯一正常闭环：Gazebo 所选关节 → ROS bench_measurement → PTY → 主机执行的固件协议核心 → ROS state → 任务函数 → PTY command → 核心 command_applied → ROS velocity → 同一 Gazebo 关节。主机核心不是 ESP32 芯片执行；没有烧录或真实串口/GPIO。sensor_threshold 使用明确的固件标量测试序列，不驱动该结构关节。

本机 WSL 离线复现（须已安装固定 ROS/Gazebo 与编译工具链）：

```bash
source /opt/ros/humble/setup.bash
colcon build --merge-install --executor sequential
source install/local_setup.bash
ROS_DOMAIN_ID=78 ROS_LOCALHOST_ONLY=1 ros2 launch ae_generated bench.launch.py
```

launch 使用专有 PTY，Ctrl+C 会停止自有主机核心进程。firmware-build.json 提供实际 ESP32 固件编译命令/产物哈希。result.json 与逐场景 trace 记录独立验收；导出的 launch 本身不是重新验收证明。
'''
    if not joint: readme=readme.replace('此工程包含审批时的 execution-model.json 模型、全树 robot.urdf、源姿态和所选关节的 SDF。仅所选轴可动，其余轴固定在源姿态。质量/惯量等数值占位、零重力和理想速度驱动不代表真实电机或接触性能。','此工程使用 scalar_channel 软件标量任务，结构只作上下文。execution-model.json 明确记录没有活动关节；不生成关节 URDF/SDF、不运行 Gazebo，也不宣称真实传感器读数。')
    (package/'README.md').write_text(readme,encoding='utf-8')
    return package,binding
