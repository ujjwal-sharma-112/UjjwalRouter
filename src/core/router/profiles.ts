import type { ModelRecord } from '../policy/types.js';

export const ROUTING_PROFILES = [
  'auto',
  'auto-coding',
  'auto-reasoning',
  'auto-long',
  'auto-fast',
  'auto-tools',
  'auto-vision',
  'auto-json',
] as const;

export type RoutingProfile = (typeof ROUTING_PROFILES)[number];

export function isRoutingProfile(modelId: string): modelId is RoutingProfile {
  return (ROUTING_PROFILES as readonly string[]).includes(modelId);
}

export function profileMatchesModel(profile: RoutingProfile, model: ModelRecord): boolean {
  switch (profile) {
    case 'auto':
      return true;
    case 'auto-coding':
      return model.codingCapability === 'high' || model.codingCapability === 'medium' || model.supportsTools;
    case 'auto-reasoning':
      return model.supportsReasoning;
    case 'auto-long':
      return model.effectiveContextWindow >= 128_000;
    case 'auto-fast':
      return true;
    case 'auto-tools':
      return model.supportsTools;
    case 'auto-vision':
      return model.supportsVision;
    case 'auto-json':
      return model.supportsJsonMode;
  }
}
