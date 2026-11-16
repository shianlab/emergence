import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { parseProtocol, protocolInput, schemaParameter } from '../src/core/adapters/tool-protocol.ts';
import { claimsSchema } from '../src/core/domain/assurance.ts';
import { workProposalSchema } from '../src/core/domain/plan-proposal.ts';

test('model schema exposes nested required fields instead of an opaque JSON string', () => {
  const schema = parameterSchemaSpecToJsonSchema({ work: schemaParameter(workProposalSchema) });
  const work = schema.properties.work as any;
  assert.equal(work.type, 'object');
  assert.ok(work.required.includes('requirementRevision'));
  assert.match(work.properties.requirementRevision.description, /requirements.revision/);
  assert.match(work.properties.evidence.description, /callId/);
  assert.match(work.properties.steps.items.properties.scope.description, /不得放命令/);
  assert.match(work.properties.steps.items.properties.capabilities.description, /tool:read/);
  assert.ok(work.properties.steps.items.required.includes('requirementIds'));
  assert.ok(work.properties.steps.items.required.includes('purpose'));
  assert.equal(work.properties.steps.items.properties.capabilities.items.type, 'string');
  assert.equal(work.additionalProperties, false);
});
test('legacy and structured checks share validation; conflicts and invalid evidence are rejected', () => {
  const checks = [{ criterion: 0, passed: true, receipts: ['actual'], note: 'actual evidence' }];
  assert.deepEqual(parseProtocol(claimsSchema, protocolInput({ checks }, 'checks', 'checks_json')), checks);
  assert.deepEqual(
    parseProtocol(
      claimsSchema,
      protocolInput({ checks_json: JSON.stringify(checks) }, 'checks', 'checks_json'),
    ),
    checks,
  );
  assert.throws(
    () => protocolInput({ checks, checks_json: '[]' }, 'checks', 'checks_json'),
    /INPUT_CONFLICT/,
  );
  assert.throws(() => protocolInput({ checks, bypass: true }, 'checks', 'checks_json'), /INPUT_CONFLICT/);
  assert.throws(() => parseProtocol(claimsSchema, '{'), /INVALID_JSON/);
  assert.throws(() => parseProtocol(claimsSchema, [{ ...checks[0], blocked: true }]), /INVALID_ARGUMENTS/);
  assert.throws(
    () => parseProtocol(workProposalSchema, { steps: [{ capabilities: 1 }] }),
    /steps.0.capabilities/,
  );
});
