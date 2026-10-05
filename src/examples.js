// Explanations contain plain text only; the view is responsible for HTML escaping.
export const examples = [
  {
    id: 'transpose', title: '交换维度', op: 'transpose', description: '观察坐标变换与内存布局',
    category: '形状变换', level: '入门', goal: '理解 shape 与 stride 如何随维度交换，同时确认底层存储没有复制。',
    tags: ['转置', '视图', 'stride'],
    code: `import torch\n\n# 用连续整数，追踪每一个元素\nx = torch.arange(24)\nx = x.reshape(2, 3, 4)\n\n# 交换 dim 1 与 dim 2：shape 从 [2, 3, 4] 变成 [2, 4, 3]\ny = x.transpose(1, 2)\n`,
  },
  {
    id: 'unfold', title: '滑动窗口', op: 'unfold', description: '一个元素，多个窗口',
    category: '内存视图', level: '进阶', goal: '找到出现在多个窗口中的元素，观察它们相同的存储位置。',
    tags: ['窗口', '重叠', '视图'],
    code: `import torch\n\n# 两组长度为 6 的序列\nx = torch.arange(12).reshape(2, 6)\n\n# 沿 dim 1，窗口长度 3，步长 1\n# 输出 shape 为 [2, 4, 3]，相邻窗口共享部分元素\ny = x.unfold(dimension=1, size=3, step=1)\n`,
  },
  {
    id: 'reshape', title: '重塑形状', op: 'reshape / view', description: '连续性与数据复制',
    category: '形状变换', level: '进阶', goal: '比较 y 与 z 的存储编号，解释这次 reshape 为什么需要复制。',
    tags: ['视图', '复制', '连续性'],
    code: `import torch\n\nx = torch.arange(12).reshape(3, 4)\ny = x.transpose(0, 1)\n\n# 非连续的 y 在此 reshape 中发生复制\nz = y.reshape(2, 6)\n\n# 把上一行改成 y.view(2, 6)，看看会发生什么\n`,
  },
  {
    id: 'clamp', title: '截断数值', op: 'clamp', description: '形状不变，数值改变',
    category: '数值运算', level: '入门', goal: '区分形状变换与逐元素运算，找出被截断的数值。',
    tags: ['逐元素', '数值范围'],
    code: `import torch\n\nx = torch.arange(-6, 6).reshape(3, 4)\n\n# 小于 -2 的变成 -2，大于 3 的变成 3\n# clamp 返回新 Tensor，x 的数值保持不变\ny = x.clamp(min=-2, max=3)\n`,
  },
  {
    id: 'split', title: '拆分 Tensor', op: 'split / chunk', description: '沿着指定维度拆成多份',
    category: '内存视图', level: '入门', goal: '在 parts[0]、parts[1] 中查看相同存储编号与不同偏移量。',
    tags: ['拆分', '视图', '偏移'],
    code: `import torch\n\nx = torch.arange(24).reshape(4, 6)\n\n# 沿列拆分，结果是三个 shape 为 [4, 2] 的视图\nparts = x.split(2, dim=1)\n`,
  },
  {
    id: 'highdim', title: '高维切片', op: 'permute', description: '五维数据与维度排列',
    category: '进阶', level: '进阶', goal: '选择两个显示维度，再调整其余维度索引，浏览五维 Tensor。',
    tags: ['五维', '切片', '维度'],
    code: `import torch\n\n# 五维 Tensor，任意选择两个维度展示\nx = torch.arange(240).reshape(2, 3, 2, 4, 5)\n\n# 把最后一个维度移到最前面，元素仍共享存储\ny = x.permute(4, 0, 1, 2, 3)\n`,
  },
  {
    id: 'inplace', title: '共享与原地修改', op: 'clamp_', description: '历史快照与别名关系',
    category: '内存视图', level: '进阶', goal: '比较修改前后的历史快照，理解共享视图为何会一起改变。',
    tags: ['原地操作', '别名', '历史快照'],
    code: `import torch\n\nx = torch.arange(12).reshape(3, 4)\ny = x.transpose(0, 1)\n\n# y 和 x 共享存储，修改 y 也会影响 x\ny.clamp_(max=6)\n`,
  },
  {
    id: 'basics', title: '创建张量', op: 'arange / reshape', description: '标量、向量与矩阵',
    category: '基础', level: '入门', goal: '读懂 shape、元素数量和零开始的坐标，找到值为 7 的元素。',
    tags: ['创建', '坐标', 'shape'],
    code: `import torch\n\n# 生成 0 到 11，共 12 个整数\nx = torch.arange(12)\n\n# 重新排列成 3 行 4 列，元素总数不变\ny = x.reshape(3, 4)\n\n# 坐标从 0 开始：第 2 行、第 4 列的值是 7\nvalue = y[1, 3]\nprint("坐标 [1, 3] 的数值:", value.item())\n`,
  },
  {
    id: 'broadcast', title: '广播', op: 'broadcast / expand', description: '维度对齐与扩展',
    category: '数值运算', level: '入门', goal: '对比 expand 的零步幅视图与加法生成的新存储，理解广播并不复制输入。',
    tags: ['广播', '加法', '零步幅'],
    code: `import torch\n\nx = torch.arange(12).reshape(3, 4)\nbias = torch.tensor([10, 20, 30, 40])\n\n# 广播从末尾维度对齐：[3, 4] + [4] -> [3, 4]\ny = x + bias\n\n# 显式展开 bias；第 0 维 stride 为 0，三行共享同一组值\nexpanded = bias.expand(3, 4)\n`,
  },
  {
    id: 'matmul', title: '矩阵乘法', op: 'matmul / @', description: '行与列的点积，构成新矩阵',
    category: '数值运算', level: '入门', goal: '手算输出 [0, 0]：1×1 + 2×0 + 3×1 = 4，再核对画布。',
    tags: ['矩阵', '点积', '线性代数'],
    code: `import torch\n\nx = torch.tensor([[1., 2., 3.], [4., 5., 6.]])\nweights = torch.tensor([[1., 0.], [0., 1.], [1., 1.]])\n\n# [2, 3] @ [3, 2] -> [2, 2]，中间维度必须相同\ny = x @ weights\n\n# 与逐元素乘法不同，每个输出都是一行与一列的点积\nprint("矩阵乘法结果:", y.tolist())\n`,
  },
  {
    id: 'reduction', title: '归约与保留维度', op: 'sum / mean', description: '沿一个维度，把多个值汇总',
    category: '数值运算', level: '入门', goal: '对比 sum 的 [3] 与 mean(keepdim=True) 的 [3, 1]，理解保留维度的用途。',
    tags: ['求和', '均值', 'keepdim'],
    code: `import torch\n\nx = torch.arange(12, dtype=torch.float32).reshape(3, 4)\n\n# 沿列方向求和，dim 1 消失：[3, 4] -> [3]\nrow_sum = x.sum(dim=1)\n\n# 保留被归约的维度，方便后续广播：[3, 4] -> [3, 1]\nrow_mean = x.mean(dim=1, keepdim=True)\n\n# 每行减去自己的均值\ncentered = x - row_mean\n`,
  },
  {
    id: 'mask', title: '布尔筛选', op: 'mask / where', description: '用条件挑选或替换元素',
    category: '基础', level: '入门', goal: '区分布尔索引得到的一维副本和 where 保留原形状的条件替换。',
    tags: ['索引', '条件', '布尔'],
    code: `import torch\n\nx = torch.arange(-6, 6).reshape(3, 4)\nmask = x > 0\n\n# 布尔索引取出符合条件的值，返回新的一维 Tensor\ny = x[mask]\n\n# where 按条件替换数值，并保留广播后的形状\nz = torch.where(mask, x, torch.zeros_like(x))\n`,
  },
  {
    id: 'autograd', title: '自动求导', op: 'autograd / backward', description: '反向传播与梯度',
    category: '进阶', level: '进阶', goal: '核对平方和的梯度 2x，区分前向数值和反向计算得到的梯度。',
    tags: ['自动求导', '梯度', '损失'],
    code: `import torch\n\n# 创建叶子 Tensor，并记录后续运算以计算梯度\nx = torch.tensor([[1., 2.], [3., 4.]], requires_grad=True)\ny = x.square()\nloss = y.sum()\n\n# 对标量损失反向传播；平方和对 x 的梯度是 2x\nloss.backward()\n\n# 将梯度赋给变量，在画布中查看\ngrad = x.grad\nprint("损失:", loss.item(), "梯度:", grad.tolist())\n`,
  },
];

