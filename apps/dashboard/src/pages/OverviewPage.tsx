import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid2 as Grid,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { apiClient } from '../api/client.ts';

interface OverviewData {
  strictFreeOnly: boolean;
  defaultRoutingProfile: string;
  activeVerifiedModels: number;
  totalDiscoveredModels: number;
  totals: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgLatencyMs: number;
    failoverEvents: number;
  };
  providers: Array<{
    id: string;
    displayName: string;
    enabled: boolean;
    configured: boolean;
    healthy: boolean;
    healthStatus: string;
    latencyMs: number | null;
    verifiedModelCount: number;
  }>;
  recentRequests: Array<{
    id: string;
    timestamp: string;
    effectiveProfile: string;
    selectedProvider: string | null;
    selectedModel: string | null;
    actualInputTokens: number;
    actualOutputTokens: number;
    latencyMs: number;
    status: string;
  }>;
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Paper sx={{ p: 2.25, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {label}
      </Typography>
      <Typography variant="h5" sx={{ mt: 0.75, fontWeight: 700 }} className="ur-mono">
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          {sub}
        </Typography>
      )}
    </Paper>
  );
}

export function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.request<OverviewData>('/api/admin/overview');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load overview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={2}>
        <Box>
          <Typography variant="h5">Router Overview</Typography>
          <Typography variant="body2" color="text.secondary">
            Active profile: <strong className="ur-mono">{data?.defaultRoutingProfile ?? 'auto'}</strong>
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Chip
            icon={<LockOutlinedIcon fontSize="small" />}
            label="STRICT_FREE_ONLY=true (Immutable)"
            color="success"
            variant="outlined"
          />
          <Button
            type="button"
            variant="outlined"
            startIcon={<RefreshOutlinedIcon />}
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <MetricCard label="Total Requests" value={data?.totals.totalRequests ?? 0} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <MetricCard
            label="Success / Failed"
            value={`${data?.totals.successfulRequests ?? 0} / ${data?.totals.failedRequests ?? 0}`}
            sub={`Avg latency: ${data?.totals.avgLatencyMs ?? 0} ms`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <MetricCard
            label="Tokens (In / Out)"
            value={`${(data?.totals.totalInputTokens ?? 0).toLocaleString()} / ${(data?.totals.totalOutputTokens ?? 0).toLocaleString()}`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <MetricCard
            label="Verified Free Models"
            value={data?.activeVerifiedModels ?? 0}
            sub={`Out of ${data?.totalDiscoveredModels ?? 0} discovered`}
          />
        </Grid>
      </Grid>

      <Paper sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Provider Health & Free Capacity
        </Typography>
        <div tabIndex={0} role="region" aria-label="Provider health summary" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Health</th>
                <th>Verified Models</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {(data?.providers ?? []).map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.displayName}</th>
                  <td>
                    <Chip
                      size="small"
                      label={p.enabled ? 'Enabled' : 'Disabled'}
                      color={p.enabled ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </td>
                  <td>
                    <Chip
                      size="small"
                      label={p.healthStatus}
                      color={
                        p.healthStatus === 'healthy'
                          ? 'success'
                          : p.healthStatus === 'degraded'
                            ? 'warning'
                            : 'default'
                      }
                    />
                  </td>
                  <td className="ur-mono">{p.verifiedModelCount}</td>
                  <td className="ur-mono">{p.latencyMs !== null ? `${p.latencyMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Paper>

      <Paper sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Recent Activity
        </Typography>
        <div tabIndex={0} role="region" aria-label="Recent routed requests" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Time</th>
                <th>Profile</th>
                <th>Provider / Model</th>
                <th>Tokens (In / Out)</th>
                <th>Latency</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentRequests ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7}>No requests recorded yet.</td>
                </tr>
              ) : (
                (data?.recentRequests ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="ur-mono">{r.id.slice(0, 16)}</td>
                    <td className="ur-mono">{new Date(r.timestamp).toLocaleString()}</td>
                    <td className="ur-mono">{r.effectiveProfile}</td>
                    <td className="ur-mono">{r.selectedModel ?? 'none'}</td>
                    <td className="ur-mono">
                      {r.actualInputTokens} / {r.actualOutputTokens}
                    </td>
                    <td className="ur-mono">{r.latencyMs} ms</td>
                    <td>
                      <Chip
                        size="small"
                        label={r.status}
                        color={r.status === 'success' ? 'success' : 'error'}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Paper>
    </Stack>
  );
}
