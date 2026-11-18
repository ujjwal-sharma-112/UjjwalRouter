import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import { apiClient } from '../api/client.ts';

interface SettingsResponse {
  strictFreeOnly: boolean;
  strictFreeOnlyImmutable: boolean;
  host: string;
  port: number;
  settings: Array<{ key: string; value: string; immutable: boolean }>;
  apiKeys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    enabled: boolean;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
  auditLogs: Array<{
    id: number;
    timestamp: string;
    actor: string;
    action: string;
    target: string;
    details: string;
  }>;
}

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [retentionDays, setRetentionDays] = useState('30');
  const [safetyMarginPct, setSafetyMarginPct] = useState('0.05');
  const [healthIntervalMs, setHealthIntervalMs] = useState('300000');
  const [newKeyName, setNewKeyName] = useState('');
  const [newlyIssuedKey, setNewlyIssuedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await apiClient.request<SettingsResponse>('/api/admin/settings');
      setData(res);
      const findVal = (k: string, fallback: string) =>
        res.settings.find((s) => s.key === k)?.value ?? fallback;
      setRetentionDays(findVal('log_retention_days', '30'));
      setSafetyMarginPct(findVal('context_safety_margin_pct', '0.05'));
      setHealthIntervalMs(findVal('health_check_interval_ms', '300000'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSaveSettings = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await apiClient.request('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          logRetentionDays: Number.parseInt(retentionDays, 10),
          contextSafetyMarginPct: Number.parseFloat(safetyMarginPct),
          healthCheckIntervalMs: Number.parseInt(healthIntervalMs, 10),
        }),
      });
      setMessage('Runtime settings updated.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    }
  };

  const handleCreateKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!newKeyName.trim()) return;
    setError(null);
    setNewlyIssuedKey(null);
    try {
      const created = await apiClient.request<{ rawKey: string }>('/api/admin/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      setNewlyIssuedKey(created.rawKey);
      setNewKeyName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to issue API key');
    }
  };

  const handleRevokeKey = async (id: string) => {
    setError(null);
    try {
      await apiClient.request(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key');
    }
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Settings & Local API Keys</Typography>
        <Typography variant="body2" color="text.secondary">
          Listening on <span className="ur-mono">{data ? `${data.host}:${data.port}` : '127.0.0.1:8787'}</span>
        </Typography>
      </Box>

      {message && <Alert severity="success" role="status">{message}</Alert>}
      {error && <Alert severity="error" role="status">{error}</Alert>}

      <Paper sx={{ p: 2.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" spacing={2}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <LockOutlinedIcon color="success" />
              <Typography variant="h6">Strict Free-Only Policy</Typography>
              <Chip size="small" color="success" label="IMMUTABLE" />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              STRICT_FREE_ONLY=true cannot be disabled from the dashboard. Paid models and trial credits are permanently rejected.
            </Typography>
          </Box>
          <FormControlLabel
            control={<Switch checked disabled color="success" />}
            label="Enabled (Locked)"
          />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Router Policy & Retention Settings
        </Typography>
        <Stack component="form" method="POST" onSubmit={handleSaveSettings} spacing={2} maxWidth={480}>
          <TextField
            label="Context Safety Margin Ratio (0.0 - 0.5)"
            type="number"
            value={safetyMarginPct}
            onChange={(e) => setSafetyMarginPct(e.target.value)}
            inputProps={{ step: '0.01', min: '0', max: '0.5' }}
          />
          <TextField
            label="Request Log Retention (Days)"
            type="number"
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            inputProps={{ min: '1', max: '3650' }}
          />
          <TextField
            label="Health Check Interval (ms)"
            type="number"
            value={healthIntervalMs}
            onChange={(e) => setHealthIntervalMs(e.target.value)}
            inputProps={{ min: '10000' }}
          />
          <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>
            Save Settings
          </Button>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Client API Keys (for Hermes Agent & OpenAI Clients)
        </Typography>
        <Stack component="form" method="POST" onSubmit={handleCreateKey} direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
          <TextField
            size="small"
            label="New Key Label"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="hermes-agent"
            required
          />
          <Button type="submit" variant="contained" startIcon={<AddIcon />}>
            Generate API Key
          </Button>
        </Stack>

        {newlyIssuedKey && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Copy this API key now — it will never be shown again:{' '}
            <strong className="ur-mono">{newlyIssuedKey}</strong>
          </Alert>
        )}

        <div tabIndex={0} role="region" aria-label="Issued client API keys" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {(data?.apiKeys ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6}>No DB-issued client keys yet (env ROUTER_API_KEYS also accepted).</td>
                </tr>
              ) : (
                (data?.apiKeys ?? []).map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="ur-mono">{k.keyPrefix}...</td>
                    <td>
                      <Chip
                        size="small"
                        label={k.enabled ? 'Active' : 'Revoked'}
                        color={k.enabled ? 'success' : 'default'}
                      />
                    </td>
                    <td className="ur-mono">{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className="ur-mono">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}</td>
                    <td>
                      {k.enabled && (
                        <Button
                          type="button"
                          size="small"
                          color="error"
                          startIcon={<DeleteOutlineIcon />}
                          onClick={() => void handleRevokeKey(k.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Paper>

      <Paper sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Security & Config Audit Log
        </Typography>
        <div tabIndex={0} role="region" aria-label="Audit logs" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {(data?.auditLogs ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="ur-mono">{new Date(a.timestamp).toLocaleString()}</td>
                  <td>{a.actor}</td>
                  <td className="ur-mono">{a.action}</td>
                  <td className="ur-mono">{a.target}</td>
                  <td>{a.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Paper>
    </Stack>
  );
}
