import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Grid2 as Grid,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SearchIcon from '@mui/icons-material/Search';
import CodeIcon from '@mui/icons-material/Code';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';

interface CodeChunk {
  id: string;
  file: string;
  tag: string;
  x: number;
  y: number;
  desc: string;
  lines: string;
}

const REPO_CHUNKS: CodeChunk[] = [
  { id: 'auth-1', file: 'src/security/auth.ts', tag: 'Auth', x: 0.22, y: 0.28, desc: 'Bearer token verification & expiration check', lines: 'lines 20-55' },
  { id: 'auth-2', file: 'src/security/secrets.ts', tag: 'Auth', x: 0.26, y: 0.35, desc: 'API key hash encryption & secrets mask', lines: 'lines 12-40' },
  { id: 'db-1', file: 'src/database/schema.ts', tag: 'DB', x: 0.78, y: 0.22, desc: 'Drizzle ORM schema & table definitions', lines: 'lines 1-80' },
  { id: 'db-2', file: 'src/database/connection.ts', tag: 'DB', x: 0.82, y: 0.30, desc: 'SQLite WAL mode & database connection', lines: 'lines 15-45' },
  { id: 'rate-1', file: 'src/core/rate-limiter/rate-limiter.ts', tag: 'Core', x: 0.44, y: 0.76, desc: 'Sliding window request rate limiter', lines: 'lines 1-60' },
  { id: 'fail-1', file: 'src/core/failover/circuit-breaker.ts', tag: 'Core', x: 0.50, y: 0.82, desc: 'Circuit breaker failure threshold tracker', lines: 'lines 30-90' },
  { id: 'embed-1', file: 'src/core/embeddings/embedding-coordinator.ts', tag: 'Vector', x: 0.32, y: 0.52, desc: 'Ollama local routing & model aliasing', lines: 'lines 1-85' },
  { id: 'route-1', file: 'src/api/routes/embeddings.ts', tag: 'Vector', x: 0.38, y: 0.46, desc: 'OpenAI-compatible embeddings HTTP route', lines: 'lines 1-65' },
  { id: 'ui-1', file: 'apps/dashboard/OverviewPage.tsx', tag: 'UI', x: 0.86, y: 0.82, desc: 'React dashboard analytics charts', lines: 'lines 40-120' }
];

interface SimulationTask {
  title: string;
  targetX: number;
  targetY: number;
  weights: Record<string, number>;
}

const PRESET_TASKS: SimulationTask[] = [
  {
    title: 'Fix session token expiry check in auth.ts',
    targetX: 0.23,
    targetY: 0.30,
    weights: { 'auth-1': 0.96, 'auth-2': 0.89, 'route-1': 0.62, 'embed-1': 0.45, 'rate-1': 0.30, 'db-1': 0.18, 'db-2': 0.12, 'fail-1': 0.08, 'ui-1': 0.05 }
  },
  {
    title: 'Add a new SQLite migration column for user settings',
    targetX: 0.79,
    targetY: 0.25,
    weights: { 'db-1': 0.97, 'db-2': 0.91, 'auth-2': 0.38, 'rate-1': 0.22, 'auth-1': 0.18, 'embed-1': 0.14, 'route-1': 0.12, 'fail-1': 0.10, 'ui-1': 0.08 }
  },
  {
    title: 'Tune circuit breaker failure threshold and cooldown',
    targetX: 0.47,
    targetY: 0.79,
    weights: { 'fail-1': 0.96, 'rate-1': 0.92, 'route-1': 0.48, 'auth-1': 0.32, 'auth-2': 0.28, 'embed-1': 0.25, 'db-1': 0.15, 'db-2': 0.10, 'ui-1': 0.08 }
  },
  {
    title: 'Route embeddings to local Ollama with fallback',
    targetX: 0.35,
    targetY: 0.49,
    weights: { 'embed-1': 0.98, 'route-1': 0.94, 'auth-1': 0.55, 'auth-2': 0.42, 'rate-1': 0.35, 'fail-1': 0.30, 'db-1': 0.15, 'db-2': 0.10, 'ui-1': 0.08 }
  }
];

