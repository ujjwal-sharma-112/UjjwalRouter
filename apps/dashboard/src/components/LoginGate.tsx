import { useId, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';

interface LoginGateProps {
  configured: boolean;
  onLogin: (token: string) => Promise<void>;
}

export function LoginGate({ configured, onLogin }: LoginGateProps) {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const helpId = useId();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) {
      setError('Enter your DASHBOARD_ADMIN_TOKEN to unlock the control plane.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(token.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        p: 2,
        background: 'radial-gradient(circle at top, rgba(16,185,129,0.12), transparent 55%), #0b0f17',
      }}
    >
      <Paper sx={{ maxWidth: 440, width: '100%', p: 4 }}>
        <Stack spacing={2.5} component="form" method="POST" onSubmit={handleSubmit}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <LockOutlinedIcon color="primary" />
            <Box>
              <Typography variant="h5">UjjwalRouter Control Plane</Typography>
              <Typography variant="body2" color="text.secondary">
                Self-hosted free-only multi-provider LLM router
              </Typography>
            </Box>
          </Stack>

          <Alert icon={<VerifiedUserOutlinedIcon />} severity="success" variant="outlined">
            <strong>STRICT_FREE_ONLY=true</strong> — Zero paid inference. Localhost-first session.
          </Alert>

          {!configured && (
            <Alert severity="warning">
              <code>DASHBOARD_ADMIN_TOKEN</code> is not set in <code>.env</code>. Configure it on the
              host and restart UjjwalRouter to sign in.
            </Alert>
          )}

          {error && (
            <Alert severity="error" role="status" aria-live="polite">
              {error}
            </Alert>
          )}

          <TextField
            id={inputId}
            name="adminToken"
            label="Dashboard Admin Token"
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              if (error) setError(null);
            }}
            required
            fullWidth
            disabled={!configured || submitting}
            helperText="Matches DASHBOARD_ADMIN_TOKEN in your host .env file."
            FormHelperTextProps={{ id: helpId }}
            inputProps={{
              autoComplete: 'current-password',
              autoCorrect: 'off',
              autoCapitalize: 'none',
              spellCheck: false,
              'aria-describedby': helpId,
            }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    type="button"
                    aria-label={showToken ? 'Hide admin token' : 'Show admin token'}
                    aria-pressed={showToken}
                    onClick={() => setShowToken((prev) => !prev)}
                    edge="end"
                  >
                    {showToken ? <VisibilityOffOutlinedIcon /> : <VisibilityOutlinedIcon />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />

          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={!configured || submitting}
            fullWidth
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
