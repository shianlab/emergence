import { createHash } from 'node:crypto';
import { z } from 'zod';
import { registerSecretNames } from '../core/adapters/redaction.ts';
import { configSchema, modelSchema, type AppConfig, type ModelConfig } from '../core/domain/configuration.ts';
import { loadConfig, updateConfig } from './config.ts';
import {
  credentialSource,
  prepareModelCredentials,
  resolveCredential,
  saveCredential,
} from './credentials.ts';
import { modelWireConfig } from './model-endpoint.ts';
import { modelPresets } from './model-presets.ts';

export function configurationRevision(config: AppConfig) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        models: config.models,
        defaultModel: config.defaultModel,
        windowModels: config.windowModels,
      }),
    )
    .digest('hex');
}
export function windowModel(config: AppConfig, kind: 'single' | 'master' | 'worker', number?: number) {
  return (
    (number && number > 1 && config.windowModels.slots[String(number)]) ||
    config.windowModels[kind] ||
    config.defaultModel
  );
}
/** Only explicit, short requests open the UI; ordinary development questions still reach the agent. */
export function modelConfigurationIntent(text: string) {
  return (
    /^(?:(?:请|帮我|麻烦|我想|我要)\s*)?(?:(?:打开|进入|启动|显示|配置|设置|切换)\s*(?:一下)?\s*(?:模型|模型配置|模型设置|模型配置工具|模型配置窗口|模型配置界面)|(?:怎么|如何)(?:去)?\s*(?:配置|设置|切换)\s*模型)[啊呀吧呢吗？?。！!\s]*$/.test(
      text.trim(),
    ) ||
    /^(?:模型|模型配置)(?:要)?(?:怎么|如何)(?:去)?(?:配置|设置|切换)[啊呀吧呢吗？?。！!\s]*$/.test(
      text.trim(),
    ) ||
    /^(?:open\s+)?model\s+(?:settings|configuration)[.!?\s]*$/i.test(text.trim())
  );
}
export interface ModelWindow {
  id: string;
  number: number;
  role: string;
  modelId: string;
  cwd: string;
  status: string;
  mutable: boolean;
}
export interface ModelConfigurationHost {
  windows(): ModelWindow[];
  beginChange(): () => void;
  validate(config: AppConfig): void;
  apply(config: AppConfig): Promise<void>;
  assign(id: string, modelId: string): Promise<void>;
}
const revisionSchema = z.string().length(64);
const saveSchema = z
  .object({ revision: revisionSchema, model: modelSchema, secret: z.string().max(8192).optional() })
  .strict();
const defaultsSchema = z
  .object({
    revision: revisionSchema,
    defaultModel: z.string(),
    windowModels: configSchema.shape.windowModels,
  })
  .strict();
const removeSchema = z.object({ revision: revisionSchema, id: z.string() }).strict();
const assignmentSchema = z
  .object({ windowId: z.string(), modelId: z.string(), revision: revisionSchema })
  .strict();
const testSchema = z.object({ model: modelSchema, secret: z.string().max(8192).optional() }).strict();
const validateSecret = (value: string) => {
  if (value.length < 8 || /[^\x21-\x7e]/.test(value))
    throw new Error('密钥至少 8 位，且不能含空格、换行或非 ASCII 字符');
};

