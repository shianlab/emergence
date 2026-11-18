import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const escape = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const scalar = (value: unknown) =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
const labels: Record<string, string> = {
  clean: '数据清理',
  metric: '指标计算',
  reconcile: '关联对账',
  retention: '注册留存',
  funnel: '事件漏斗',
  attribution: '变化贡献',
  ab: '二元 A/B 实验',
  series: '日序列分析',
  segment: '分组',
  before: '前期',
  after: '后期',
  contribution: '变化贡献',
  totalChange: '总体变化',
  excludedRows: '排除行数',
  includedRows: '纳入行数',
  mode: '计算方式',
  sum: '求和',
  ratio: '比率',
  weighted_mean: '加权均值',
  rows: '行数',
  numerator: '分子',
  denominator: '分母',
  value: '结果值',
  key: '关联键',
  leftRows: '左侧行数',
  rightRows: '右侧行数',
  innerJoinRows: '关联后行数',
  expectedInnerJoinRows: '预计关联后行数',
  manyToMany: '多对多',
  leftTotal: '左侧合计',
  rightTotal: '右侧合计',
  difference: '差值',
  cohort: '注册日期',
  period: '观察期',
  population: '注册人数',
  mature: '观察期完整',
  active: '活跃人数',
  rate: '比率',
  step: '步骤',
  users: '人数',
  conversionFromEntry: '入口转化率',
  pendingWindowUsers: '观察窗口未结束人数',
  usersWithoutEntry: '无入口事件人数',
  ordering: '事件顺序规则',
  group: '组别',
  units: '随机化单位数',
  conversions: '转化数',
  ciLow: '区间下界',
  ciHigh: '区间上界',
  srmP: '分流比例检验 P 值',
  srmFlag: '分流异常',
  pValue: '原始 P 值',
  adjustedP: '校正 P 值',
  alpha: '显著性阈值',
  comparisons: '比较次数',
  differenceCI: '差值保守区间',
  relativeLift: '相对提升',
  significant: '通过显著性与分流检查',
  date: '日期',
  actual: '实际值',
  prediction: '基线预测',
  split: '数据划分',
  train: '训练期',
  holdout: '留出期',
  anomaly: '异常标记',
  trainingRows: '训练天数',
  holdoutRows: '留出天数',
  season: '固定周期（天）',
  mae: '平均绝对误差',
  wape: '加权绝对百分比误差',
  trendPerDay: '每日线性趋势',
  baseline: '预测基线',
  missingDates: '缺失日期',
  evaluation: '预测评估',
  beforeRows: '清理前行数',
  afterRows: '清理后行数',
  changedRows: '修剪行数',
  removedDuplicates: '移除重复行数',
  outliers: '异常值标记',
};
const label = (key: string) => labels[key] ?? key;
const display = (value: unknown) =>
  value === null || value === undefined
    ? '未计算 / 不适用'
    : typeof value === 'boolean'
      ? value
        ? '是'
        : '否'
      : scalar(value);
