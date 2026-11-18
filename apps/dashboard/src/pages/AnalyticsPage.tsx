import { useEffect, useState } from 'react';
import { Alert, Box, Grid2 as Grid, Paper, Stack, Typography } from '@mui/material';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiClient } from '../api/client.ts';

interface AnalyticsData {
  totals: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgLatencyMs: number;
    failoverEvents: number;
    rateLimitEvents: number;
  };
  requestsOverTime: Array<{
    date: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    failovers: number;
    rateLimits: number;
    avgLatencyMs: number;
  }>;
  byProvider: Array<{
    providerId: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
  }>;
  byModel: Array<{
    modelId: string;
    providerId: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
  }>;
}

export function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await apiClient.request<AnalyticsData>('/api/admin/analytics?days=30');
        setData(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      }
    };
    void load();
  }, []);

  if (error) return <Alert severity="error">{error}</Alert>;

  const series = data?.requestsOverTime ?? [];
  const providers = data?.byProvider ?? [];
  const models = data?.byModel ?? [];

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Usage & Reliability Analytics (30 Days)</Typography>
        <Typography variant="body2" color="text.secondary">
          Rate-limit events: {data?.totals.rateLimitEvents ?? 0} • Failover events:{' '}
          {data?.totals.failoverEvents ?? 0} • Error rate:{' '}
          {data && data.totals.totalRequests > 0
            ? `${((data.totals.failedRequests / data.totals.totalRequests) * 100).toFixed(1)}%`
            : '0.0%'}
        </Typography>
      </Box>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 6 }}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Requests & Errors Over Time
            </Typography>
            <Box sx={{ width: '100%', height: 280 }}>
              <ResponsiveContainer>
                <AreaChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" />
                  <XAxis dataKey="date" stroke="#94a3b8" />
                  <YAxis stroke="#94a3b8" />
                  <Tooltip />
                  <Legend />
                  <Area type="monotone" dataKey="requests" stroke="#10b981" fill="rgba(16,185,129,0.22)" />
                  <Area type="monotone" dataKey="errors" stroke="#ef4444" fill="rgba(239,68,68,0.22)" />
                </AreaChart>
              </ResponsiveContainer>
            </Box>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Tokens Over Time
            </Typography>
            <Box sx={{ width: '100%', height: 280 }}>
              <ResponsiveContainer>
                <AreaChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" />
                  <XAxis dataKey="date" stroke="#94a3b8" />
                  <YAxis stroke="#94a3b8" />
                  <Tooltip />
                  <Legend />
                  <Area type="monotone" dataKey="inputTokens" stroke="#38bdf8" fill="rgba(56,189,248,0.22)" />
                  <Area type="monotone" dataKey="outputTokens" stroke="#a78bfa" fill="rgba(167,139,250,0.22)" />
                </AreaChart>
              </ResponsiveContainer>
            </Box>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Provider Usage & Errors
            </Typography>
            <Box sx={{ width: '100%', height: 280 }}>
              <ResponsiveContainer>
                <BarChart data={providers}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" />
                  <XAxis dataKey="providerId" stroke="#94a3b8" />
                  <YAxis stroke="#94a3b8" />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="requests" fill="#10b981" />
                  <Bar dataKey="errors" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Latency, Rate-Limits & Failovers
            </Typography>
            <Box sx={{ width: '100%', height: 280 }}>
              <ResponsiveContainer>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" />
                  <XAxis dataKey="date" stroke="#94a3b8" />
                  <YAxis stroke="#94a3b8" />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="avgLatencyMs" stroke="#38bdf8" name="Avg Latency (ms)" />
                  <Line type="monotone" dataKey="rateLimits" stroke="#f59e0b" name="Rate Limits" />
                  <Line type="monotone" dataKey="failovers" stroke="#f472b6" name="Failovers" />
                </LineChart>
              </ResponsiveContainer>
            </Box>
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Model Usage Breakdown
        </Typography>
        <div tabIndex={0} role="region" aria-label="Model usage breakdown" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Requests</th>
                <th>Errors</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Avg Latency</th>
              </tr>
            </thead>
            <tbody>
              {models.length === 0 ? (
                <tr>
                  <td colSpan={7}>No usage data recorded yet.</td>
                </tr>
              ) : (
                models.map((m) => (
                  <tr key={`${m.providerId}:${m.modelId}`}>
                    <th scope="row" className="ur-mono">
                      {m.modelId}
                    </th>
                    <td>{m.providerId}</td>
                    <td className="ur-mono">{m.requests}</td>
                    <td className="ur-mono">{m.errors}</td>
                    <td className="ur-mono">{m.inputTokens.toLocaleString()}</td>
                    <td className="ur-mono">{m.outputTokens.toLocaleString()}</td>
                    <td className="ur-mono">{m.avgLatencyMs} ms</td>
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
