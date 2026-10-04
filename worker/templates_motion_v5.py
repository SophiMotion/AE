"""Generate relocatable ROS 2/JTC and frozen firmware source workspaces."""
import json
from pathlib import Path
import shutil
from .physics_v5 import generate_sdf_v5, generate_urdf_v5
from .firmware_v5 import generate_firmware_v5
from .motion_spec_v5 import motion_contract


def controller_parameters(spec, namespace):
    names=spec['motion_program']['joint_names'];tolerance=spec['motion_program']['tolerance_rad']
    return {'/**':{'ros__parameters':{'use_sim_time':True}},
        namespace+'/controller_manager':{'ros__parameters':{'update_rate':50,'trajectory':{'type':'joint_trajectory_controller/JointTrajectoryController'}}},
        namespace+'/trajectory':{'ros__parameters':{'joints':names,'command_interfaces':['position'],'state_interfaces':['position'],
            'state_publish_rate':50.,'action_monitor_rate':20.,'allow_partial_joints_goal':False,'open_loop_control':False,
            'constraints':{'goal_time':2.,'stopped_velocity_tolerance':0.,**{n:{'trajectory':.5,'goal':tolerance} for n in names}}}}}


LAUNCH = '''from launch import LaunchDescription
from launch.actions import ExecuteProcess, RegisterEventHandler, OpaqueFunction
from launch.event_handlers import OnShutdown
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory, get_package_prefix
from pathlib import Path
import os
import uuid
import tempfile

def generate_launch_description():
    share=Path(get_package_share_directory('ae_generated')); config=share/'config'
    ns='ae_export_'+uuid.uuid4().hex[:16]; env={'IGN_PARTITION':ns,'GZ_PARTITION':ns}
    args=[a.replace('/ae_export_v5','/'+ns) for a in __BRIDGE__]
    description=(config/'robot.urdf').read_text().replace('/ae_export_v5','/'+ns)
    scratch=tempfile.TemporaryDirectory(prefix='ae-sophicore-')
    world=Path(scratch.name)/'robot.sdf'; parameters=Path(scratch.name)/'controllers.yaml'
    world.write_text((config/'robot.sdf').read_text().replace('/ae_export_v5','/'+ns))
    parameters.write_text((config/'controllers.yaml').read_text().replace('/ae_export_v5','/'+ns))
    return LaunchDescription([
        RegisterEventHandler(OnShutdown(on_shutdown=[OpaqueFunction(function=lambda context: scratch.cleanup() or [])])),
        ExecuteProcess(cmd=['ign','gazebo','-s','-r','-v','3',str(world)],additional_env=env,output='screen'),
        Node(package='ros_gz_bridge',executable='parameter_bridge',arguments=args,additional_env=env,remappings=[('/clock','/'+ns+'/clock')]),
        Node(package='ae_generated',executable='serial_bridge',namespace=ns,parameters=[{'host_binary':str(Path(get_package_prefix('ae_motion_hardware'))/'lib'/'ae_motion_hardware'/'host_protocol_v5')}]),
        Node(package='ae_generated',executable='gazebo_motion',namespace=ns),
        Node(package='controller_manager',executable='ros2_control_node',namespace=ns,parameters=[str(parameters),{'robot_description':description}],remappings=[('/clock','/'+ns+'/clock')]),
        Node(package='controller_manager',executable='spawner',namespace=ns,arguments=['trajectory','--controller-manager','/'+ns+'/controller_manager']),
        Node(package='ae_generated',executable='motion_task',namespace=ns,parameters=[{'use_sim_time':True}],remappings=[('/clock','/'+ns+'/clock')])
    ])
'''


def bridge_arguments(namespace, count):
    return [namespace+'/raw_joint_state@sensor_msgs/msg/JointState[ignition.msgs.Model',
        '/clock@rosgraph_msgs/msg/Clock[ignition.msgs.Clock'] + [namespace+'/velocity_'+str(i)+'@std_msgs/msg/Float64]ignition.msgs.Double' for i in range(count)]