const csvCell = (value: unknown) => {
  let text = scalar(value);
  if (/^[\s]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export async function deliverAnalysis(
  directory: string,
  worker: string,
  _request: Record<string, unknown>,
  result: any,
  definition: unknown,
) {
  const analysis = result.analysis;
  if (!analysis) return [];
  const rows = analysis.table as Record<string, unknown>[],
    columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = [
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(',')),
  ].join('\r\n');
  const preferred = ['value', 'contribution', 'rate', 'users', 'actual', 'leftTotal'];
  const numeric =
    preferred.find((c) => columns.includes(c)) ??
    columns.find((c) => rows.some((r) => r[c] !== null && r[c] !== '' && Number.isFinite(Number(r[c]))));
  const points = numeric
    ? rows.slice(0, 40).flatMap((row, i) =>
        row[numeric] !== null && row[numeric] !== '' && Number.isFinite(Number(row[numeric]))
          ? [
              {
                label: scalar(row[columns.find((c) => c !== numeric) ?? numeric]).slice(0, 30),
                value: Number(row[numeric]),
                exact: scalar(row[numeric]),
                index: i,
              },
            ]
          : [],
      )
    : [];
  const scale = Math.max(1, ...points.map((p) => Math.abs(p.value)));
  const height = Math.max(110, points.length * 28 + 65);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><rect width="900" height="${height}" fill="#fff"/><g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="13" fill="#222"><text x="20" y="24">${escape(numeric ? label(numeric) : '无可绘制数值')}（最多展示40行；精确值见结果表）</text>${points
    .map((p, i) => {
      const y = i * 28 + 45,
        w = (Math.abs(p.value) / scale) * 250;
      return `<text x="15" y="${y + 13}">${escape(p.label)}</text><rect x="${p.value < 0 ? 480 - w : 480}" y="${y}" width="${w}" height="18" fill="#777"/><text x="760" y="${y + 13}">${escape(p.exact)}</text>`;
    })
    .join('')}</g><line x1="480" x2="480" y1="35" y2="${height - 10}" stroke="#bbb"/></svg>`;
  const warnings = [...result.warnings, ...analysis.warnings];
  const quality = [
    `输入 ${result.rows} 行；重复行 ${result.duplicateRows}；在预算内完整扫描，未以抽样代替全量。`,
    '空值与仅含空白的文本分别统计；没有自动填零、删除或去重。清理操作以显式方法参数为准。',
    ...result.columns.map(
      (column: { name: string; missing: number; blankText?: number; distinct: number }) =>
        `${column.name}：空值 ${column.missing}，空白文本 ${column.blankText ?? '未统计'}，非空不同值 ${column.distinct}`,
    ),
  ].join('\n');
  const findings = JSON.stringify({ summary: analysis.summary, checks: analysis.checks, warnings }, null, 2);
  const record = definition as { status?: string; definition?: Record<string, unknown> };
  const metadata = record.definition ?? {};
  const status =
    record.status === 'user-confirmed'
      ? '已保存用户确认口径'
      : record.status === 'auto-approved'
        ? '口径由狂暴模式自动批准，请核对假设'
        : '本次口径尚未保存确认，请核对假设';
  const summary = Object.entries(analysis.summary)
    .map(([k, v]) => `<li><b>${escape(label(k))}</b>：${escape(display(v))}</li>`)
    .join('');
  const checks = analysis.checks.map(
    (c: { name: string; passed: boolean }) => `${c.passed ? '通过' : '未通过'} · ${c.name}`,
  );
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'"><title>涌现数据分析报告</title><style>body{font:16px/1.6 'Microsoft YaHei',sans-serif;color:#222;background:#fff;max-width:1000px;margin:24px auto;padding:24px}h1{font-size:28px}h2{font-size:20px;margin-top:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f3f3;padding:16px}.meta{color:#666}.summary{background:#f3f3f3;padding:16px 36px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}th{background:#f5f5f5}svg{max-width:100%;height:auto}details{margin-top:24px}</style><h1>涌现 · ${escape(label(analysis.method))}</h1><p class="meta">输入 ${analysis.inputRows} 行 · 结果 ${rows.length} 行 · ${escape(status)}</p><p>来源：${escape(metadata.source)}　单位：${escape(metadata.unit)}<br>粒度：${escape(metadata.grain)}　时区：${escape(metadata.timezone)}</p><ul class="summary">${summary || '<li>结果见下表。</li>'}</ul><p>${escape(checks.join('；') || '本方法未提供额外恒等式校验；请结合输入前提审阅。')}</p>${warnings.map((w: string) => `<p class="meta">${escape(w)}</p>`).join('')}<h2>输入质量与范围</h2><pre>${escape(quality)}</pre><h2>变化与结果</h2>${svg}<table><thead><tr>${columns.map((c) => `<th>${escape(label(c))}</th>`).join('')}</tr></thead><tbody>${rows
    .slice(0, 1000)
    .map((row) => `<tr>${columns.map((c) => `<td>${escape(display(row[c]))}</td>`).join('')}</tr>`)
    .join(
      '',
    )}</tbody></table><p class="meta">图表最多展示40行，表格最多1000行；完整结果见 table.csv / result.json。空值不等于零。</p><details><summary>查看完整口径、参数与计算记录</summary><pre>${escape(JSON.stringify(definition, null, 2))}</pre><pre>${escape(findings)}</pre></details><h2>重新计算</h2><p>在安装本目录 requirements.txt 的 Python 环境运行 replay.py，即可核对输入快照并重新计算，生成新结果而不覆盖本次产物。CSV 对可能的公式文本增加单引号，JSON 保留原值。</p></html>`;
  const replay = `import json, pathlib, subprocess, sys, uuid, hashlib\np=pathlib.Path(__file__).resolve().parent\nr=json.loads((p/'request.json').read_text(encoding='utf-8'))\nm=json.loads((p/'manifest.json').read_text(encoding='utf-8'))\nif hashlib.sha256((p/'request.json').read_bytes()).hexdigest()!=m['requestHash']: raise RuntimeError('Request hash mismatch')\nif hashlib.sha256((p/r['snapshot']).read_bytes()).hexdigest()!=m['sourceHash']: raise RuntimeError('Input hash mismatch')\nfor f in m['artifacts']:\n if hashlib.sha256((p/f['name']).read_bytes()).hexdigest()!=f['hash']: raise RuntimeError('Artifact hash mismatch: '+f['name'])\nr['input']=str(p/r['snapshot'])\nchild=subprocess.run([sys.executable,'-I','-B','-X','utf8',str(p/'worker.py')],input=json.dumps(r),capture_output=True,text=True,encoding='utf-8',cwd=p,timeout=35)\nif child.returncode: raise RuntimeError(child.stdout or child.stderr)\nresult=json.loads(child.stdout)\nexpected=json.loads((p/'result.json').read_text(encoding='utf-8'))\nif result['result'].get('analysis') != expected.get('analysis'): raise RuntimeError('Replay mismatch: analysis changed')\ntarget=p/('replay-'+str(uuid.uuid4())+'.json')\ntarget.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')\nprint(str(target))\n`;
  const files: Record<string, string> = {
    'table.csv': '\uFEFF' + csv,
    'chart.svg': svg,
    'report.html': html,
    'report.md': `# 涌现数据分析\n\n方法：${analysis.method}\n\n## 输入质量与范围\n\n${quality
      .split('\n')
      .map((line) => '    ' + line)
      .join(
        '\n',
      )}\n\n\`\`\`json\n${findings}\n\`\`\`\n\n口径：\n\`\`\`json\n${JSON.stringify(definition, null, 2)}\n\`\`\`\n`,
    'definition.json': JSON.stringify(definition, null, 2),
    'replay.py': replay,
    'worker.py': await readFile(worker, 'utf8'),
    'analytics.py': await readFile(join(dirname(worker), 'analytics.py'), 'utf8'),
    'requirements.txt': await readFile(join(dirname(worker), 'requirements.txt'), 'utf8'),
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content, { flag: 'wx', mode: 0o600 });
  return Object.entries(files).map(([name, content]) => ({ name, hash: hash(content) }));
}
