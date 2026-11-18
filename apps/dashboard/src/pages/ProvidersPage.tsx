import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { apiClient } from '../api/client.ts';

interface ProviderEntry {
  id: string;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  endpointUrl: string;
  maskedCredential: string | null;
  confirmedFreeEntitlement?: boolean;
  requiresApiKey?: boolean;
  requiresEntitlementConfirmation?: boolean;
  requiresAccountId?: boolean;
  supportsBaseUrl?: boolean;
  maskedAccountId?: string;
  baseUrl?: string;
  priorityRank?: number;
  healthy: boolean;
  healthStatus: string;
  healthMessage: string;
  latencyMs: number | null;
  lastHealthCheck: string | null;
  totalModels: number;
  verifiedModels: number;
  notes?: string;
}

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingProvider, setEditingProvider] = useState<ProviderEntry | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [accountIdInput, setAccountIdInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [confirmEntitlement, setConfirmEntitlement] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.request<{ providers: ProviderEntry[] }>('/api/admin/providers');
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load providers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleDiscover = async () => {
    setLoading(true);
    setStatusMessage(null);
    setError(null);
    try {
      await apiClient.request('/api/admin/providers/discover', { method: 'POST', body: '{}' });
      setStatusMessage('Model discovery and health checks completed across all providers.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
      setLoading(false);
    }
  };

  const handleToggle = async (provider: ProviderEntry) => {
    setError(null);
    setStatusMessage(null);
    try {
      await apiClient.request(`/api/admin/providers/${provider.id}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !provider.enabled }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    }
  };

  const handleSaveCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingProvider) return;
    if ((editingProvider.requiresApiKey ?? true) && !apiKeyInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await apiClient.request(`/api/admin/providers/${editingProvider.id}/credentials`, {
        method: 'POST',
        body: JSON.stringify({
          apiKey: apiKeyInput.trim(),
          ...(editingProvider.requiresAccountId && accountIdInput.trim()
            ? { accountId: accountIdInput.trim() }
            : {}),
          ...(editingProvider.supportsBaseUrl && baseUrlInput.trim()
            ? { baseUrl: baseUrlInput.trim() }
            : {}),
          ...(editingProvider.requiresEntitlementConfirmation
            ? { confirmedFreeEntitlement: confirmEntitlement }
            : {}),
        }),
      });
      setStatusMessage(`Configuration saved for ${editingProvider.displayName}. Credentials are encrypted at rest.`);
      setEditingProvider(null);
      setApiKeyInput('');
      setAccountIdInput('');
      setBaseUrlInput('');
      setConfirmEntitlement(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credential');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={2}>
        <Box>
          <Typography variant="h5">Inference Providers</Typography>
          <Typography variant="body2" color="text.secondary">
            Only providers with verified zero-cost entitlements receive traffic under STRICT_FREE_ONLY.
          </Typography>
        </Box>
        <Button
          type="button"
          variant="contained"
          startIcon={<RefreshOutlinedIcon />}
          onClick={() => void handleDiscover()}
          disabled={loading}
        >
          Run Discovery & Health Check
        </Button>
      </Stack>

      {statusMessage && (
        <Alert severity="success" role="status" aria-live="polite">
          {statusMessage}
        </Alert>
      )}
      {error && (
        <Alert severity="error" role="status" aria-live="polite">
          {error}
        </Alert>
      )}

      <Stack spacing={2}>
        {providers.map((p) => (
          <Paper key={p.id} sx={{ p: 2.5 }}>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              justifyContent="space-between"
              alignItems={{ md: 'center' }}
              spacing={2}
            >
              <Box sx={{ flex: 1 }}>
                <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
                  <Typography variant="h6">{p.displayName}</Typography>
                  <Chip
                    size="small"
                    label={p.healthStatus}
                    color={p.healthy ? 'success' : p.healthStatus === 'degraded' ? 'warning' : 'default'}
                  />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`Verified Free: ${p.verifiedModels} / ${p.totalModels}`}
                    color={p.verifiedModels > 0 ? 'success' : 'default'}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary" className="ur-mono" sx={{ mt: 0.75 }}>
                  {p.endpointUrl}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                  {p.healthMessage || p.notes}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                  {p.priorityRank !== undefined && p.priorityRank < 99 ? `Priority #${p.priorityRank} • ` : ''}
                  {p.supportsBaseUrl ? 'Endpoint: ' : 'Credential: '}
                  <span className="ur-mono">{p.maskedCredential ?? 'Not configured'}</span>
                  {p.maskedAccountId ? ` • Account: ${p.maskedAccountId}` : ''}
                  {' • '}Last check: {p.lastHealthCheck ? new Date(p.lastHealthCheck).toLocaleString() : 'Never'}
                </Typography>
              </Box>

              <Stack direction="row" spacing={1.5} alignItems="center">
                <FormControlLabel
                  control={
                    <Switch
                      checked={p.enabled}
                      onChange={() => void handleToggle(p)}
                      inputProps={{ 'aria-label': `Toggle ${p.displayName}` }}
                    />
                  }
                  label={p.enabled ? 'Enabled' : 'Disabled'}
                />
                <Button
                  type="button"
                  variant="outlined"
                  startIcon={<KeyOutlinedIcon />}
                  onClick={() => {
                    setEditingProvider(p);
                    setApiKeyInput('');
                    setAccountIdInput('');
                    setBaseUrlInput(p.baseUrl ?? p.endpointUrl ?? '');
                    setConfirmEntitlement(Boolean(p.confirmedFreeEntitlement));
                  }}
                >
                  {p.requiresApiKey === false ? 'Configure URL' : 'Configure Key'}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ))}
      </Stack>

      <Dialog open={Boolean(editingProvider)} onClose={() => setEditingProvider(null)} fullWidth maxWidth="sm">
        <form method="POST" onSubmit={handleSaveCredentials}>
          <DialogTitle>Configure {editingProvider?.displayName}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Alert severity="info">
                Credentials are encrypted at rest and persisted across restarts; full keys are never returned after saving.
              </Alert>
              {editingProvider?.requiresAccountId && (
                <TextField
                  label="Cloudflare Account ID"
                  value={accountIdInput}
                  onChange={(e) => setAccountIdInput(e.target.value)}
                  required={!editingProvider.maskedAccountId}
                  placeholder={editingProvider.maskedAccountId ? `Saved (${editingProvider.maskedAccountId})` : 'e.g. 023e105f4ecef8ad9ca31a8372d0c353'}
                  fullWidth
                  inputProps={{
                    autoComplete: 'off',
                    autoCorrect: 'off',
                    autoCapitalize: 'none',
                    spellCheck: false,
                  }}
                />
              )}
              {editingProvider?.supportsBaseUrl && (
                <TextField
                  label="Local Loopback Base URL"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  required
                  placeholder="http://127.0.0.1:11434"
                  fullWidth
                  inputProps={{
                    autoComplete: 'off',
                    autoCorrect: 'off',
                    autoCapitalize: 'none',
                    spellCheck: false,
                  }}
                />
              )}
              {(editingProvider?.requiresApiKey ?? true) && (
                <TextField
                  label={editingProvider?.requiresAccountId ? 'API Token' : 'Provider API Key'}
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  required={editingProvider?.requiresApiKey ?? true}
                  fullWidth
                  inputProps={{
                    autoComplete: 'off',
                    autoCorrect: 'off',
                    autoCapitalize: 'none',
                    spellCheck: false,
                  }}
                />
              )}
              {editingProvider?.requiresEntitlementConfirmation && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={confirmEntitlement}
                      onChange={(e) => setConfirmEntitlement(e.target.checked)}
                    />
                  }
                  label="I verify this account/project uses ONLY a permanent zero-cost tier with NO billing method or finite trial credits."
                />
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button type="button" onClick={() => setEditingProvider(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={saving}>
              {saving ? 'Saving...' : 'Save & Verify'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
