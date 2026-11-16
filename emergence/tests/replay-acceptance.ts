// Offline only. No model configuration, credentials, subprocess execution or approval decisions.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { captureHistoricalAcceptance } from './fixtures/acceptance-capture.ts';
import { bytesHash, evaluateAcceptance } from './fixtures/acceptance-oracle.ts';

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg)
  throw new Error('Usage: replay-acceptance.ts <historical live-team.json> <new output directory>');
const source = resolve(sourceArg),
  destination = resolve(destinationArg);
const sourceDirectory = resolve(source, '..'),
  rel = relative(sourceDirectory, destination);
if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')))
  throw new Error('Reassessment must be outside the original sample directory');
// Exclusive creation: do not overwrite a previous reassessment or an original matrix file.
await mkdir(destination);
const captured = await captureHistoricalAcceptance(source);
const result = evaluateAcceptance(captured.snapshot);
if (bytesHash(await readFile(source)) !== captured.sourceHash)
  throw new Error('Historical evidence changed during capture');
await writeFile(join(destination, 'evidence.json'), JSON.stringify(captured, null, 2) + '\n', { flag: 'wx' });
await writeFile(
  join(destination, 'reassessment.json'),
  JSON.stringify(
    {
      source,
      sourceHash: captured.sourceHash,
      capturedAt: captured.capturedAt,
      scope:
        'Offline fixture evidence reassessment. Not a new live pass or full matrix certification; fixture bytes observed at capture time.',
      ...result,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    passed: result.passed,
    accepted: result.accepted.length,
    findings: result.findings.map((f) => f.code),
    destination,
  }),
);