export class ModelConfiguration {
  private changing = false;
  constructor(
    readonly home: string,
    readonly host?: ModelConfigurationHost,
  ) {}
  async state() {
    const config = await loadConfig(this.home);
    await prepareModelCredentials(
      this.home,
      config.models.map((model) => model.apiKeyEnv),
    );
    return {
      revision: configurationRevision(config),
      defaultModel: config.defaultModel,
      windowModels: config.windowModels,
      presets: modelPresets,
      models: config.models.map((model) => ({
        ...model,
        credentialConfigured: credentialSource(this.home, model.apiKeyEnv) !== 'missing',
        credentialSource: credentialSource(this.home, model.apiKeyEnv),
      })),
      windows: this.host?.windows() ?? [],
      live: Boolean(this.host),
      credentialStorage: process.platform === 'win32' ? 'Windows DPAPI' : '环境变量',
      home: this.home,
    };
  }
  private async change(
    revision: string,
    edit: (config: AppConfig) => void,
    credential?: () => Promise<void>,
  ) {
    if (this.changing) throw new Error('配置正在保存，请稍候');
    this.changing = true;
    let release: (() => void) | undefined,
      credentialSaved = false;
    try {
      release = this.host?.beginChange();
      // Validate the entire candidate before writing a credential or changing a runtime route.
      const current = await loadConfig(this.home);
      if (configurationRevision(current) !== revision) throw new Error('配置已被其他窗口修改，请刷新后重试');
      const candidate = structuredClone(current);
      edit(candidate);
      configSchema.parse(candidate);
      this.host?.validate(candidate);
      if (credential) {
        await credential();
        credentialSaved = true;
      }
      const latest = await updateConfig(this.home, (value) => {
        if (configurationRevision(value) !== revision) throw new Error('配置已被其他窗口修改，请刷新后重试');
        edit(value);
      });
      if (this.host) {
        try {
          await this.host.apply(latest);
        } catch (error) {
          // Roll back only the model fields, and only if no later editor has changed them.
          await updateConfig(this.home, (value) => {
            if (configurationRevision(value) !== configurationRevision(latest))
              throw new Error('运行时更新失败，磁盘配置又有新修改；请重启工作台以重新加载');
            value.models = current.models;
            value.defaultModel = current.defaultModel;
            value.windowModels = current.windowModels;
          });
          throw error;
        }
      }
      return this.state();
    } catch (error) {
      if (credentialSaved)
        throw new Error(
          '模型配置未完成，但密钥已加密保存；请修正配置后重试。' +
            (error instanceof Error ? error.message : '请刷新状态后检查配置'),
        );
      throw error;
    } finally {
      release?.();
      this.changing = false;
    }
  }
  async save(input: unknown) {
    const value = saveSchema.parse(input),
      secret = value.secret?.trim();
    if (secret) validateSecret(secret);
    registerSecretNames([value.model.apiKeyEnv]);
    const state = await this.change(
      value.revision,
      (config) => {
        const previous = config.models.findIndex((m) => m.id === value.model.id);
        if (previous < 0) config.models.push(value.model);
        else config.models[previous] = value.model;
      },
      secret ? () => saveCredential(this.home, value.model.apiKeyEnv, secret) : undefined,
    );
    return {
      ...state,
      credentialWarning:
        secret && credentialSource(this.home, value.model.apiKeyEnv) === 'environment'
          ? `密钥已加密保存，但当前进程设置了 ${value.model.apiKeyEnv} 环境变量，实际请求仍使用环境变量。取消该变量并重启涌现后，才会使用新保存的密钥。`
          : undefined,
    };
  }
  async defaults(input: unknown) {
    const value = defaultsSchema.parse(input);
    return this.change(value.revision, (config) => {
      config.defaultModel = value.defaultModel;
      config.windowModels = value.windowModels;
    });
  }
  async remove(input: unknown) {
    const value = removeSchema.parse(input);
    return this.change(value.revision, (config) => {
      if (this.host?.windows().some((w) => w.modelId === value.id))
        throw new Error('仍有窗口使用这个模型，请先更换窗口模型');
      config.models = config.models.filter((m) => m.id !== value.id);
    });
  }
  async assign(input: unknown) {
    const value = assignmentSchema.parse(input);
    if (!this.host) throw new Error('独立配置模式：从正在运行的涌现中打开本工具，才能分配当前窗口');
    if (this.changing) throw new Error('配置正在保存，请稍候');
    const config = await loadConfig(this.home);
    if (configurationRevision(config) !== value.revision) throw new Error('配置已变化，请刷新后重试');
    if (!config.models.some((m) => m.id === value.modelId)) throw new Error('模型配置不存在');
    await this.host.assign(value.windowId, value.modelId);
    return this.state();
  }
  async test(input: unknown, signal?: AbortSignal) {
    const value = testSchema.parse(input),
      secret = value.secret?.trim();
    if (secret) validateSecret(secret);
    return testModelConnection(
      value.model,
      secret || (await resolveCredential(this.home, value.model.apiKeyEnv)),
      signal,
    );
  }
}

