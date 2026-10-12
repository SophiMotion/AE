"""Refresh the public reference from the same generator. No DB or device access.

Run from the repository root: python web/scripts/prepare-foldbot-demo.py
The generated reference is separate from visitors' editable browser drafts.
"""
import copy
import json
import sys
import threading
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.foldbot_projects import FoldBotProjects, DEFAULTS


class MemoryStore:
    def __init__(self):
        self.lock = threading.RLock()
        self.values = {}

    def get(self, kind, ident):
        return copy.deepcopy(self.values[(kind, ident)])

    def put(self, kind, value):
        self.values[(kind, value['id'])] = copy.deepcopy(value)
        return copy.deepcopy(value)

    def list(self, kind):
        return [copy.deepcopy(value) for (key, _), value in self.values.items() if key == kind]


def main():
    service = FoldBotProjects(MemoryStore(), ROOT)
    with patch('server.foldbot_projects.uid', side_effect=[
        'foldbot-reference-20261012', 'foldbot-reference-source-v1',
    ]):
        project = service.create({**DEFAULTS, 'name': 'FoldBot · 现有整机工程参考'})
        project = service.generate(project['id'], {'revision': 1, 'reviewed': True})
    previews = {item['path']: service.file(project['id'], item['path'])
                for item in project['generation']['files']}
    _, archive = service.export(project['id'])
    reference = {
        'schema_version': 1, 'label': '已有模板参考工程',
        'template': service.template(), 'project': project, 'previews': previews,
        'archive_url': './foldbot-example.zip',
    }
    target = ROOT / 'web' / 'public'
    (target / 'foldbot-example.json').write_text(
        json.dumps(reference, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (target / 'foldbot-example.zip').write_bytes(archive)
    print(json.dumps({'files': len(previews), 'zip_bytes': len(archive),
                      'physical_verified': False, 'ros_executed': False}))


if __name__ == '__main__':
    main()
