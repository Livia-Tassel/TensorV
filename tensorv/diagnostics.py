"""Conservative shape diagnostics; never evaluate or retry a user's expression.

Only direct tensor names and literal/plain integer shape values are inspected.
Unknown calls, properties, indexing, subclasses and nested expressions fall back
to the original PyTorch error rather than guessing which operation failed.
"""

import ast
import math

import torch

MAX_RANK = 64
MAX_DIM = 2 ** 53 - 1
_TENSOR_TYPES = (torch.Tensor, torch.nn.Parameter)
_SHAPE = torch.Tensor.shape
_LAYOUT = torch.Tensor.layout
_STRIDE = torch.Tensor.stride
_BROADCAST_NAMES = {"add", "sub", "subtract", "mul", "multiply", "div", "divide",
                    "true_divide", "floor_divide", "remainder", "pow", "maximum", "minimum"}
_MATRIX_NAMES = {"matmul", "mm", "bmm"}
_FUNCTIONS = {name: getattr(torch, name) for name in _BROADCAST_NAMES | _MATRIX_NAMES | {"reshape"}}


def _tensor(node, namespace):
    if not isinstance(node, ast.Name) or len(node.id) > 256:
        return None
    value = namespace.get(node.id)
    # Do not call custom shape properties or __torch_function__ implementations.
    if type(value) not in _TENSOR_TYPES or _LAYOUT.__get__(value) != torch.strided:
        return None
    shape = list(_SHAPE.__get__(value))
    if len(shape) > MAX_RANK or any(type(size) is not int or not 0 <= size <= MAX_DIM for size in shape):
        return None
    return {"name": node.id, "shape": shape}


def _plain_value(node, namespace):
    if isinstance(node, ast.Constant) and type(node.value) is int:
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = _plain_value(node.operand, namespace)
        return -value if type(value) is int else None
    if isinstance(node, ast.Name):
        value = namespace.get(node.id)
        if type(value) is int:
            return value
        if type(value) in (tuple, list) and len(value) <= MAX_RANK and all(type(item) is int for item in value):
            return list(value)
    if isinstance(node, (ast.Tuple, ast.List)) and len(node.elts) <= MAX_RANK:
        values = [_plain_value(item, namespace) for item in node.elts]
        if all(type(value) is int for value in values):
            return values
    return None


def _shape(args, namespace):
    if len(args) == 1:
        value = _plain_value(args[0], namespace)
        values = [value] if type(value) is int else value
    else:
        values = [_plain_value(arg, namespace) for arg in args]
    if not isinstance(values, list) or len(values) > MAX_RANK:
        return None
    if any(type(value) is not int or not -MAX_DIM <= value <= MAX_DIM for value in values):
        return None
    return values


def _expression(statement):
    if isinstance(statement, ast.Assign) and all(isinstance(target, ast.Name) for target in statement.targets):
        return statement.value
    if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
        return statement.value
    if isinstance(statement, ast.Expr):
        return statement.value
    if isinstance(statement, ast.AugAssign) and isinstance(statement.target, ast.Name):
        return ast.BinOp(left=statement.target, op=statement.op, right=statement.value)
    return None


def _operation(expression, namespace):
    if isinstance(expression, ast.BinOp):
        if isinstance(expression.op, ast.MatMult):
            return "matmul", [expression.left, expression.right], None
        if isinstance(expression.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)):
            return "broadcast", [expression.left, expression.right], None
        return None
    if not isinstance(expression, ast.Call) or not isinstance(expression.func, ast.Attribute):
        return None
    owner, name = expression.func.value, expression.func.attr
    if not isinstance(owner, ast.Name):
        return None
    is_torch = namespace.get(owner.id) is torch
    if is_torch:
        # Looking in the module dictionary cannot invoke a user property. Refuse
        # monkeypatched functions, even if their name resembles a known operator.
        if name not in _FUNCTIONS or vars(torch).get(name) is not _FUNCTIONS[name]:
            return None
        operands = list(expression.args)
    else:
        operands = [owner, *expression.args]
    if name in {"reshape", "view"}:
        if not operands:
            return None
        shape_args = operands[1:]
        if expression.keywords:
            if shape_args or len(expression.keywords) != 1 or expression.keywords[0].arg != "shape":
                return None
            shape_args = [expression.keywords[0].value]
        if not shape_args:
            return None
        target = _shape(shape_args, namespace)
        return (name, operands[:1], target) if target is not None else None
    if expression.keywords or len(operands) != 2:
        return None
    if name in _MATRIX_NAMES:
        return name, operands, None
    if name in _BROADCAST_NAMES:
        return "broadcast", operands, None
    return None


