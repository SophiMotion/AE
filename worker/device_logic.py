"""Bounded AI-owned C++ device function; no IO, calls, loops or global state.

This lexical gate deliberately leaves C++ syntax diagnostics to the actual
compiler. Only one short numeric function can be generated or repaired.
"""
import math
import re

DEFAULT_DEVICE_CODE = '''double limit_command(double value, double max_velocity) {
    if (value > max_velocity) return max_velocity;
    if (value < -max_velocity) return -max_velocity;
    return value;
}
'''
_HEADER = re.compile(r'^double\s+limit_command\s*\(\s*double\s+value\s*,\s*double\s+max_velocity\s*\)\s*\{')
_TOKEN = re.compile(r'\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|<=|>=|==|!=|&&|\|\||[{}();?:,+*<>=!\-]')
_WORDS = {'double', 'limit_command', 'value', 'max_velocity', 'if', 'else', 'return'}


def validate_device_code(code):
    if not isinstance(code, str) or len(code.encode('utf-8')) > 6000:
        raise ValueError('ESP32 生成片段只能是一段简短的数值限幅函数。')
    # Comments are not executed. Remove them before token checks and compilation.
    source = re.sub(r'/\*.*?\*/|//[^\n]*', '', code, flags=re.S).strip()
    header = _HEADER.match(source)
    if not header or not source.endswith('}'):
        raise ValueError('ESP32 片段必须使用规定的 limit_command(value, max_velocity) 函数签名。')
    if source.count('limit_command') != 1 or re.search(r'\+\+|--', source):
        raise ValueError('ESP32 片段不能调用函数、递归或使用自增自减。')
    if re.search(r'\bdouble\b', source[header.end():]):
        # '*' is needed for multiplication, but a C-style (double*) cast would
        # otherwise turn numeric literals into pointers. Types exist only in
        # the fixed signature, never in the generated body.
        raise ValueError('ESP32 函数体不能声明类型、指针或做类型强制转换。')
    tokens, offset = [], 0
    while offset < len(source):
        match = _TOKEN.match(source, offset)
        if not match:
            raise ValueError('ESP32 片段包含不允许的字符、预处理、指针、字符串或运算。')
        token = match.group()
        offset = match.end()
        if token.isspace():
            continue
        tokens.append(token)
        if len(tokens) > 600:
            raise ValueError('ESP32 片段过于复杂。')
        if token[0].isalpha() or token[0] == '_':
            if token not in _WORDS:
                raise ValueError(f'ESP32 片段不允许使用 {token}；只生成数值检查，不访问设备或系统。')
        elif token[0].isdigit() or token[0] == '.':
            number = float(token)
            if not math.isfinite(number) or abs(number) > 1000000:
                raise ValueError('ESP32 片段中的数字不在允许范围。')
    # Balanced outer function scope excludes trailing definitions and globals.
    depth = 0
    for i, char in enumerate(source):
        if char == '{':
            depth += 1
            if depth > 24:
                raise ValueError('ESP32 条件嵌套过深。')
        elif char == '}':
            depth -= 1
            if depth < 0 or (depth == 0 and i != len(source)-1):
                raise ValueError('ESP32 片段只能包含一个函数。')
    if depth != 0:
        raise ValueError('ESP32 函数的大括号不匹配。')
    # After the declaration, only if (...) may introduce a named parenthesis.
    if re.search(r'\b(?!if\b)[A-Za-z_]\w*\s*\(', source[header.end():]):
        raise ValueError('ESP32 片段不能调用函数或定义其他函数。')
    return source + '\n'


# Worker-facing spelling; keep a single validation implementation.
validate_device_logic = validate_device_code
