import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inside } from '../../platform/path-policy.ts';
import { safeError } from '../../core/adapters/redaction.ts';
import {
  attachNativeOutputs,
  attachNativeReadEvidence,
} from '../../core/application/native-read-evidence.ts';
import { Definitions, definitionSchema, type AnalysisDefinition } from './definitions.ts';
import { deliverAnalysis } from './delivery.ts';
import { analysisMethods, type AnalysisMethod } from './methods.ts';
import { dataPreview, readWorkerResponse } from './result.ts';
import { dataRuntime } from './runtime.ts';
export { dataRuntime } from './runtime.ts';

const maxInputBytes = 8 * 1024 * 1024;
const workerTimeoutMs = 30000;

async function boundedInput(path: string) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxInputBytes + 1);
    let size = 0;
    for (;;) {
      const chunk = await handle.read(buffer, size, buffer.length - size, null);
      size += chunk.bytesRead;
      if (size > maxInputBytes) throw new Error('数据文件超过 8 MiB');
      if (!chunk.bytesRead) return buffer.subarray(0, size);
    }
  } finally {
    await handle.close();
  }
}
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export async function runWorker(
  python: string,
  worker: string,
  request: object,
  cwd: string,
  signal: AbortSignal,
  timeout = workerTimeoutMs,
): Promise<{
  code: number | null;
  output: string;
}> {
  signal.throwIfAborted();
  const input = JSON.stringify(request);
  return new Promise((done, reject) => {
    const child = spawn(python, ['-I', '-B', '-X', 'utf8', worker], {
      cwd,
      windowsHide: true,
      shell: false,
      env: { SystemRoot: process.env.SystemRoot, PATH: dirname(python), TEMP: cwd, TMP: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      bytes = 0,
      failure: string | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(
          join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', () => child.kill());
        killer.on('exit', (code) => {
          if (code !== 0) child.kill();
        });
      } else child.kill('SIGKILL');
    };
    const cancel = () => stop('数据执行已取消');
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('数据执行超时，已终止执行进程'), timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (b: string) => {
      bytes += Buffer.byteLength(b);
      if (bytes > 512000) stop('数据结果超过输出预算');
      else output += b;
    });
    child.stderr.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes > 512000) stop('数据诊断超过输出预算');
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    };
    child.on('error', () => {
      cleanup();
      reject(
        new Error(
          '数据 Python 环境不可用；请运行 emergence data-init --python "Python 3.14 的 python.exe 路径"',
        ),
      );
    });
    child.on('close', (code) => {
      cleanup();
      if (failure) reject(new Error(failure));
      else done({ code, output });
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Early worker exit has its own diagnostic on close.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED')
        stop('无法向数据执行进程传入请求：' + safeError(error));
    });
    child.stdin.end(input);
    if (signal.aborted) cancel();
  });
}
export type DataRequest = {
  file_path: string;
  encoding?: string;
  delimiter?: string;
  sheet?: string;
  sql?: string;
  method?: AnalysisMethod;
  params?: Record<string, unknown>;
  definition?: unknown;
  definition_name?: string;
};
export async function analyzeData(
  root: string,
  home: string,
  args: DataRequest,
  signal: AbortSignal,
  valid: () => boolean = () => true,
) {
  if (args.method && !Object.hasOwn(analysisMethods, args.method)) throw new Error('未发布的分析方法');
  if (args.method && args.sql) throw new Error('分析方法与自定义 SQL 分开运行');
  if (!args.method && (args.definition_name || args.definition))
    throw new Error('业务口径须与分析方法一起提供');
  if (Buffer.byteLength(JSON.stringify(args)) > 20000) throw new Error('分析参数超过预算');
  let definition: AnalysisDefinition | null = null;
  const definitions = new Definitions(home, root);
  let definitionInput: Awaited<ReturnType<Definitions['evidence']>> | undefined;
  if (args.method) {
    const params = definitionSchema.shape.params.parse(args.params ?? {});
    if (args.definition_name) {
      definition = await definitions.get(args.definition_name);
      if (!definition) throw new Error('找不到已确认口径');
      definitionInput = await definitions.evidence(args.definition_name);
      if (
        definition.definition.method !== args.method ||
        !isDeepStrictEqual(definition.definition.params, params)
      )
        throw new Error('计算方法/参数与已确认口径不一致，请重读口径，不得沿用确认状态');
    } else {
      definition = {
        status: 'assumed',
        definition: args.definition
          ? definitionSchema.parse(args.definition)
          : {
              name: args.method,
              method: args.method,
              params,
              grain: '未明确',
              unit: '未明确',
              timezone: '未明确',
              source: args.file_path,
              assumptions: ['尚未保存用户确认的业务口径；请核对参数和报告'],
            },
      };
      if (
        args.definition &&
        (definition.definition.method !== args.method ||
          !isDeepStrictEqual(definition.definition.params, params))
      )
        throw new Error('报告口径与实际计算参数不一致');
    }
  }
  const definitionVersion = definition && 'version' in definition ? definition.version : null;
  const base = await realpath(root),
    input = resolve(base, args.file_path),
    physical = await realpath(input),
    stat = await lstat(input);
  if (!inside(base, physical) || stat.isSymbolicLink() || !stat.isFile() || stat.size > maxInputBytes)
    throw new Error('数据源须是项目内不超过 8 MiB 的普通文件');
  const extension = extname(input).toLowerCase();
  if (!['.csv', '.tsv', '.xlsx', '.parquet'].includes(extension))
    throw new Error('支持 CSV、TSV、XLSX、Parquet');
  if (args.sql && args.sql.length > 8000) throw new Error('SQL 超过长度预算');
  if (!valid()) throw new Error('数据读取权限已变化');
  const source = await boundedInput(physical);
  const sourceHash = hash(source),
    runtime = await dataRuntime(home);
  let directory = await realpath(home);
  for (const name of ['core', 'data-runs']) {
    directory = join(directory, name);
    await mkdir(directory).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const s = await lstat(directory);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('数据产物目录不安全');
  }
  directory = join(directory, randomUUID());
  await mkdir(directory);
  const copy = join(directory, 'input' + extension);
  await writeFile(copy, source, { flag: 'wx', mode: 0o600 });
  const request = { ...args, input: copy, snapshot: 'input' + extension };
  await writeFile(join(directory, 'request.json'), JSON.stringify(request, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  const engineFiles = [
    runtime.worker,
    join(dirname(runtime.worker), 'analytics.py'),
    join(dirname(runtime.worker), 'requirements.txt'),
  ];
  const workerHash = hash(Buffer.concat(await Promise.all(engineFiles.map((file) => readFile(file)))));
  const startedAt = new Date().toISOString();
  try {
    const response = await runWorker(runtime.python, runtime.worker, request, directory, signal);
    const value = readWorkerResponse(response.output);
    if (!value.ok) throw new Error(safeError(value.error || '数据执行失败'));
    if (response.code !== 0) throw new Error(`数据执行失败（退出码 ${response.code ?? '未知'}）`);
    if (
      !value.result.selectSheet &&
      (value.result.analysis?.method !== args.method || value.result.query?.sql !== (args.sql || undefined))
    )
      throw new Error('数据执行回执与本次请求不一致');
    signal.throwIfAborted();
    if (!valid() || hash(await boundedInput(physical)) !== sourceHash || (await realpath(input)) !== physical)
      throw new Error('数据源、目录或权限已变化，本次结果失效');
    if (workerHash !== hash(Buffer.concat(await Promise.all(engineFiles.map((file) => readFile(file))))))
      throw new Error('分析引擎在运行期间变化');
    if (args.definition_name && definitionVersion !== (await definitions.get(args.definition_name))?.version)
      throw new Error('业务口径在计算期间变化');
    const artifacts = await deliverAnalysis(directory, runtime.worker, value.result, definition);
    const result = dataPreview(value.result, { artifact: directory, sourceHash }, definition, artifacts);
    await writeFile(join(directory, 'result.json'), JSON.stringify(value.result, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          status: 'succeeded',
          source: physical,
          sourceHash,
          workerHash,
          argumentsHash: hash(JSON.stringify(args)),
          requestHash: hash(await readFile(join(directory, 'request.json'))),
          queryHash: args.sql ? hash(args.sql) : null,
          environment: value.result.runtime,
          resultHash: hash(JSON.stringify(value.result)),
          artifacts,
          definitionVersion,
          definitionStatus: definition?.status ?? null,
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: response.code,
          limits: { bytes: maxInputBytes, rows: 10000, columns: 128, timeoutMs: workerTimeoutMs },
          remote: 'not-configured',
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    if ('analysis' in result && result.analysis)
      attachNativeOutputs(
        await Promise.all(
          [...artifacts.map((a) => a.name), 'result.json', 'request.json', 'manifest.json'].map(
            async (name) => {
              const data = await readFile(join(directory, name));
              return {
                path: join(directory, name),
                hash: hash(data),
                state: 'present' as const,
                bytes: data.length,
              };
            },
          ),
        ),
      );
    return attachNativeReadEvidence(result, [
      { path: physical, hash: sourceHash, state: 'present', bytes: source.length },
      ...(definitionInput ? [definitionInput] : []),
    ]);
  } catch (error) {
    try {
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          status: signal.aborted ? 'cancelled' : 'failed',
          sourceHash,
          workerHash,
          startedAt,
          error: safeError(error),
        }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (receiptError) {
      if ((receiptError as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error(safeError(error) + '；数据运行记录写入失败：' + safeError(receiptError), {
          cause: error,
        });
    }
    throw error;
  }
}
