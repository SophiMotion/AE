"""Private bounded PDF text extraction child; no OCR, links or code execution."""
import io
import json
import logging
import os
import sys


def _limit_memory():
    limit = 512 * 1024 * 1024
    if os.name != 'nt':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        return None
    import ctypes
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                    ('flags', wintypes.DWORD), ('minimum', ctypes.c_size_t), ('maximum', ctypes.c_size_t),
                    ('active', wintypes.DWORD), ('affinity', ctypes.c_size_t),
                    ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ('read', 'write', 'other', 'read_bytes', 'write_bytes', 'other_bytes')]
    class Extended(ctypes.Structure):
        _fields_ = [('basic', Basic), ('io', IO), ('process_memory', ctypes.c_size_t),
                    ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    info = Extended()
    info.basic.flags = 0x100
    info.process_memory = limit
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise ValueError('PDF 解析内存限制未能启用，请先转为文本。')
    return handle


def main():
    try:
        job = _limit_memory()
        try:
            from pypdf import PdfReader
        except ImportError as error:
            raise ValueError('PDF 功能需要安装项目依赖 pypdf。') from error
        logging.disable(logging.CRITICAL)
        raw = sys.stdin.buffer.read(10_000_001)
        if len(raw) > 10_000_000:
            raise ValueError('PDF 不能超过10MB（10,000,000字节）。')
        reader = PdfReader(io.BytesIO(raw), strict=True)
        if reader.is_encrypted:
            raise ValueError('暂不接收加密 PDF，请提供可直接阅读的版本。')
        if len(reader.pages) > 100:
            raise ValueError('PDF 最多100页，请按章节拆分。')
        pages, empty, total = [], [], 0
        for number, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ''
            total += len(text)
            if total > 1_000_000:
                raise ValueError('PDF 提取文本超过100万字符，请拆分。')
            if text.strip():
                pages.append({'page': number, 'text': text})
            else:
                empty.append(number)
        if not pages:
            raise ValueError('PDF 没有可提取文字，可能是扫描件；请先 OCR 或上传文字版。')
        warnings = [f'第{",".join(map(str, empty))}页没有可提取文字，未进入检索；图片或扫描页需另做OCR。'] if empty else []
        result = {'pages': pages, 'warnings': warnings}
    except Exception as error:
        result = {'error': str(error)[:500] if isinstance(error, ValueError) else 'PDF 无法解析、内容损坏或超过512MB内存限制。'}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
    return int('error' in result)


if __name__ == '__main__':
    raise SystemExit(main())