def _broadcast_axes(left, right):
    axes = []
    for offset in range(1, min(len(left), len(right)) + 1):
        a, b = left[-offset], right[-offset]
        if a != b and a != 1 and b != 1:
            axes.extend([{"input": 0, "axis": len(left) - offset},
                         {"input": 1, "axis": len(right) - offset}])
    return axes


def _diagnose(operation, inputs, target, namespace, message):
    shapes = [item["shape"] for item in inputs]
    if operation == "broadcast":
        if "must match the size of tensor" not in message or "non-singleton dimension" not in message:
            return None
        axes = _broadcast_axes(*shapes)
        if not axes:
            return None
        return {"kind": "broadcast", "inputs": inputs, "axes": axes,
                "message": "从右侧对齐后，标出的维度长度不同，且都不是 1，无法进行广播。",
                "suggestions": ["核对各维度的含义，让对应长度相同。",
                                "只有需要复用同一组值时，才用 unsqueeze 插入长度为 1 的维度；不要为消除错误随意 reshape。"]}
    if operation in _MATRIX_NAMES:
        left, right = shapes
        if not left or not right:
            return None
        if operation == "mm" and (len(left) != 2 or len(right) != 2):
            return None
        if operation == "bmm" and (len(left) != 3 or len(right) != 3 or left[0] != right[0]):
            return None
        left_axis, right_axis = len(left) - 1, max(0, len(right) - 2)
        matrix_error = any(part in message for part in ("shapes cannot be multiplied", "size mismatch",
                            "inconsistent tensor size", "Expected size for first two dimensions"))
        if left[left_axis] == right[right_axis] or not matrix_error:
            return None
        if len(left) > 2 and len(right) > 2 and _broadcast_axes(left[:-2], right[:-2]):
            return None
        return {"kind": "matmul", "inputs": inputs,
                "axes": [{"input": 0, "axis": left_axis}, {"input": 1, "axis": right_axis}],
                "message": f"矩阵乘法需要左侧 dim {left_axis} 与右侧 dim {right_axis} 长度相同；当前是 {left[left_axis]} 和 {right[right_axis]}。",
                "suggestions": ["核对左侧特征数与右侧输入特征数。",
                                "如果矩阵的行列含义确实相反，可转置最后两个维度；逐元素相乘则应使用 *，并满足广播规则。"]}
    if operation not in {"reshape", "view"}:
        return None
    count = math.prod(shapes[0])
    base = {"kind": operation, "inputs": inputs, "axes": [], "target_shape": target}
    if "view size is not compatible" in message and operation == "view":
        value = namespace[inputs[0]["name"]]
        base.update(message=f"当前 stride 为 {list(_STRIDE(value))}，目标形状无法直接复用此布局。",
                    suggestions=["使用 reshape(...)，允许必要时复制数据。",
                                 "或先 contiguous() 再 view(...)；contiguous() 可能分配新存储。"])
        return base
    shape_error = any(part in message for part in ("is invalid for input of size", "only one dimension can be inferred",
                     "invalid shape dimension", "cannot reshape tensor of 0 elements"))
    if not shape_error:
        return None
    if any(size < -1 for size in target) or target.count(-1) > 1:
        base.update(message="目标形状只能使用非负维度，最多有一个 -1 用来推断长度。",
                    suggestions=[f"输入共 {count} 个元素；修正目标维度，并确保它们的乘积等于元素总数。"])
        return base
    known = math.prod(size for size in target if size != -1)
    if -1 in target:
        if known == 0 and count == 0:
            base.update(message="输入为空，目标同时含 0 和 -1，无法唯一确定 -1 对应的长度。",
                        suggestions=["为空 Tensor 显式指定每个维度，不使用 -1 推断。"])
        elif known == 0 or count % known:
            base.update(message=f"输入共 {count} 个元素，其余目标维度的乘积为 {known}，无法推断一个整数长度。",
                        suggestions=["检查已指定的维度，让其乘积能整除输入元素数。"])
        else:
            return None
    elif known != count:
        base.update(message=f"输入共 {count} 个元素，目标形状需要 {known} 个元素；reshape / view 不会增删元素。",
                    suggestions=[f"调整目标形状，使各维度乘积等于 {count}。",
                                 "已确定其他维度时，可用一个 -1 让 PyTorch 推断剩余长度。"])
    else:
        return None
    return base


def diagnose_shape(statement, namespace, error, line):
    """Return a diagnostic only for an unambiguous, direct failing operation."""
    if type(error) is not RuntimeError or statement is None:
        return None
    if len(error.args) != 1 or type(error.args[0]) is not str:
        return None
    if not statement.lineno <= line <= statement.end_lineno:
        return None
    expression = _expression(statement)
    operation = _operation(expression, namespace)
    if operation is None:
        return None
    name, operands, target = operation
    inputs = [_tensor(node, namespace) for node in operands]
    if any(item is None for item in inputs):
        return None
    return _diagnose(name, inputs, target, namespace, error.args[0])
