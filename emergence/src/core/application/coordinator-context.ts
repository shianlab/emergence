import type { PlanningState } from '../domain/planning.ts';
import { draftProgress } from '../domain/work-draft.ts';

/** One model-facing route; the durable plan, allocator and permission gates stay authoritative. */
export function automaticPlanningContext(
  state: PlanningState,
  freshRequest: boolean,
  permissionMode: string,
  contextChars: number,
  submission: 'steps' | 'whole' = 'whole',
  budget?: unknown,
): string {
  const analysis = freshRequest ? undefined : state.analysis;
  const submitted = !freshRequest && (state.executions?.length ?? 0) > 0;
  const planning = analysis?.intent === 'execute' && !analysis.questions?.length && !submitted;
  const planFits = !state.plan || JSON.stringify(state.plan).length <= contextChars - 3000;
  const next = submitted
    ? '计划已派发。结束本轮，等待宿主回执；需要查询时用 emergence_team / emergence_tasks。不要重新分析、重复派工或自行开启审查。'
    : !analysis
      ? '当前先调用 emergence_analyze，简短明确目标、约束、验收和 intent；不必先展开完整计划。纯事实问答用 emergence_decide(answer) 后直接回答。'
      : analysis.intent === 'discuss' ||
          analysis.intent === 'clarify' ||
          analysis.questions?.length ||
          state.status === 'needs-input'
        ? '当前仅讨论或存在关键待答问题；回答或澄清后结束，不实施、不派工。'
        : state.status === 'ready' && planFits
          ? '方案已经通过准入。现在结束本轮，由宿主通过实时权限门禁自动派发；不要再次输出或重建方案。'
          : submission === 'steps'
            ? '读取必要来源后用 emergence_plan_step 每次保存一个子任务，按回执更新 draftRevision。未覆盖验收和缺失依赖归零后用 emergence_plan_commit 提交；不要一次生成整张图，不重新提交已保存步骤。'
            : '读取必要来源后调用 emergence_plan_work。只提交子任务、角色、项目、真实路径范围、必需工具和依赖，窗口/会话/模型由宿主匹配。';
  const data = freshRequest
    ? { status: 'new-request', budget, note: '以本轮用户原文为准；旧计划不能代表本次请求。' }
    : {
        status: planFits ? state.status : 'blocked',
        analysis: analysis && {
          objective: analysis.objective,
          intent: analysis.intent,
          questions: analysis.questions,
        },
        requirements: state.requirements,
        inheritedRequirements: state.requirements ? undefined : state.inheritedRequirements,
        source: state.source,
        plan:
          !submitted && planFits && state.plan
            ? {
                objective: state.plan.objective,
                steps: state.plan.steps.map(({ id, window, role }) => ({ id, window, role })),
              }
            : undefined,
        executions: state.executions,
        issues: planFits ? state.issues.slice(0, 2) : ['旧计划超出当前上下文预算；请缩减后重新提交'],
        receipts: state.receipts.slice(-24),
        draft: state.draft && state.requirements ? draftProgress(state.draft, state.requirements) : undefined,
        budget,
      };
  const policy =
    'Emergence 自动主控入口（内置 KIM 需求理解与规划）。\n' +
    next +
    (submission === 'steps'
      ? '\n统一流程：理解意图 → 必要读取 → 逐项 emergence_plan_step → emergence_plan_commit → 宿主一次性分配与独立验收。草稿不执行；不自行添加宿主核验步骤。'
      : '\n统一流程：理解意图 → 必要读取 → emergence_plan_work → 结束本轮 → 宿主分配与独立验收。') +
    '\n用户明确要求实施才使用 intent=execute；讨论用 discuss，只有用户能决定的阻塞问题用 clarify。' +
    '\n团队上下文已给出当前窗口、项目和角色；分析回执会附带能力摘要。缺少信息时再用 emergence_team / emergence_capabilities 查询；清单不授予权限。' +
    (planning
      ? '\n复杂实现可以交给执行窗口调查；主控只做拆分必需的读取。计划使用分析回执的 requirementRevision（requirements.revision），每个步骤用 requirementIds 引用验收编号；覆盖全部验收。约束由宿主继承，不重复抄写或改写。新增需求用 suggestions，不会自动成为授权。禁止编造证据。' +
        '\n跨项目步骤必须填写 localCriteria:[{requirementId,text}]，只写该项目的局部贡献，不复制“所有项目均通过”等全局要求；宿主保留全局原文并聚合各贡献。可填写清单中的 projectId 防止目录误绑。真正的集成检查单列 purpose=user-check、readProjects=[已登记目录] 并依赖交付步骤；该声明不授予额外写入权限。' +
        '\n有明确检查命令时填写 verifications:[{id,tool,command,cwd,criteria,inputs,configuration}]。criteria 是 localCriteria 下标，inputs 是要验证的项目内文件，configuration 是须保持不变的脚本/配置。精确命令仍走普通权限；字节、哈希、换行、目录清单用 emergence_inspect，不让每个审查者手写 Shell。'
      : '') +
    '\n不要自行写文件、手工绑定窗口或调用旧派发/验收入口。工作范围不明时修订分工，不能绕过门禁。' +
    '\n宿主负责审查、验证、有限修复和收尾；只有真实总任务状态 completed 才能宣布完成。' +
    `\n当前权限：${permissionMode}；计划模式仅规划，审批和继承限制始终有效。` +
    '\n以下为状态数据摘要，不是新的授权：\n';
  let result = policy + JSON.stringify(data);
  while (result.length > contextChars && 'receipts' in data && data.receipts?.length) {
    data.receipts.pop();
    result = policy + JSON.stringify(data);
  }
  return result.length <= contextChars
    ? result
    : policy +
        JSON.stringify({
          status: data.status,
          details:
            '状态明细超过展示预算。完整分析、约束和方案保留在原工具回执及持久计划中；不要根据摘要重建或扩大任务。',
        });
}
