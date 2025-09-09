import { z } from 'zod';

export const PRICING = {
  'gpt-4o-mini': { prompt: 0.000150, completion: 0.000600 },
  'gpt-4.1-nano': { prompt: 0.000030, completion: 0.000060 },
  'omni-moderation-latest': { prompt: 0.000050, completion: 0 },
  'text-embedding-3-small': { prompt: 0.000020, completion: 0 },
  default: { prompt: 0.000100, completion: 0.000200 },
};

export function usd(model, promptTokens, completionTokens) {
  const p = PRICING[model] || PRICING.default;
  return (Number(promptTokens || 0) / 1000) * p.prompt + (Number(completionTokens || 0) / 1000) * p.completion;
}

export const TraceSchema = z.object({
  ts: z.number().int().nonnegative(),
  endpoint: z.string().min(1),
  model: z.string().optional(),
  region: z.string().optional(),
  ok: z.boolean(),
  status: z.number().int().optional(),
  errType: z.string().optional(),
  latencyMs: z.number().int().nonnegative(),
  tokensPrompt: z.number().int().nonnegative().optional(),
  tokensCompletion: z.number().int().nonnegative().optional(),
  tokensTotal: z.number().int().nonnegative().optional(),
  respBytes: z.number().int().nonnegative().optional(),
  requestId: z.string().optional(),
}).passthrough();

export function normalizeTrace(input) {
  const parsed = TraceSchema.parse(input);
  const tokensPrompt = parsed.tokensPrompt ?? 0;
  const tokensCompletion = parsed.tokensCompletion ?? 0;
  const tokensTotal = parsed.tokensTotal ?? (tokensPrompt + tokensCompletion);
  return { ...parsed, tokensPrompt, tokensCompletion, tokensTotal };
}
