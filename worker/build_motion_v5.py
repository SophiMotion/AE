"""Keep compiler scratch on WSL's Linux disk, deliver installed files on D:."""
import json
from pathlib import Path
import tempfile


def build_ros_v5(output,supervisor,environment):
    output=Path(output);workspace=output/'ros_ws'
    # CMake's many tiny scratch writes are very slow through Windows /mnt/d.
    # WSL /tmp is tool-generated scratch on this machine's D:-hosted WSL VHD.
    # The source, final installation, command and complete console log stay in runs.
    with tempfile.TemporaryDirectory(prefix='ae-v5-colcon-') as scratch:
        command=['colcon','--log-base',str(Path(scratch)/'log'),'build','--base-paths',str(workspace/'src'),
            '--build-base',str(Path(scratch)/'build'),'--install-base',str(workspace/'install'),
            '--merge-install','--executor','sequential','--event-handlers','console_direct+']
        (output/'ros-build-command.json').write_text(json.dumps({'command':command,'scratch':'temporary Linux filesystem; removed after build','source':str(workspace/'src'),'install':str(workspace/'install')},indent=2),encoding='utf-8')
        return supervisor.run(command,output/'ros-build.log',environment,cwd=workspace,timeout=600)
