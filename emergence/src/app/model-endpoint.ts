import type { ModelConfig } from '../core/domain/configuration.ts';

/** Anthropic's SDK adds /v1/messages itself; accept both documented root and legacy /v1 inputs. */
export function modelBaseURL(model: Pick<ModelConfig, 'api' | 'baseURL'>) {
  const base = model.baseURL.replace(/\/+$/, '');
  return model.api === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base;
}
/** The installed Harness supports Gemini through Google's official OpenAI compatibility endpoint. */
export function modelWireConfig(model: Pick<ModelConfig, 'api' | 'baseURL'>) {
  const baseURL = modelBaseURL(model);
  if (model.api === 'google-generative-ai')
    return {
      api: 'openai-completions' as const,
      baseURL: baseURL.endsWith('/openai') ? baseURL : baseURL + '/openai',
    };
  return { api: model.api, baseURL };
}
