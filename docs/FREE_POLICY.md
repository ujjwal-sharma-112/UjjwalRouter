# Absolute Free-Only Policy (`STRICT_FREE_ONLY`)

`FreeInferencePolicy` (`src/core/policy/free-inference-policy.ts`) is the central security gatekeeper for UjjwalRouter.

## Immutable Configuration Invariant

`STRICT_FREE_ONLY=true` is enforced at two layers:
1. **Startup Config (`src/config/env.ts`)**: Refuses `STRICT_FREE_ONLY=false` at boot.
2. **Database & Admin API (`src/database/repositories/router-repository.ts`, `src/api/routes/admin.ts`)**: Stored with `immutable = true`. Any `PUT /api/admin/settings` request trying to set `strictFreeOnly: false` or `strict_free_only: false` is rejected with `HTTP 403 immutable_free_policy` and logged in `audit_logs`.

## Eligibility Statuses

Every discovered model is assigned one of six statuses:

| Status | Allowed in Production? | Meaning |
| :--- | :---: | :--- |
| `FREE_VERIFIED` | **Yes** | Verified $0 pricing, no billing required, no trial/promotional credits, valid non-expired timestamp & source, safe allowlisted endpoint. |
| `FREE_UNVERIFIED` | No | Missing account non-billing confirmation, missing/expired verification timestamp, or custom unverified endpoint. |
| `PAID` | No | Paid model tier, non-zero token/request/image pricing, or OpenRouter model lacking `:free`. |
| `TRIAL_ONLY` | No | Relies on finite trial or promotional credits (e.g., Hugging Face $0.10/mo credits, NVIDIA default prototyping credits). |
| `QUOTA_EXHAUSTED` | No | Upstream reported daily/monthly free quota exhaustion. |
| `DISABLED` | No | Provider or model disabled, or unsafe endpoint blocked. |

## Policy Verification Checklist

For a model to pass `FreeInferencePolicy.evaluateModel(model)`:
1. `model.providerEnabled === true`
2. `model.freeEligibility === 'FREE_VERIFIED'`
3. `model.billingRequired === false`
4. `model.promotionalCredits === false` and `freeTierType` is not `TRIAL_CREDITS` / `PROMOTIONAL_CREDITS` / `PAID` / `UNVERIFIED`
5. `inputPrice === 0 && outputPrice === 0 && requestPrice === 0 && imagePrice === 0`
6. If `providerId === 'openrouter'`, `model.id.endsWith(':free')`
7. `freeVerifiedAt` is present, valid, and within `VERIFICATION_MAX_AGE_MS` (default 24h), and `verificationExpiresAt` has not elapsed
8. `endpointUrl` passes `validateProviderBaseUrl()` allowlist and SSRF checks
9. `availabilityStatus` is not `UNAVAILABLE` or `COOLDOWN`

## Fail-Closed Behavior

If no `FREE_VERIFIED` model satisfies a request:
- Explicit paid/trial/unverified model requests return `HTTP 403 free_policy_violation`.
- Profile requests (`auto*`) with zero eligible candidates return `HTTP 503 no_eligible_free_models` (or `429 rate_limit_exceeded` if all candidates were rate-limited).
- UjjwalRouter never purchases credits, enables billing, or routes to paid backups.
