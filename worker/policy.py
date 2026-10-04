"""Trusted, bounded expression policy and shared JSON protocol helpers."""
import ast
import json
import math
from pathlib import Path
import re

ARGUMENTS = ["value", "target", "threshold", "max_velocity"]
BUILTINS = {"min": min, "max": max, "abs": abs, "float": float}
MATH_CALLS = {"sin", "cos", "tan", "tanh", "sqrt", "fabs", "floor", "ceil", "copysign", "isfinite"}
MATH_CONSTANTS = {"pi", "e", "tau"}
DEFAULTS = {"target": 0.6, "threshold": 0.5, "tolerance": 0.04, "duration": 8.0, "max_velocity": 0.8}
BOUNDS = {"target": (-1.2, 1.2), "threshold": (0.1, 0.9), "tolerance": (0.005, 0.15), "duration": (4.0, 30.0), "max_velocity": (0.1, 2.0)}


def finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("a finite numeric value is required")
    return float(value)


def validate_parameters(parameters, model=None):
    if not isinstance(parameters, dict):
        raise ValueError("parameters must be an object")
    result = dict(DEFAULTS)
    for key, value in parameters.items():
        if key not in BOUNDS:
            raise ValueError("unknown parameter: " + key)
        number = finite_number(value)
        low, high = BOUNDS[key]
        if key=='target' and model is not None:
            joint=next(j for j in model['joints'] if j['name']==model['selected_joint'])
            low,high=joint['limits']['lower'],joint['limits']['upper']
        if not low <= number <= high:
            raise ValueError(f"{key} must be between {low} and {high}")
        result[key] = number
    return result


def safe_output(output, root, deploy=False):
    root = Path(root).resolve()
    output = Path(output).resolve()
    try:
        relative = output.relative_to(root / "runs")
    except ValueError:
        raise ValueError("output must be under this project's runs directory") from None
    leaf_pattern = r"(?:attempt-[1-9][0-9]{0,3}|deployment-[A-Za-z0-9]{8})" if deploy else r"attempt-[1-9][0-9]{0,3}"
    if len(relative.parts) != 2 or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", relative.parts[0]) or not re.fullmatch(leaf_pattern, relative.parts[1]):
        raise ValueError("output must be runs/<id>/attempt-N; --deploy also permits deployment-<8 chars>")
    return output


def parse_frame(raw):
    if not isinstance(raw, str) or len(raw) > 4096:
        raise ValueError("frame must be a short JSON string")
    frame = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
    if not isinstance(frame, dict) or set(("seq", "value", "time")) - frame.keys():
        raise ValueError("frame requires seq, value and time")
    if type(frame["seq"]) is not int or not 0 <= frame["seq"] <= 2147483647:
        raise ValueError("seq must be a nonnegative bounded integer")
    frame["value"] = finite_number(frame["value"])
    frame["time"] = finite_number(frame["time"])
    if frame["time"] < 0:
        raise ValueError("negative timestamp")
    return frame


class SequenceGate:
    def __init__(self):
        self.last = -1

    def accept(self, sequence):
        if type(sequence) is not int or sequence <= self.last or sequence > 2147483647:
            return False
        self.last = sequence
        return True


