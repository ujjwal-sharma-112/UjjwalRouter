import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  Grid2 as Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { apiClient } from '../api/client.ts';

interface RoutingState {
  strictFreeOnly: boolean;
  defaultRoutingProfile: string;
  providerPriority: string[];
  profiles: Array<{ id: string; displayName: string; description: string }>;
  recentDecisions: Array<{
    requestId: string;
    timestamp: string;
    requestedModel: string;
    effectiveProfile: string;
    selectedModel: string | null;
    failoverCount: number;
    latencyMs: number;
    status: string;
    explanation: string | null;
  }>;
}

export function RoutingPage() {
  const [state, setState] = useState<RoutingState | null>(null);
  const [selectedProfile, setSelectedProfile] = useState('auto');
  const [priority, setPriority] = useState<string[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await apiClient.request<RoutingState>('/api/admin/routing');
      setState(res);
      setSelectedProfile(res.defaultRoutingProfile);
      setPriority(res.providerPriority);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load routing configuration');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const movePriority = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= priority.length) return;
    const next = [...priority];
    const tmp = next[idx]!;
    next[idx] = next[target]!;
    next[target] = tmp;
    setPriority(next);
  };

  const handleSave = async () => {
    setError(null);
    setSavedMsg(null);
    try {
      await apiClient.request('/api/admin/routing', {
        method: 'PUT',
        body: JSON.stringify({
          defaultRoutingProfile: selectedProfile,
          providerPriority: priority,
        }),
      });
      setSavedMsg('Routing preferences saved. STRICT_FREE_ONLY remains permanently enforced.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save routing preferences');
    }
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Intelligent Routing Engine</Typography>
        <Typography variant="body2" color="text.secondary">
          Configure task profiles and provider preference order without ever weakening free-only enforcement.
        </Typography>
      </Box>

      {savedMsg && <Alert severity="success" role="status">{savedMsg}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Default Routing Profile
            </Typography>
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel id="routing-profile-label">Profile</InputLabel>
              <Select
                labelId="routing-profile-label"
                label="Profile"
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
              >
                {(state?.profiles ?? []).map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.id} — {p.displayName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {state?.profiles.find((p) => p.id === selectedProfile)?.description}
            </Typography>
            <Button type="button" variant="contained" onClick={() => void handleSave()}>
              Save Routing Preferences
            </Button>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Provider Priority Order
            </Typography>
            <Stack spacing={1}>
              {priority.map((providerId, idx) => (
                <Stack
                  key={providerId}
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  sx={{ p: 1, borderRadius: 1.5, border: '1px solid rgba(148,163,184,0.16)' }}
                >
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Chip size="small" label={`#${idx + 1}`} className="ur-mono" />
                    <Typography className="ur-mono">{providerId}</Typography>
                  </Stack>
                  <Stack direction="row" spacing={0.5}>
                    <Button
                      type="button"
                      size="small"
                      disabled={idx === 0}
                      onClick={() => movePriority(idx, -1)}
                      aria-label={`Move ${providerId} up`}
                    >
                      <ArrowUpwardIcon fontSize="small" />
                    </Button>
                    <Button
                      type="button"
                      size="small"
                      disabled={idx === priority.length - 1}
                      onClick={() => movePriority(idx, 1)}
                      aria-label={`Move ${providerId} down`}
                    >
                      <ArrowDownwardIcon fontSize="small" />
                    </Button>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Recent Model Selection Explanations
        </Typography>
        <div tabIndex={0} role="region" aria-label="Routing decision explanations" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Profile</th>
                <th>Selected Model</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              {(state?.recentDecisions ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4}>No routing decisions logged yet.</td>
                </tr>
              ) : (
                (state?.recentDecisions ?? []).map((d) => (
                  <tr key={d.requestId}>
                    <td className="ur-mono">{new Date(d.timestamp).toLocaleTimeString()}</td>
                    <td className="ur-mono">{d.effectiveProfile}</td>
                    <td className="ur-mono">{d.selectedModel ?? 'rejected'}</td>
                    <td>{d.explanation ?? '—'}</td>
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