/** A small real inference request, with a hard timeout and no provider error-body echo. */
export async function testModelConnection(model: ModelConfig, secret?: string, signal?: AbortSignal) {
  const start = performance.now();
  if (!secret)
    return {
      ok: false,
      kind: 'credential',
      message: '缺少密钥：请填写 API 密钥或设置对应环境变量',
      elapsedMs: 0,
    };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const prompt = 'Reply with OK.';
  const budget = Math.min(model.maxTokens, 1024);
  const wire = modelWireConfig(model);
  let path: string, body: object;
  switch (wire.api) {
    case 'openai-completions':
      path = '/chat/completions';
      headers.Authorization = `Bearer ${secret}`;
      body = {
        model: model.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: budget,
        stream: false,
      };
      break;
    case 'openai-responses':
      path = '/responses';
      headers.Authorization = `Bearer ${secret}`;
      body = { model: model.model, input: prompt, max_output_tokens: budget, stream: false };
      break;
    case 'anthropic-messages':
      path = '/v1/messages';
      headers['x-api-key'] = secret;
      headers['anthropic-version'] = '2023-06-01';
      body = { model: model.model, messages: [{ role: 'user', content: prompt }], max_tokens: budget };
      break;
  }
  try {
    const response = await fetch(wire.baseURL + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      redirect: 'error',
    });
    const elapsedMs = Math.round(performance.now() - start);
    if (!response.ok) {
      await response.body?.cancel();
      const kind = [401, 403].includes(response.status)
        ? 'auth'
        : response.status === 429
          ? 'rate_limit'
          : response.status === 404
            ? 'endpoint'
            : 'provider';
      const detail = {
        auth: '鉴权失败，请检查密钥和模型权限',
        rate_limit: '供应商限流或额度不足',
        endpoint: '接口或模型不存在，请检查地址、协议及模型名',
        provider: '供应商拒绝请求，请检查协议、模型参数或服务状态',
      };
      return {
        ok: false,
        kind,
        status: response.status,
        message: `${detail[kind]}（HTTP ${response.status}）`,
        elapsedMs,
      };
    }
    // Bound the response as well as the request, and reject HTML login pages / empty success envelopes.
    const chunks: Buffer[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty');
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024) throw new Error('oversize');
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      await reader.cancel();
    }
    let result: unknown;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { ok: false, kind: 'protocol', message: '接口返回了非 JSON 内容，请检查协议及地址', elapsedMs };
    }
    const textPart = z.object({ text: z.string() }).passthrough();
    const schemas = {
      'openai-completions': z
        .object({
          choices: z
            .array(
              z.object({
                message: z.object({
                  content: z.string().nullish(),
                  reasoning_content: z.string().optional(),
                }),
              }),
            )
            .min(1),
        })
        .transform((r) =>
          r.choices.map((c) => (c.message.content ?? '') + (c.message.reasoning_content ?? '')).join(''),
        ),
      'openai-responses': z
        .object({ output: z.array(z.object({ content: z.array(textPart).optional() }).passthrough()).min(1) })
        .transform((r) => r.output.flatMap((o) => o.content?.map((c) => c.text) ?? []).join('')),
      'anthropic-messages': z
        .object({ content: z.array(textPart).min(1) })
        .transform((r) => r.content.map((c) => c.text).join('')),
    };
    const parsed = schemas[wire.api].safeParse(result);
    return parsed.success && parsed.data.trim()
      ? {
          ok: true,
          kind: 'success',
          message: '连接成功，已收到模型回复',
          elapsedMs: Math.round(performance.now() - start),
        }
      : {
          ok: false,
          kind: 'protocol',
          message: '请求成功但未收到有效模型回复，请核对协议与模型名；推理模型可能需要更大的输出预算',
          elapsedMs,
        };
  } catch (error) {
    const aborted =
      signal?.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'network',
      message: aborted
        ? '测试已取消或超过 20 秒，请检查网络后重试'
        : '无法完成连接，请检查网络、地址或 TLS 证书',
      elapsedMs: Math.round(performance.now() - start),
    };
  }
}