def generate_motion_v5(output, spec, firmware_code=None):
    output=Path(output);contract=motion_contract(spec);fw=generate_firmware_v5(output,spec,firmware_code)
    package=output/'ros_ws'/'src'/'ae_generated';module=package/'ae_generated';config=package/'config'
    for folder in (module,config,package/'resource',package/'launch'):folder.mkdir(parents=True,exist_ok=True)
    (module/'__init__.py').write_text('')
    (package/'resource'/'ae_generated').write_text('')
    for source,dest in [('serial_bridge_v5.py','serial_bridge.py'),('gazebo_motion_v5.py','gazebo_motion.py'),('runtime_motion_v5.py','motion_task.py')]:
        shutil.copyfile(Path(__file__).with_name(source),module/dest)
    for name,value in [('binding.json',fw['binding']),('program.json',spec['motion_program'])]:
        (module/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    (package/'setup.py').write_text("""from setuptools import setup
from glob import glob
setup(name='ae_generated',version='5.0.0',packages=['ae_generated'],package_data={'ae_generated':['binding.json','program.json']},
data_files=[('share/ament_index/resource_index/packages',['resource/ae_generated']),('share/ae_generated',['package.xml','README.md']),('share/ae_generated/config',glob('config/*')),('share/ae_generated/launch',glob('launch/*.py'))],
entry_points={'console_scripts':['serial_bridge=ae_generated.serial_bridge:main','gazebo_motion=ae_generated.gazebo_motion:main','motion_task=ae_generated.motion_task:main']})
""",encoding='utf-8')
    (package/'setup.cfg').write_text('[develop]\nscript_dir=$base/lib/ae_generated\n[install]\ninstall_scripts=$base/lib/ae_generated\n')
    (package/'package.xml').write_text('''<?xml version="1.0"?><package format="3"><name>ae_generated</name><version>5.0.0</version><description>Frozen Sophicore multi joint action</description><maintainer email="local@example.invalid">AE</maintainer><license>Proprietary</license><buildtool_depend>ament_python</buildtool_depend><exec_depend>rclpy</exec_depend><exec_depend>control_msgs</exec_depend><exec_depend>trajectory_msgs</exec_depend><exec_depend>sensor_msgs</exec_depend><exec_depend>std_msgs</exec_depend><exec_depend>controller_manager</exec_depend><exec_depend>joint_trajectory_controller</exec_depend><exec_depend>ros_gz_bridge</exec_depend><export><build_type>ament_python</build_type></export></package>''')
    (config/'robot.urdf').write_text(generate_urdf_v5(spec['execution_model'],spec['motion_program'],'/ae_export_v5'),encoding='utf-8')
    (config/'robot.sdf').write_text(generate_sdf_v5(spec['execution_model'],'/ae_export_v5',spec['motion_program']['max_velocity_rad_s']),encoding='utf-8')
    (config/'controllers.yaml').write_text(json.dumps(controller_parameters(spec,'/ae_export_v5')),encoding='utf-8')
    (package/'launch'/'bench.launch.py').write_text(LAUNCH.replace('__BRIDGE__',repr(bridge_arguments('/ae_export_v5',len(spec['motion_program']['joint_names'])))),encoding='utf-8')
    (package/'README.md').write_text('''# Sophicore 多关节本机测试

ROS 2 Humble 的 JointTrajectoryController 执行已核对的逐关节路点。命令及测量经过主机 PTY 上运行的同源 ESP32 C++ 固件核心，核心输出限速和限加速度的速度，驱动 Gazebo Fortress 的同一模型。

## 重新运行

在已安装 ROS 2 Humble、Gazebo Fortress、ros_gz_bridge、ros2_control 和 joint_trajectory_controller 的 Linux/WSL 环境：

```bash
source /opt/ros/humble/setup.bash
cd ros_ws
colcon build --merge-install --executor sequential
source install/local_setup.bash
ROS_DOMAIN_ID=78 ROS_LOCALHOST_ONLY=1 ros2 launch ae_generated bench.launch.py
```

Ctrl+C 结束本次进程。导出包中的主机核心需要 x86_64 Linux；ESP32 和 ESP32-S3 的独立 bin/elf、编译记录在 esp32 目录。没有烧录，虚拟测量并非 ESP 芯片或真实电机执行。模型固定底座、零重力、占位惯量、无接触，不验证负载、碰撞或平衡。result.json 和各次 trace 是实际验收证据；启动动画本身不代表验收通过。
''',encoding='utf-8')
    hardware=package.parent/'ae_motion_hardware';hardware.mkdir(exist_ok=True)
    shutil.copyfile(Path(__file__).with_name('topic_hardware_v5.cpp'),hardware/'topic_hardware_v5.cpp')
    for filename in ('host_protocol_v5.cpp','protocol_core_v5.hpp','model_binding_v5.hpp'):
        shutil.copyfile(output/'esp32'/filename,hardware/filename)
    (hardware/'package.xml').write_text('''<?xml version="1.0"?><package format="3"><name>ae_motion_hardware</name><version>5.0.0</version><description>Firmware bound motion hardware</description><maintainer email="local@example.invalid">AE</maintainer><license>Proprietary</license><buildtool_depend>ament_cmake</buildtool_depend><depend>hardware_interface</depend><depend>pluginlib</depend><depend>rclcpp</depend><depend>sensor_msgs</depend><depend>std_msgs</depend><export><build_type>ament_cmake</build_type></export></package>''')
    (hardware/'plugin.xml').write_text('<library path="ae_motion_hardware"><class name="ae_motion_hardware/TopicSystem" type="ae_motion_hardware::TopicSystem" base_class_type="hardware_interface::SystemInterface"><description>Bound PTY firmware state and position commands</description></class></library>')
    (hardware/'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.16)
project(ae_motion_hardware)
set(CMAKE_CXX_STANDARD 17)
find_package(ament_cmake REQUIRED)
find_package(hardware_interface REQUIRED)
find_package(pluginlib REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(std_msgs REQUIRED)
add_library(ae_motion_hardware SHARED topic_hardware_v5.cpp)
add_executable(host_protocol_v5 host_protocol_v5.cpp)
target_compile_options(host_protocol_v5 PRIVATE -O2 -Wall -Wextra -Werror)
ament_target_dependencies(ae_motion_hardware hardware_interface pluginlib rclcpp sensor_msgs std_msgs)
pluginlib_export_plugin_description_file(hardware_interface plugin.xml)
install(TARGETS ae_motion_hardware LIBRARY DESTINATION lib)
install(TARGETS host_protocol_v5 RUNTIME DESTINATION lib/ae_motion_hardware)
ament_package()
''')
    for filename,value in [('execution-model.json',spec['execution_model']),('motion-program.json',spec['motion_program']),('communication.json',contract),('spec-used.json',spec)]:
        (output/filename).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    return package,fw['binding']
