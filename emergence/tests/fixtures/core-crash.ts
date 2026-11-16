import { executionFixture } from './core-execution.ts';
const f = await executionFixture(process.argv[2], true),
  master = f.w.current,
  worker = await f.w.split('row');
f.w.collaboration.configure(master.id, [worker.id]);
await f.w.collaboration.enqueue(master.id, worker.id, 'crash-on-effect', 'fixture:write', [], {
  role: 'developer',
  scope: ['result.txt'],
  acceptance: ['实际文件正确'],
});
setInterval(() => {}, 1000);
