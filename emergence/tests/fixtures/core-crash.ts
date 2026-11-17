import { executionFixture } from './core-execution.ts';
const f = await executionFixture(process.argv[2], true),
  worker = await f.w.split('row');
await f.w.taskEngine.enqueue(worker.id, worker.id, 'crash-on-effect', 'fixture:write', [], {
  role: 'developer',
  scope: ['result.txt'],
  acceptance: ['实际文件正确'],
});
setInterval(() => {}, 1000);