def load_compute(code):
    if not isinstance(code, str) or len(code) > 12000:
        raise ValueError("code must be text of at most 12000 characters")
    try:
        tree = ast.parse(code)
    except (SyntaxError, RecursionError) as error:
        raise ValueError("invalid Python: " + str(error)) from error
    nodes = list(ast.walk(tree))
    if len(nodes) > 256:
        raise ValueError("function is too large")
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    if len(functions) != 1:
        raise ValueError("exactly one compute_command function is required")
    function = functions[0]
    if function.name != "compute_command" or [arg.arg for arg in function.args.args] != ARGUMENTS:
        raise ValueError("compute_command signature must be value, target, threshold, max_velocity")
    arguments = function.args
    if arguments.posonlyargs or arguments.kwonlyargs or arguments.vararg or arguments.kwarg or arguments.defaults or arguments.kw_defaults or function.decorator_list or function.returns or any(arg.annotation for arg in arguments.args):
        raise ValueError("annotations, decorators, defaults and additional parameters are forbidden")
    if any(not isinstance(node, (ast.FunctionDef, ast.Import)) for node in tree.body):
        raise ValueError("only the function and optional import math are allowed at module scope")
    imports = [node for node in tree.body if isinstance(node, ast.Import)]
    if len(imports) > 1 or any(len(node.names) != 1 or node.names[0].name != "math" or node.names[0].asname for node in imports):
        raise ValueError("only import math is allowed")
    locals_allowed = set(ARGUMENTS)
    for node in ast.walk(function):
        if isinstance(node, ast.Assign):
            if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
                raise ValueError("only simple local assignments are allowed")
            name = node.targets[0].id
            if name.startswith("_") or name in BUILTINS or name == "math" or len(name) > 48:
                raise ValueError("reserved local name")
            locals_allowed.add(name)
    allowed_types = (
        ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Import, ast.alias,
        ast.Assign, ast.Name, ast.Load, ast.Store, ast.Return, ast.If, ast.IfExp,
        ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.Call, ast.Attribute,
        ast.Constant, ast.Expr, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv,
        ast.Mod, ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or, ast.Lt, ast.LtE,
        ast.Gt, ast.GtE, ast.Eq, ast.NotEq,
    )
    docstring_nodes = set()
    if function.body and isinstance(function.body[0], ast.Expr) and isinstance(function.body[0].value, ast.Constant) and isinstance(function.body[0].value.value, str):
        if len(function.body[0].value.value) > 512:
            raise ValueError("docstring is too long")
        docstring_nodes.update((function.body[0], function.body[0].value))
    for node in nodes:
        if isinstance(node, ast.FunctionDef) and node is not function:
            raise ValueError('nested functions are forbidden')
        if isinstance(node, ast.Import) and node not in imports:
            raise ValueError('function-local imports are forbidden')
        if not isinstance(node, allowed_types):
            raise ValueError("forbidden syntax: " + type(node).__name__)
        if isinstance(node, ast.Expr) and node not in docstring_nodes:
            raise ValueError("expression statements are forbidden")
        if isinstance(node, ast.Constant) and node not in docstring_nodes:
            if not isinstance(node.value, (int, float, bool)) or not math.isfinite(node.value) or abs(node.value) > 1e6:
                raise ValueError("only small finite numeric constants are allowed")
        if isinstance(node, ast.Name) and node.id not in locals_allowed | set(BUILTINS) | {"math"}:
            raise ValueError("unknown name: " + node.id)
        if isinstance(node, ast.Attribute):
            if not isinstance(node.value, ast.Name) or node.value.id != "math" or node.attr not in MATH_CALLS | MATH_CONSTANTS:
                raise ValueError("only approved math attributes are allowed")
        if isinstance(node, ast.Call):
            valid = isinstance(node.func, ast.Name) and node.func.id in BUILTINS
            valid = valid or isinstance(node.func, ast.Attribute) and node.func.attr in MATH_CALLS
            if not valid or node.keywords or not 1 <= len(node.args) <= 4:
                raise ValueError("only small approved numeric calls are allowed")
    # math is already supplied; never grant __import__ to generated code.
    tree.body = [function]
    class FloatArithmetic(ast.NodeTransformer):
        def visit_BinOp(self, node):
            node = self.generic_visit(node)
            node.left = ast.Call(func=ast.Name(id='float',ctx=ast.Load()),args=[node.left],keywords=[])
            node.right = ast.Call(func=ast.Name(id='float',ctx=ast.Load()),args=[node.right],keywords=[])
            return node
    # A small AST alone does not bound Python integer multiplication. Cast both
    # operands of every arithmetic operation, including values from comparisons
    # and floor/ceil, so repeated squaring cannot allocate unbounded integers.
    tree = ast.fix_missing_locations(FloatArithmetic().visit(tree))
    namespace = {"__builtins__": BUILTINS, "math": math}
    exec(compile(tree, "generated-logic", "exec"), namespace)
    compute = namespace["compute_command"]

    def checked(value, target, threshold, max_velocity):
        result = compute(*(finite_number(x) for x in (value, target, threshold, max_velocity)))
        return finite_number(result)

    return checked
