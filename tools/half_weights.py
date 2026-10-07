"""Store the big float32 weights of an ONNX model as float16 (half the file).

    python3 half_weights.py in.onnx out.onnx

Only the STORAGE changes: every converted tensor gets a Cast back to float32
in front of it, and ONNX Runtime folds those casts away when the model is
loaded, so the model still computes in float32 and runs at the same speed.
Small tensors and anything that does not survive the round trip are left alone.
"""
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

MIN_ELEMENTS = 64          # not worth a Cast node below this
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
graph_inputs = {i.name for i in g.input}
converted, kept, worst = 0, 0, 0.0
casts = []
for init in list(g.initializer):
    if init.data_type != TensorProto.FLOAT or init.name in graph_inputs:
        continue
    a = numpy_helper.to_array(init)
    if a.size < MIN_ELEMENTS:
        kept += 1
        continue
    h = a.astype(np.float16)
    back = h.astype(np.float32)
    # Leave a tensor alone if half precision cannot hold it.
    if not np.all(np.isfinite(back)):
        kept += 1
        continue
    tiny = (a != 0) & (back == 0)
    if tiny.any() and np.abs(a[tiny]).max() > 1e-6:
        kept += 1
        continue
    scale = max(float(np.abs(a).max()), 1e-12)
    worst = max(worst, float(np.abs(back - a).max()) / scale)
    name = init.name
    half = numpy_helper.from_array(h, name + '__f16')
    g.initializer.remove(init)
    g.initializer.append(half)
    casts.append(helper.make_node('Cast', [name + '__f16'], [name], to=TensorProto.FLOAT, name='restore_' + name))
    converted += 1
# Casts first: ONNX wants every tensor produced before it is used.
nodes = list(g.node)
del g.node[:]
g.node.extend(casts + nodes)
onnx.checker.check_model(m)
onnx.save(m, dst)
print(f'{src.split("/")[-1]}: {converted} tensors stored as float16, {kept} left as they were, '
      f'worst rounding error {worst:.2e} of the tensor range')
