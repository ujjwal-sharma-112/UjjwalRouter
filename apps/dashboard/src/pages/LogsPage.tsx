import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { apiClient } from '../api/client.ts';

interface RequestLogItem {
  id: string;
  timestamp: string;
  requestedModel: string;
  effectiveProfile: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  actualInputTokens: number;
  actualOutputTokens: number;
  estimatedInputTokens: number;
  latencyMs: number;
  failoverCount: number;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export function LogsPage() {
  const [items, setItems] = useState<RequestLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pageSize = 25;

  useEffect(() => {
    const load = async () => {
      try {
        const qs = new URLSearchParams({
          limit: String(pageSize),
          offset: String(page * pageSize),
        });
        if (statusFilter) qs.set('status', statusFilter);
        if (providerFilter.trim()) qs.set('providerId', providerFilter.trim());
        if (profileFilter.trim()) qs.set('profile', profileFilter.trim());

        const res = await apiClient.request<{ total: number; items: RequestLogItem[] }>(
          `/api/admin/logs?${qs.toString()}`
        );
        setItems(res.items);
        setTotal(res.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load request logs');
      }
    };
    void load();
  }, [statusFilter, providerFilter, profileFilter, page]);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Request Logs</Typography>
        <Typography variant="body2" color="text.secondary">
          Prompt contents are omitted by default for privacy and secret hygiene.
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel id="log-status-label">Status</InputLabel>
            <Select
              labelId="log-status-label"
              label="Status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(0);
              }}
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="success">Success</MenuItem>
              <MenuItem value="error">Error</MenuItem>
            </Select>
          </FormControl>

          <TextField
            size="small"
            label="Provider"
            value={providerFilter}
            onChange={(e) => {
              setProviderFilter(e.target.value);
              setPage(0);
            }}
            placeholder="google / openrouter / groq"
          />

          <TextField
            size="small"
            label="Profile"
            value={profileFilter}
            onChange={(e) => {
              setProfileFilter(e.target.value);
              setPage(0);
            }}
            placeholder="auto-coding / auto-long"
          />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <div tabIndex={0} role="region" aria-label="Request logs table" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Timestamp</th>
                <th>Profile</th>
                <th>Provider</th>
                <th>Model</th>
                <th>In Tokens</th>
                <th>Out Tokens</th>
                <th>Latency</th>
                <th>Failovers</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={11}>No matching request logs.</td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id}>
                    <td className="ur-mono">{item.id.slice(0, 14)}</td>
                    <td className="ur-mono">{new Date(item.timestamp).toLocaleString()}</td>
                    <td className="ur-mono">{item.effectiveProfile}</td>
                    <td>{item.selectedProvider ?? '—'}</td>
                    <td className="ur-mono">{item.selectedModel ?? item.requestedModel}</td>
                    <td className="ur-mono">
                      {(item.actualInputTokens || item.estimatedInputTokens).toLocaleString()}
                    </td>
                    <td className="ur-mono">{item.actualOutputTokens.toLocaleString()}</td>
                    <td className="ur-mono">{item.latencyMs} ms</td>
                    <td className="ur-mono">{item.failoverCount}</td>
                    <td>
                      <Chip
                        size="small"
                        label={item.status}
                        color={item.status === 'success' ? 'success' : 'error'}
                      />
                    </td>
                    <td>{item.errorMessage ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary">
            Showing {items.length} of {total} requests
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              type="button"
              size="small"
              variant="outlined"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="small"
              variant="outlined"
              disabled={(page + 1) * pageSize >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Stack>
  );
}
