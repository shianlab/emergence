import { checkedMemoryText as validateContent } from '../domain/memory.ts';
import { safeError } from './redaction.ts';

/** Host credential checks supplement pure content rules at persistence boundaries. */
export function checkedMemoryText(input: string): string {
  const text = validateContent(input);
  if (safeError(text) !== text) {
    throw new Error('记忆含疑似密钥或敏感凭据，未写入；请先去除');
  }
  return text;
}