export function VectorVisualizerPage() {
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
  const [customQuery, setCustomQuery] = useState('');
  const [taskList, setTaskList] = useState<SimulationTask[]>(PRESET_TASKS);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeTask = taskList[selectedTaskIndex] ?? PRESET_TASKS[0]!;

  // Canvas animation logic
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animFrame: number;
    let pulse = 0;
    let curX = activeTask.targetX;
    let curY = activeTask.targetY;

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }

      const w = canvas.width;
      const h = canvas.height;

      ctx.clearRect(0, 0, w, h);

      // Background grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 36) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += 36) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Smooth query point transition
      curX += (activeTask.targetX - curX) * 0.12;
      curY += (activeTask.targetY - curY) * 0.12;
      pulse = (pulse + 0.05) % (Math.PI * 2);

      const qX = curX * w;
      const qY = curY * h;

      // Draw code nodes & connecting rays
      REPO_CHUNKS.forEach((chunk) => {
        const cX = chunk.x * w;
        const cY = chunk.y * h;
        const score = activeTask.weights[chunk.id] || 0.1;
        const isMatched = score >= 0.7;

        if (isMatched) {
          // Animated dotted ray
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = `rgba(16, 185, 129, ${score * 0.8})`;
          ctx.lineWidth = 2;
          ctx.moveTo(qX, qY);
          ctx.lineTo(cX, cY);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Node dot
        ctx.beginPath();
        ctx.arc(cX, cY, isMatched ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isMatched ? '#10b981' : '#64748b';
        ctx.shadowColor = isMatched ? '#10b981' : 'transparent';
        ctx.shadowBlur = isMatched ? 12 : 0;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Label
        ctx.fillStyle = isMatched ? '#f8fafc' : '#64748b';
        ctx.font = isMatched ? 'bold 11px monospace' : '10px monospace';
        ctx.fillText(chunk.file.split('/').pop() || '', cX + 10, cY + 4);
      });

      // Draw Query Vector (Gold beacon)
      const pulseRadius = 7 + Math.sin(pulse) * 3;
      ctx.beginPath();
      ctx.arc(qX, qY, pulseRadius + 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(qX, qY, pulseRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#f59e0b';
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#fef08a';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('Task Vector', qX + 14, qY - 6);

      animFrame = requestAnimationFrame(render);
    };

    animFrame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrame);
  }, [activeTask]);

  const handleCustomSubmit = () => {
    if (!customQuery.trim()) return;
    const lower = customQuery.toLowerCase();
    let targetX = 0.5;
    let targetY = 0.5;
    let weights: Record<string, number> = {};

    if (lower.includes('auth') || lower.includes('token') || lower.includes('key')) {
      targetX = 0.24; targetY = 0.31;
      weights = { 'auth-1': 0.96, 'auth-2': 0.90, 'route-1': 0.60 };
    } else if (lower.includes('db') || lower.includes('sql') || lower.includes('migration') || lower.includes('table')) {
      targetX = 0.80; targetY = 0.26;
      weights = { 'db-1': 0.96, 'db-2': 0.91 };
    } else if (lower.includes('rate') || lower.includes('circuit') || lower.includes('failover')) {
      targetX = 0.48; targetY = 0.80;
      weights = { 'fail-1': 0.95, 'rate-1': 0.92 };
    } else {
      targetX = 0.36; targetY = 0.50;
      weights = { 'embed-1': 0.96, 'route-1': 0.92, 'auth-1': 0.70 };
    }

    const newTask: SimulationTask = {
      title: customQuery.trim(),
      targetX,
      targetY,
      weights,
    };

    setTaskList((prev) => [...prev, newTask]);
    setSelectedTaskIndex(taskList.length);
    setCustomQuery('');
  };

  const sortedChunks = [...REPO_CHUNKS].sort(
    (a, b) => (activeTask.weights[b.id] || 0) - (activeTask.weights[a.id] || 0)
  );

  const matchedChunks = sortedChunks.filter((c) => (activeTask.weights[c.id] || 0) >= 0.7);

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1400, mx: 'auto' }}>
      {/* Title & Status */}
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={1} sx={{ mb: 3 }}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1.5}>
            <HubOutlinedIcon color="primary" />
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Vector Flow & RAG Visualizer
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Visualize how local vector embeddings index code chunks and feed UjjwalRouter's auto-coding pipeline.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Chip label="Local Ollama (CPU)" color="success" size="small" variant="outlined" />
          <Chip label="nomic-embed-text (768-D)" color="primary" size="small" />
        </Stack>
      </Stack>

      {/* Task Selection Bar */}
      <Paper sx={{ p: 2, mb: 3, bgcolor: 'background.paper', borderRadius: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.6 }}>
          Select or Enter a Coding Task:
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 1.5, mb: 2 }}>
          {taskList.map((task, idx) => (
            <Button
              key={task.title}
              variant={selectedTaskIndex === idx ? 'contained' : 'outlined'}
              size="small"
              onClick={() => setSelectedTaskIndex(idx)}
              startIcon={<PlayArrowIcon fontSize="small" />}
              sx={{ textTransform: 'none', borderRadius: 2 }}
            >
              {task.title}
            </Button>
          ))}
        </Stack>

        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            fullWidth
            placeholder="Type any custom coding request (e.g., 'Optimize database connection pool')..."
            value={customQuery}
            onChange={(e) => setCustomQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCustomSubmit()}
          />
          <Button variant="contained" onClick={handleCustomSubmit} startIcon={<SearchIcon />}>
            Embed
          </Button>
        </Stack>
      </Paper>

      {/* Visual Workspace Grid */}
      <Grid container spacing={3}>
        {/* 2D Vector Space Canvas */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <Paper sx={{ p: 2.5, borderRadius: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                2D Vector Space Map (Cosine Similarity Search)
              </Typography>
              <Chip label="768-D Vector Space Projection" size="small" variant="outlined" />
            </Stack>

            <Box sx={{ position: 'relative', width: '100%', height: 420, bgcolor: '#0b1120', borderRadius: 1.5, overflow: 'hidden', border: 1, borderColor: 'divider' }}>
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
              <Box sx={{ position: 'absolute', bottom: 10, left: 12, bgcolor: 'rgba(15, 23, 42, 0.85)', px: 1.5, py: 0.5, borderRadius: 1, border: 1, borderColor: 'rgba(255,255,255,0.1)' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  • Green Dot = Code Chunk &nbsp;&nbsp; ★ Gold = Query Vector
                </Typography>
              </Box>
            </Box>

            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 2 }}>
              <Typography variant="caption" color="text.secondary">
                Vectors closer to the gold beacon have highest cosine similarity.
              </Typography>
              <Typography variant="caption" color="success.main" className="ur-mono" sx={{ fontWeight: 600 }}>
                {matchedChunks.length} chunks retrieved (&gt;70% threshold)
              </Typography>
            </Stack>
          </Paper>
        </Grid>

        {/* Breakdown & Injected Prompt */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <Stack spacing={3}>
            {/* Retrieved Chunks Card */}
            <Paper sx={{ p: 2.5, borderRadius: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <CodeIcon fontSize="small" color="primary" />
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    Retrieved Code Chunks
                  </Typography>
                </Stack>
                <Chip label="Similarity Ranked" size="small" color="success" variant="outlined" />
              </Stack>

              <Stack spacing={1.5} sx={{ maxHeight: 240, overflowY: 'auto' }}>
                {sortedChunks.map((chunk) => {
                  const score = activeTask.weights[chunk.id] || 0.1;
                  const pct = Math.round(score * 100);
                  const isMatched = score >= 0.7;

                  return (
                    <Paper
                      key={chunk.id}
                      variant="outlined"
                      sx={{
                        p: 1.5,
                        borderColor: isMatched ? 'success.main' : 'divider',
                        bgcolor: isMatched ? 'rgba(16, 185, 129, 0.05)' : 'transparent',
                        opacity: isMatched ? 1 : 0.6,
                      }}
                    >
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography variant="caption" className="ur-mono" sx={{ fontWeight: 700, color: isMatched ? 'text.primary' : 'text.secondary' }}>
                          {chunk.file}
                        </Typography>
                        <Typography variant="caption" className="ur-mono" color={isMatched ? 'success.main' : 'text.secondary'} sx={{ fontWeight: 700 }}>
                          {pct}% match
                        </Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', my: 0.5 }}>
                        {chunk.desc} ({chunk.lines})
                      </Typography>
                      <LinearProgress
                        variant="determinate"
                        value={pct}
                        color={isMatched ? 'success' : 'inherit'}
                        sx={{ height: 4, borderRadius: 2 }}
                      />
                    </Paper>
                  );
                })}
              </Stack>
            </Paper>

            {/* Synthesized Prompt Card */}
            <Paper sx={{ p: 2.5, borderRadius: 2, bgcolor: '#0f172a', border: 1, borderColor: 'divider' }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5, pb: 1, borderBottom: 1, borderColor: 'rgba(255,255,255,0.1)' }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <AutoFixHighIcon fontSize="small" sx={{ color: '#a855f7' }} />
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, color: '#f8fafc' }}>
                    Prompt Sent to UjjwalRouter
                  </Typography>
                </Stack>
                <Chip label="auto-coding" size="small" sx={{ bgcolor: 'rgba(168, 85, 247, 0.2)', color: '#d8b4fe' }} />
              </Stack>

              <Box sx={{ p: 1.5, bgcolor: '#020617', borderRadius: 1, border: 1, borderColor: '#1e293b', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>
                <Typography variant="caption" sx={{ color: '#60a5fa', display: 'block', mb: 0.5 }}>
                  [SYSTEM] 128K context window ready.
                </Typography>
                <Typography variant="caption" sx={{ color: '#34d399', display: 'block', mb: 0.5 }}>
                  [CONTEXT] {matchedChunks.length} relevant files injected (+~420 tokens)
                </Typography>
                <Typography variant="caption" sx={{ color: '#fef08a', display: 'block', mb: 0.5 }}>
                  [USER] {activeTask.title}
                </Typography>
                <Typography variant="caption" sx={{ color: '#c084fc', display: 'block' }}>
                  ➜ auto-coding generates accurate code without guessing!
                </Typography>
              </Box>
            </Paper>
          </Stack>
        </Grid>
      </Grid>
    </Box>
  );
}
