import type { ModelProduct } from './types.js';

export function costUsd(p: ModelProduct, inputTokens: number, outputTokens: number): number {
  const c = (inputTokens * (p.priceInPer1M ?? 0) + outputTokens * (p.priceOutPer1M ?? 0)) / 1_000_000;
  return Math.round(c * 1e8) / 1e8;
}
