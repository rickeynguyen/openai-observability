import { z } from 'zod';

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
  // Allow extra fields for forward compatibility
}).passthrough();

export function normalizeTrace(input) {
  const parsed = TraceSchema.parse(input);
  const tokensPrompt = parsed.tokensPrompt ?? 0;
  const tokensCompletion = parsed.tokensCompletion ?? 0;
  const tokensTotal = parsed.tokensTotal ?? (tokensPrompt + tokensCompletion);
  return { ...parsed, tokensPrompt, tokensCompletion, tokensTotal };
}
