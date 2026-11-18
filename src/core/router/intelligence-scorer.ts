import type { CodingCapabilityTier, ModelRecord } from '../policy/types.js';
import type { RoutingProfile } from './profiles.js';

export type IntelligenceTier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface IntelligenceScoreResult {
  score: number;
  tier: IntelligenceTier;
  paramBillions: number | null;
  reasonTag: string;
}

export interface RequestComplexityContext {
  estimatedInputTokens?: number;
  messageCount?: number;
  toolCount?: number;
  hasResponseFormat?: boolean;
}

/**
 * Extracts total model scale (in billions of parameters) from model IDs when advertised.
 * Handles MoE formats like "550b-a55b", "29b-a4b", "17b-128e", and standard "70b", "32b", "2.6b".
 */
export function extractParameterBillions(modelId: string): number | null {
  const lower = modelId.toLowerCase();
  // Match leading parameter size before any "-aNNb" active-parameter suffix
  const matches = Array.from(lower.matchAll(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)b(?![a-z0-9])/g));
  const candidateNumbers: number[] = [];
  for (const m of matches) {
    const raw = m[1];
    if (!raw) continue;
    const matchIndex = m.index ?? 0;
    const prefixChar = lower[matchIndex];
    // Skip active-param tokens like "-a55b" / "-a4b" when total size exists
    if (prefixChar === 'a') continue;
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value) && value > 0 && value <= 2000) {
      candidateNumbers.push(value);
    }
  }
  if (candidateNumbers.length === 0) return null;
  return Math.max(...candidateNumbers);
}

/**
 * Classifies a model's coding/agentic capability tier consistently across all provider adapters.
 */
export function inferCodingCapabilityTier(modelId: string, supportsTools = true): CodingCapabilityTier {
  const lower = modelId.toLowerCase();
  const paramsB = extractParameterBillions(lower);

  // Nano / tiny models (<= 4B) should never be rated high coding capability
  if (paramsB !== null && paramsB <= 4.5) {
    return 'low';
  }

  const isFrontierCodingFamily =
    lower.includes('coder') ||
    lower.includes('codestral') ||
    lower.includes('devstral') ||
    lower.includes('deepseek-r1') ||
    lower.includes('deepseek-v3') ||
    lower.includes('deepseek') ||
    lower.includes('gpt-oss-120b') ||
    lower.includes('nemotron-3-ultra') ||
    lower.includes('nemotron-3.5-super') ||
    lower.includes('nemotron-3.5-lightning') ||
    lower.includes('qwen3-235b') ||
    lower.includes('qwen3-32b') ||
    lower.includes('qwen2.5-coder-32b') ||
    lower.includes('mistral-large') ||
    lower.includes('command-a') ||
    lower.includes('kimi-k2') ||
    lower.includes('llama-3.3-70b') ||
    lower.includes('llama-3.1-405b') ||
    lower.includes('llama-4-maverick') ||
    lower.includes('gemma-4-31b') ||
    lower.includes('gemma-4-26b') ||
    lower.includes('gemma-3-27b') ||
    (lower.includes('gemini') && !lower.includes('flash-lite') && !lower.includes('nano'));

  if (isFrontierCodingFamily) {
    return supportsTools ? 'high' : 'medium';
  }

  if (
    lower.includes('flash-lite') ||
    lower.includes('mistral-medium') ||
    lower.includes('mistral-small') ||
    lower.includes('magistral') ||
    lower.includes('llama-4-scout') ||
    lower.includes('gpt-oss-20b') ||
    lower.includes('command-r') ||
    lower.includes('nemotron') ||
    (paramsB !== null && paramsB >= 12)
  ) {
    return 'medium';
  }

  if (lower.includes('8b') || lower.includes('9b') || lower.includes('7b')) {
    return 'low';
  }

  return supportsTools ? 'medium' : 'low';
}

