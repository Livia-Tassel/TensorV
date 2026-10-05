export const examples = [
  {
    id: 'transpose', title: '交换维度', op: 'transpose', description: '观察坐标变换与内存布局',
    code: `import torch\n\n# 用连续整数，追踪每一个元素\nx = torch.arange(24)\nx = x.reshape(2, 3, 4)\n\n# 交换 dim 1 与 dim 2\ny = x.transpose(1, 2)\n`,
  },
  {
    id: 'unfold', title: '滑动窗口', op: 'unfold', description: '一个元素，多个窗口',
    code: `import torch\n\n# 两组长度为 6 的序列\nx = torch.arange(12).reshape(2, 6)\n\n# 沿 dim 1，窗口长度 3，步长 1\ny = x.unfold(dimension=1, size=3, step=1)\n`,
  },
  {
    id: 'reshape', title: '重新分组', op: 'reshape / view', description: '理解连续性与数据复制',
    code: `import torch\n\nx = torch.arange(12).reshape(3, 4)\ny = x.transpose(0, 1)\n\n# 非连续的 y 在此 reshape 中发生复制\nz = y.reshape(2, 6)\n\n# 把上一行改成 y.view(2, 6)，看看会发生什么\n`,
  },
  {
    id: 'clamp', title: '截断数值', op: 'clamp', description: '形状不变，数值改变',
    code: `import torch\n\nx = torch.arange(-6, 6).reshape(3, 4)\n\n# 小于 -2 的变成 -2，大于 3 的变成 3\ny = x.clamp(min=-2, max=3)\n`,
  },
  {
    id: 'split', title: '拆分 Tensor', op: 'split / chunk', description: '沿着指定维度拆成多份',
    code: `import torch\n\nx = torch.arange(24).reshape(4, 6)\n\n# 沿列拆分，结果是三个 Tensor\nparts = x.split(2, dim=1)\n`,
  },
  {
    id: 'highdim', title: '探索高维', op: 'permute', description: '通过切片理解五维数据',
    code: `import torch\n\n# 五维 Tensor，任意选择两个维度展示\nx = torch.arange(240).reshape(2, 3, 2, 4, 5)\n\n# 把最后一个维度移到最前面\ny = x.permute(4, 0, 1, 2, 3)\n`,
  },
  {
    id: 'inplace', title: '共享与原地修改', op: 'clamp_', description: '历史快照与别名关系',
    code: `import torch\n\nx = torch.arange(12).reshape(3, 4)\ny = x.transpose(0, 1)\n\n# y 和 x 共享存储，修改 y 也会影响 x\ny.clamp_(max=6)\n`,
  },
];

export function explain(source, before, after) {
  if (/unfold\s*\(/.test(source)) return { title: '把一个维度展开成滑动窗口', text: '原维度变成窗口位置，最后新增窗口内的维度。窗口可能重叠：悬停一个元素，查看共享同一存储位置的格子。' };
  if (/transpose\s*\(|permute\s*\(/.test(source)) return { title: '维度换了位置，底层数据仍然共享', text: 'shape 和 stride 随维度一起交换。悬停格子，左右画布会标出同一存储位置；非连续布局也可以包含完整的数据。' };
  if (/split\s*\(|chunk\s*\(/.test(source)) return { title: '沿一个维度拆分成多个 Tensor', text: '在变量选择器里切换 parts[0]、parts[1] 等结果。拆分得到的视图共享原始存储，但具有不同的偏移量。' };
  if (/clamp_\s*\(/.test(source)) return { title: '原地修改会影响共享存储的变量', text: '历史画布保留修改前的数值。当前步骤中的其他共享视图也会看到修改后的值；数值变化用橙色边框标记。' };
  if (/clamp\s*\(/.test(source)) return { title: '形状不变，把数值限制在区间内', text: '比较相同坐标上的数值。橙色边框表示变化的元素；没有边框的元素仍然处于指定区间内。' };
  if (/reshape\s*\(|view\s*\(|flatten\s*\(/.test(source)) {
    const shared = before && after && before.storage === after.storage;
    return { title: shared ? '重新分组，仍然共享底层存储' : '按照逻辑顺序重新分组', text: shared ? 'shape 改变了，元素总数保持不变。存储编号相同，说明这次变换产生了一个视图。' : '查看存储编号来判断是否复制。reshape 必要时可以复制；view 要求新形状与原来的 stride 兼容。' };
  }
  return { title: '从真实 PyTorch 结果理解 Tensor', text: '每个维度都有独立颜色。选择行、列维度，再调整其余维度的索引，即可浏览高维 Tensor 的二维切片。' };
}
