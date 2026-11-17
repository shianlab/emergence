export const analysisMethods = {
  clean: {
    purpose: '显式文本清理与整行去重；保留异常/缺失',
    params: { trim: ['列名'], deduplicate: false, outlier_columns: [] },
  },
  metric: {
    purpose: 'Decimal 与 SQL 双路复算；加总、分子/分母比率、加权均值',
    params: { value: '金额', mode: 'sum', group_by: [], filters: {}, unique_key: 'ID' },
    optional: 'ratio 需 denominator；weighted_mean 需 weight；空值必须先明确处理，不能偷偷填零',
  },
  reconcile: {
    purpose: '真实键频率的关联膨胀和两侧金额对账',
    params: { side: '来源', key: 'ID', value: '金额' },
    input: '同一输入表中来源值为 left/right，其他来源或缺失键拒绝',
  },
  retention: {
    purpose: '完整注册人口留存；未成熟期为空',
    params: {
      user: 'ID',
      signup: '注册日期',
      activity: '活动日期',
      as_of: '2026-10-31',
      period_days: 1,
      periods: 7,
    },
    input: '每个注册用户至少一行，未活跃用户活动日期为空；ISO日期，as_of 指已完整观察的最后一天',
  },
  funnel: {
    purpose: '严格事件顺序与完成窗口；区分观察未完成用户',
    params: {
      user: 'ID',
      event: '事件',
      time: '时间',
      steps: ['访问', '购买'],
      window_seconds: 86400,
      as_of: '2026-10-31T00:00:00Z',
    },
    input: '事件时间含时区；同一时刻不视为有先后顺序，以首次入口事件为起点',
  },
  attribution: {
    purpose: '可加总指标的组成变化对账，不推断因果',
    params: { dimension: '渠道', period: '时期', value: '收入', before: '前期', after: '后期' },
    input: '不支持直接加总百分比或转化率，请先核对分子分母',
  },
  ab: {
    purpose: '二元结果、Fisher精确检验、SRM、区间、多重比较',
    params: {
      user: '用户ID',
      group: '实验组',
      outcome: '转化',
      control: 'A',
      treatment: 'B',
      alpha: 0.05,
      expected_control: 0.5,
      comparisons: 1,
    },
    input: '每个随机化单位只一行，结果仅0/1；两组、非缺失；独立随机分配是外部前提',
  },
  series: {
    purpose: '日粒度缺期标记、训练期趋势/异常、固定季节朴素基线的时间留出验证',
    params: { date: '日期', value: '销量', holdout: 2, season: 1 },
    input: '每天一个数值，ISO日期；缺期不擅自填零，训练至少3期且不短于season',
  },
} as const;
export type AnalysisMethod = keyof typeof analysisMethods;
export const dataGuidance =
  '数据分析方法已内嵌。原生 profile/query/analyze 只读项目输入，固定计算与报告写在宿主隔离目录，因此计划模式也可运行；这不授权任意脚本或项目写入。用户指定具体数据文件时，先用 emergence_data_profile 或 read 检查列名和取值，再提交 emergence_analyze 的语义理解；不能把文件中可读取的时期标签、字段或样本当成必须用户决定的问题。只有读取后仍无法确定且影响结论的业务选择才列入阻塞 questions。方法选择先用 emergence_data_methods 获取对应方法参数与前提，再主动 emergence_data_analyze；不加载 Skill。params_json 只传参数，不能传代码。先明确粒度、指标分子分母、过滤、时区/单位和来源；不确定但不阻塞的口径在 definition_json 中标记假设。影响结论的关键未知先问用户。已有确认口径用 emergence_data_definition 读取，通过 definition_name 引用；仅在用户需要保存/变更口径时请求确认，不为每次分析重复审批。结果表、灰阶图表、中文离线报告及重放包自动生成。留存须提供完整注册人口；A/B 必须按随机化单位去重；加总归因不适用于转化率。在当前会话按任务依赖安排准备、分析和核对，保留源文件、method、params、definition版本与artifact；用相同输入和口径核对实际结果，不把模型的文字当证据。';