function resolveBaselineQuality(model: ModelRecord, paramBillions: number | null): {
  basePoints: number;
  tier: IntelligenceTier;
} {
  const lower = model.id.toLowerCase();

  // Explicit nano check first so 1B-4B models stay Tier D even inside strong families
  if (paramBillions !== null && paramBillions <= 4.5) {
    return { basePoints: 2, tier: 'D' };
  }

  // Tier S: Frontier-grade coding, reasoning, SWE/agentic & instruction-following models
  if (
    lower.includes('gemini-2.5-pro') ||
    lower.includes('gemini-3-flash') ||
    lower.includes('gemini-2.5-flash') ||
    lower.includes('gemini-flash-latest') ||
    lower.includes('nemotron-3-ultra-550b') ||
    lower.includes('deepseek-r1') ||
    lower.includes('deepseek-v3') ||
    lower.includes('qwen3-coder') ||
    lower.includes('qwen3-235b') ||
    lower.includes('gpt-oss-120b') ||
    lower.includes('devstral-medium') ||
    lower.includes('codestral') ||
    lower.includes('mistral-large') ||
    lower.includes('kimi-k2') ||
    lower.includes('llama-3.1-405b') ||
    lower.includes('command-a')
  ) {
    return { basePoints: 30, tier: 'S' };
  }

  // Tier A: Strong large/specialized open models (26B-70B, Super/Lightning, Flash-Lite, Devstral Small)
  if (
    lower.includes('nemotron-3.5-super') ||
    lower.includes('nemotron-3.5-lightning') ||
    lower.includes('llama-3.3-70b') ||
    lower.includes('llama-4-maverick') ||
    lower.includes('qwen3-32b') ||
    lower.includes('qwen2.5-coder-32b') ||
    lower.includes('gemma-4-31b') ||
    lower.includes('gemma-4-26b') ||
    lower.includes('gemma-3-27b') ||
    lower.includes('devstral-small') ||
    lower.includes('devstral') ||
    lower.includes('magistral') ||
    lower.includes('mistral-medium') ||
    lower.includes('gemini-2.5-flash-lite') ||
    lower.includes('gemini-3.1-flash-lite') ||
    lower.includes('gemini-flash-lite') ||
    (paramBillions !== null && paramBillions >= 65)
  ) {
    return { basePoints: 23, tier: 'A' };
  }

  // Tier B: Capable mid-scale models (12B-30B, Llama 4 Scout, Mistral Small, Command R, GPT-OSS 20B)
  if (
    lower.includes('llama-4-scout') ||
    lower.includes('mistral-small') ||
    lower.includes('gpt-oss-20b') ||
    lower.includes('command-r') ||
    lower.includes('nemotron') ||
    lower.includes('gemma-3-12b') ||
    (paramBillions !== null && paramBillions >= 12)
  ) {
    return { basePoints: 15, tier: 'B' };
  }

  // Tier C: Fast 7B-11B lightweight models (Llama 3.1 8B, Ministral 8B, etc.)
  if (
    lower.includes('8b') ||
    lower.includes('9b') ||
    lower.includes('7b') ||
    lower.includes('ministral')
  ) {
    return { basePoints: 8, tier: 'C' };
  }

  if (model.codingCapability === 'high') return { basePoints: 22, tier: 'A' };
  if (model.codingCapability === 'medium') return { basePoints: 14, tier: 'B' };
  return { basePoints: 7, tier: 'C' };
}

/**
 * Computes an adaptive benchmark-intelligence score adjusted for profile & request complexity.
 */
export function scoreModelIntelligence(
  model: ModelRecord,
  profile: RoutingProfile,
  complexity: RequestComplexityContext = {}
): IntelligenceScoreResult {
  const paramBillions = extractParameterBillions(model.id);
  const { basePoints, tier } = resolveBaselineQuality(model, paramBillions);

  const tokens = complexity.estimatedInputTokens ?? 0;
  const turns = complexity.messageCount ?? 1;
  const tools = complexity.toolCount ?? 0;
  const isComplexTask =
    profile === 'auto-coding' ||
    profile === 'auto-reasoning' ||
    profile === 'auto-tools' ||
    profile === 'auto-long' ||
    tools > 0 ||
    turns >= 4 ||
    tokens >= 16_000;

  let score = basePoints;

  if (isComplexTask && profile !== 'auto-fast') {
    // Reward Tier S/A capability and verified structured/tool execution on agentic/coding prompts
    if (tier === 'S') score += 10;
    else if (tier === 'A') score += 6;
    else if (tier === 'D') score -= 12;
    else if (tier === 'C') score -= 4;

    if (model.supportsTools) score += 6;
    if (model.supportsReasoning && (profile === 'auto-reasoning' || profile === 'auto-coding' || profile === 'auto')) {
      score += 5;
    }
    if (model.supportsJsonMode && (profile === 'auto-json' || profile === 'auto-coding' || tools > 0)) {
      score += 4;
    }
  } else if (profile === 'auto-fast') {
    // For explicit low-latency fast profile, compact mid/fast models stay competitive
    if (tier === 'C' || tier === 'B') score += 4;
  } else {
    if (model.supportsTools) score += 4;
    if (model.supportsReasoning) score += 3;
  }

  return {
    score: Math.round(score * 100) / 100,
    tier,
    paramBillions,
    reasonTag: `tier=${tier}${paramBillions !== null ? `(${paramBillions}B)` : ''}`,
  };
}
