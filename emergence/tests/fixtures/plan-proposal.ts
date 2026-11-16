import type { Requirements } from '../../src/core/domain/requirements.ts';

/** Test providers answer using the host's actual analysis receipt, never invented revision IDs. */
export function propose<
  T extends {
    objective: string;
    constraints: string[];
    acceptance: string[];
    nonGoals: string[];
    steps: Array<{ acceptance: string[] }>;
  },
>(plan: T, requirements: Requirements) {
  const {
    objective: _objective,
    constraints: _constraints,
    acceptance: _acceptance,
    nonGoals: _nonGoals,
    ...rest
  } = plan;
  return {
    ...rest,
    requirementRevision: requirements.revision,
    steps: plan.steps.map(({ acceptance: _acceptance, ...step }) => ({
      ...step,
      purpose: 'delivery',
      requirementIds: requirements.items.filter((item) => item.kind === 'acceptance').map((item) => item.id),
    })),
  };
}
