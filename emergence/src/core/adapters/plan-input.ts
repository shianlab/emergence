import { planSchema } from '../domain/planning.ts';
import { planProposalSchema, materializeProposal } from '../domain/plan-proposal.ts';
import { RequirementError, requirementTexts, type Requirements } from '../domain/requirements.ts';
import { parseProtocol, protocolError } from './tool-protocol.ts';

/** Compatibility is input conversion only; both protocols use the same requirement admission. */
export function readPlanInput(
  json: string,
  current: Requirements | undefined,
  establish: (legacy: {
    objective: string;
    constraints: string[];
    acceptance: string[];
    nonGoals: string[];
  }) => Requirements,
) {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw protocolError('INVALID_JSON', '计划输入不是有效 JSON');
  }
  let requirements = current;
  if (input && typeof input === 'object' && !('requirementRevision' in input)) {
    const legacy = parseProtocol(planSchema, input);
    requirements ??= establish(legacy);
    if (legacy.objective !== requirements.objective)
      throw new RequirementError(
        'LEGACY_REQUIREMENTS_CHANGED',
        'objective',
        '旧格式不能改写总目标；使用当前需求引用。',
        requirements,
      );
    for (const [field, kind] of [
      ['constraints', 'constraint'],
      ['acceptance', 'acceptance'],
      ['nonGoals', 'nonGoal'],
    ] as const)
      if (JSON.stringify(legacy[field]) !== JSON.stringify(requirementTexts(requirements, kind)))
        throw new RequirementError(
          'LEGACY_REQUIREMENTS_CHANGED',
          field,
          '旧格式不能改写需求；改用 requirementRevision 和 requirementIds。',
          requirements,
        );
    const {
      objective: _objective,
      constraints: _constraints,
      acceptance: _acceptance,
      nonGoals: _nonGoals,
      goalContract: _goalContract,
      ...rest
    } = legacy;
    const { admission: _admission, ...fields } = rest as typeof rest & { admission?: string };
    input = {
      ...fields,
      requirementRevision: requirements.revision,
      steps: legacy.steps.map(({ acceptance, ...step }, index) => ({
        ...step,
        purpose: 'delivery',
        requirementIds: acceptance.map((text) => {
          const item = requirements!.items.find((item) => item.kind === 'acceptance' && item.text === text);
          if (!item)
            throw new RequirementError(
              'LEGACY_REQUIREMENTS_CHANGED',
              `steps.${index}.acceptance`,
              '步骤验收不属于已接纳要求；使用现有验收编号，新增要求请单列建议。',
              requirements,
            );
          return item.id;
        }),
      })),
    };
  }
  if (!requirements)
    throw new RequirementError(
      'ANALYSIS_REQUIRED',
      'requirementRevision',
      '先调用 emergence_analyze 建立需求。',
    );
  const proposal = parseProtocol(planProposalSchema, input);
  return { proposal, requirements, materialize: () => materializeProposal(proposal, requirements) };
}
