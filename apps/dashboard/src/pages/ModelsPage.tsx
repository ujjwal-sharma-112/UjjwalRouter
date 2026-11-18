import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { apiClient } from '../api/client.ts';

interface ModelEntry {
  canonicalId: string;
  id: string;
  providerId: string;
  displayName: string;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens: number;
  codingCapability: string;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  freeEligibility: string;
  availabilityStatus: string;
  policyAllowed: boolean;
  policyReasons: string[];
}

export function ModelsPage() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [minContext, setMinContext] = useState<number>(0);
  const [coding, setCoding] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [tools, setTools] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [availableOnly, setAvailableOnly] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const qs = new URLSearchParams();
        if (minContext > 0) qs.set('minContext', String(minContext));
        if (coding) qs.set('coding', 'true');
        if (reasoning) qs.set('reasoning', 'true');
        if (tools) qs.set('tools', 'true');
        if (verifiedOnly) qs.set('verifiedOnly', 'true');
        if (availableOnly) qs.set('availableOnly', 'true');
        const res = await apiClient.request<{ models: ModelEntry[] }>(
          `/api/admin/models?${qs.toString()}`
        );
        setModels(res.models);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load models');
      }
    };
    void load();
  }, [minContext, coding, reasoning, tools, verifiedOnly, availableOnly]);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Discovered Models & Free Verification</Typography>
        <Typography variant="body2" color="text.secondary">
          Only FREE_VERIFIED models are eligible for routing. Context windows reflect the lowest verified limit.
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
          <Chip
            label="All Contexts"
            clickable
            color={minContext === 0 ? 'primary' : 'default'}
            onClick={() => setMinContext(0)}
          />
          <Chip
            label="512K+ Context"
            clickable
            color={minContext === 524_288 ? 'primary' : 'default'}
            onClick={() => setMinContext(minContext === 524_288 ? 0 : 524_288)}
          />
          <Chip
            label="1M+ Context"
            clickable
            color={minContext === 1_048_576 ? 'primary' : 'default'}
            onClick={() => setMinContext(minContext === 1_048_576 ? 0 : 1_048_576)}
          />
          <FormControlLabel
            control={<Switch checked={coding} onChange={(e) => setCoding(e.target.checked)} />}
            label="Coding"
          />
          <FormControlLabel
            control={<Switch checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />}
            label="Reasoning"
          />
          <FormControlLabel
            control={<Switch checked={tools} onChange={(e) => setTools(e.target.checked)} />}
            label="Tool Calling"
          />
          <FormControlLabel
            control={<Switch checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />}
            label="Free Verified"
          />
          <FormControlLabel
            control={<Switch checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} />}
            label="Available"
          />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <div tabIndex={0} role="region" aria-label="Discovered models table" className="ur-table-region">
          <table className="ur-data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Advertised Ctx</th>
                <th>Effective Ctx</th>
                <th>Max Output</th>
                <th>Coding</th>
                <th>Tools</th>
                <th>Verification</th>
                <th>Availability</th>
              </tr>
            </thead>
            <tbody>
              {models.length === 0 ? (
                <tr>
                  <td colSpan={9}>No models match the active filters.</td>
                </tr>
              ) : (
                models.map((m) => (
                  <tr key={m.canonicalId}>
                    <th scope="row" className="ur-mono">
                      {m.id}
                    </th>
                    <td>{m.providerId}</td>
                    <td className="ur-mono">{m.contextWindow.toLocaleString()}</td>
                    <td className="ur-mono">{m.effectiveContextWindow.toLocaleString()}</td>
                    <td className="ur-mono">{m.maxOutputTokens.toLocaleString()}</td>
                    <td>{m.codingCapability}</td>
                    <td>{m.supportsTools ? 'Yes' : 'No'}</td>
                    <td>
                      <Chip
                        size="small"
                        label={m.freeEligibility}
                        color={m.policyAllowed ? 'success' : m.freeEligibility === 'PAID' ? 'error' : 'warning'}
                        title={m.policyReasons.join(' ')}
                      />
                    </td>
                    <td>
                      <Chip
                        size="small"
                        label={m.availabilityStatus}
                        color={m.availabilityStatus === 'AVAILABLE' ? 'success' : 'default'}
                        variant="outlined"
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
