import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  endpointUrl: text('endpoint_url').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  configured: integer('configured', { mode: 'boolean' }).notNull().default(false),
  priority: integer('priority').notNull().default(100),
  freeTierNotes: text('free_tier_notes'),
  updatedAt: text('updated_at').notNull(),
});

export const models = sqliteTable(
  'models',
  {
    canonicalId: text('canonical_id').primaryKey(),
    modelId: text('model_id').notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    contextWindow: integer('context_window').notNull().default(0),
    providerInputLimit: integer('provider_input_limit'),
    accountFreeInputLimit: integer('account_free_input_limit'),
    effectiveContextWindow: integer('effective_context_window').notNull().default(0),
    maxOutputTokens: integer('max_output_tokens').notNull().default(0),
    inputPrice: real('input_price').notNull().default(0),
    outputPrice: real('output_price').notNull().default(0),
    requestPrice: real('request_price').notNull().default(0),
    imagePrice: real('image_price').notNull().default(0),
    freeEligibility: text('free_eligibility').notNull(),
    freeTierType: text('free_tier_type').notNull(),
    billingRequired: integer('billing_required', { mode: 'boolean' }).notNull().default(true),
    promotionalCredits: integer('promotional_credits', { mode: 'boolean' }).notNull().default(false),
    freeVerifiedAt: text('free_verified_at'),
    verificationExpiresAt: text('verification_expires_at'),
    freeVerificationSource: text('free_verification_source'),
    availabilityStatus: text('availability_status').notNull().default('UNAVAILABLE'),
    lastCheckedAt: text('last_checked_at'),
  },
  (table) => [index('idx_models_provider').on(table.providerId), index('idx_models_eligibility').on(table.freeEligibility)]
);

export const modelCapabilities = sqliteTable('model_capabilities', {
  canonicalId: text('canonical_id')
    .primaryKey()
    .references(() => models.canonicalId, { onDelete: 'cascade' }),
  supportsStreaming: integer('supports_streaming', { mode: 'boolean' }).notNull().default(true),
  supportsTools: integer('supports_tools', { mode: 'boolean' }).notNull().default(false),
  supportsVision: integer('supports_vision', { mode: 'boolean' }).notNull().default(false),
  supportsJsonMode: integer('supports_json_mode', { mode: 'boolean' }).notNull().default(false),
  supportsReasoning: integer('supports_reasoning', { mode: 'boolean' }).notNull().default(false),
  codingCapability: text('coding_capability').notNull().default('unknown'),
  updatedAt: text('updated_at').notNull(),
});

export const freeEligibilityChecks = sqliteTable(
  'free_eligibility_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    providerId: text('provider_id').notNull(),
    canonicalModelId: text('canonical_model_id').notNull(),
    eligible: integer('eligible', { mode: 'boolean' }).notNull(),
    freeEligibility: text('free_eligibility').notNull(),
    freeTierType: text('free_tier_type').notNull(),
    billingRequired: integer('billing_required', { mode: 'boolean' }).notNull(),
    promotionalCredits: integer('promotional_credits', { mode: 'boolean' }).notNull(),
    verificationSource: text('verification_source').notNull(),
    reason: text('reason').notNull(),
    checkedAt: text('checked_at').notNull(),
  },
  (table) => [index('idx_eligibility_checked_at').on(table.checkedAt)]
);

export const providerHealth = sqliteTable(
  'provider_health',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    healthy: integer('healthy', { mode: 'boolean' }).notNull(),
    status: text('status').notNull(),
    latencyMs: integer('latency_ms').notNull().default(0),
    message: text('message').notNull(),
    checkedAt: text('checked_at').notNull(),
  },
  (table) => [index('idx_provider_health_provider').on(table.providerId, table.checkedAt)]
);

export const providerQuotas = sqliteTable('provider_quotas', {
  providerId: text('provider_id')
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
  rpmLimit: integer('rpm_limit'),
  rpdLimit: integer('rpd_limit'),
  tpmLimit: integer('tpm_limit'),
  monthlyLimit: integer('monthly_limit'),
  remainingRequests: integer('remaining_requests'),
  remainingTokens: integer('remaining_tokens'),
  resetAt: text('reset_at'),
  notes: text('notes'),
  updatedAt: text('updated_at').notNull(),
});

export const routingProfiles = sqliteTable('routing_profiles', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

export const routingRules = sqliteTable('routing_rules', {
  id: text('id').primaryKey(),
  profileId: text('profile_id')
    .notNull()
    .references(() => routingProfiles.id, { onDelete: 'cascade' }),
  providerId: text('provider_id'),
  weight: real('weight').notNull().default(1.0),
  minContextWindow: integer('min_context_window'),
  requiresTools: integer('requires_tools', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    timestamp: text('timestamp').notNull(),
    requestedModel: text('requested_model').notNull(),
    effectiveProfile: text('effective_profile').notNull(),
    selectedProvider: text('selected_provider'),
    selectedModel: text('selected_model'),
    estimatedInputTokens: integer('estimated_input_tokens').notNull().default(0),
    actualInputTokens: integer('actual_input_tokens').notNull().default(0),
    actualOutputTokens: integer('actual_output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    failoverCount: integer('failover_count').notNull().default(0),
    stream: integer('stream', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    routingExplanation: text('routing_explanation'),
  },
  (table) => [
    index('idx_requests_timestamp').on(table.timestamp),
    index('idx_requests_status').on(table.status),
    index('idx_requests_provider').on(table.selectedProvider),
  ]
);

export const requestAttempts = sqliteTable(
  'request_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    canonicalModelId: text('canonical_model_id').notNull(),
    outcome: text('outcome').notNull(),
    latencyMs: integer('latency_ms').notNull().default(0),
    errorCategory: text('error_category'),
    statusCode: integer('status_code'),
    reason: text('reason').notNull(),
    timestamp: text('timestamp').notNull(),
  },
  (table) => [index('idx_attempts_request').on(table.requestId)]
);

export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    canonicalModelId: text('canonical_model_id').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    recordedAt: text('recorded_at').notNull(),
  },
  (table) => [index('idx_usage_recorded_at').on(table.recordedAt)]
);

export const dailyUsage = sqliteTable(
  'daily_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dateKey: text('date_key').notNull(),
    providerId: text('provider_id').notNull(),
    canonicalModelId: text('canonical_model_id').notNull(),
    requestCount: integer('request_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    failoverCount: integer('failover_count').notNull().default(0),
    rateLimitCount: integer('rate_limit_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalLatencyMs: integer('total_latency_ms').notNull().default(0),
  },
  (table) => [
    uniqueIndex('idx_daily_usage_unique').on(table.dateKey, table.providerId, table.canonicalModelId),
  ]
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (table) => [uniqueIndex('idx_api_keys_hash').on(table.keyHash)]
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  immutable: integer('immutable', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: text('timestamp').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    details: text('details').notNull(),
  },
  (table) => [index('idx_audit_timestamp').on(table.timestamp)]
);