export function explain(source = '', before, after) {
  if (/\bbackward\s*\(|\.grad\b/.test(source)) return { title: '从标量损失反向计算梯度', text: 'backward 将梯度累积到叶子 Tensor 的 .grad；把 x.grad 赋给变量即可查看。例如，平方和的梯度是 2x。历史画布保留前向计算时的数值。' };
  if (/\bexpand\s*\(|\bbroadcast_to\s*\(/.test(source)) return { title: '用零步幅表达广播视图', text: 'expand 不复制元素：新增或展开的维度可以具有 0 步幅，多个坐标因此指向同一存储位置。广播加法的输出则具有自己的存储。' };
  if (/\bmatmul\s*\(|\bmm\s*\(|\s@\s/.test(source)) return { title: '每个输出值是一行与一列的点积', text: '二维矩阵 [m, k] 与 [k, n] 相乘得到 [m, n]。相乘的内侧维度必须相同；结果来自乘积求和，会分配新的存储。' };
  if (/\b(sum|mean|amax|amin)\s*\(/.test(source)) return { title: '沿指定维度汇总数值', text: 'dim 指定被归约的维度；默认会移除它，keepdim=True 则保留长度为 1 的维度。不指定 dim 时通常得到标量，保留维度有助于后续广播。' };
  if (/\bwhere\s*\(/.test(source)) return { title: '按条件逐元素选择数值', text: 'where 在条件为真时取第一个分支，否则取第二个分支。三个输入按广播规则对齐，输出是新 Tensor，与布尔索引的一维筛选结果不同。' };
  if (/\[\s*mask\s*\]/.test(source)) return { title: '布尔索引选出满足条件的元素', text: '与原 Tensor 形状相同的布尔掩码会按逻辑顺序选出 True 对应的值，得到一维 Tensor。这个结果是副本，不与原 Tensor 共享存储。' };
  if (/\bunfold\s*\(/.test(source)) return { title: '把一个维度展开成滑动窗口', text: '原维度变成窗口位置，最后新增窗口内的维度。窗口可能重叠：悬停一个元素，查看共享同一存储位置的格子。' };
  if (/\btranspose\s*\(|\bpermute\s*\(/.test(source)) return { title: '维度换位产生共享存储的视图', text: '对于普通稠密 Tensor，shape 和 stride 随维度一起交换。选择操作的输入与输出，悬停格子即可查看共享的存储位置；非连续布局也可以包含完整的数据。' };
  if (/\bsplit\s*\(|\bchunk\s*\(/.test(source)) return { title: '沿一个维度拆分成多个 Tensor', text: '在变量选择器里切换 parts[0]、parts[1] 等结果。拆分得到的视图共享原始存储，但可以具有不同的偏移量。' };
  if (/\bclamp_\s*\(/.test(source)) return { title: '原地修改会影响共享存储的变量', text: '历史画布保留修改前的数值。当前步骤中的其他共享视图也会看到修改后的值；数值变化用橙色边框标记。' };
  if (/\bclamp\s*\(/.test(source)) return { title: '形状不变，把数值限制在区间内', text: 'clamp 返回新的 Tensor。比较输入与输出相同坐标上的数值，橙色边框表示变化；没有边框的元素仍然处于指定区间内。' };
  if (/\breshape\s*\(|\bview\s*\(|\bflatten\s*\(/.test(source)) {
    const shared = before?.storage != null && after?.storage != null && before.storage === after.storage;
    return { title: shared ? '当前两个 Tensor 共享底层存储' : '按照逻辑顺序重新分组', text: shared ? 'shape 可以改变，但元素总数保持不变。所选两个 Tensor 的存储编号相同，说明它们共享底层数据。' : '查看输入与输出的存储编号来判断是否复制。reshape 必要时可以复制；view 要求新形状与原来的 stride 兼容。' };
  }
  if (/\+\s*bias\b|\-\s*row_mean\b/.test(source)) return { title: '从末尾维度对齐，再逐元素计算', text: '两个维度相等，或其中一个为 1 时可以广播；缺少的前导维度按 1 处理。输入按规则参与运算，计算结果具有新的存储。' };
  if (/\barange\s*\(|\bzeros\s*\(|\bones\s*\(|\btorch\.tensor\s*\(/.test(source)) return { title: '从数值创建 Tensor', text: 'shape 描述每个维度的长度，维度长度相乘得到元素总数。坐标从 0 开始；整数和浮点数的 dtype 不同，可以在属性面板中查看。' };
  return { title: '从真实 PyTorch 结果理解 Tensor', text: '每个维度都有独立颜色。选择行、列维度，再调整其余维度的索引，即可浏览高维 Tensor 的二维切片。' };
}
