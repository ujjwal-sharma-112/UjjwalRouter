import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Box, CircularProgress, CssBaseline, ThemeProvider } from '@mui/material';
import { dashboardTheme } from './theme.ts';
import { apiClient, type SessionState } from './api/client.ts';
import { LoginGate } from './components/LoginGate.tsx';
import { Layout } from './components/Layout.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { ProvidersPage } from './pages/ProvidersPage.tsx';
import { ModelsPage } from './pages/ModelsPage.tsx';
import { RoutingPage } from './pages/RoutingPage.tsx';
import { LogsPage } from './pages/LogsPage.tsx';
import { AnalyticsPage } from './pages/AnalyticsPage.tsx';
import { VectorVisualizerPage } from './pages/VectorVisualizerPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await apiClient.getSession();
        apiClient.setCsrfToken(res.csrfToken);
        setSession(res);
      } catch {
        setSession({
          configured: false,
          authenticated: false,
          csrfToken: null,
          strictFreeOnly: true,
        });
      }
    };
    void check();
  }, []);

  const handleLogin = async (token: string) => {
    const next = await apiClient.login(token);
    setSession(next);
  };

  const handleLogout = async () => {
    await apiClient.logout();
    setSession((prev) =>
      prev
        ? { ...prev, authenticated: false, csrfToken: null }
        : { configured: true, authenticated: false, csrfToken: null, strictFreeOnly: true }
    );
  };

  return (
    <ThemeProvider theme={dashboardTheme}>
      <CssBaseline />
      {!session ? (
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          <CircularProgress />
        </Box>
      ) : !session.authenticated ? (
        <LoginGate configured={session.configured} onLogin={handleLogin} />
      ) : (
        <BrowserRouter>
          <Layout onLogout={handleLogout}>
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/providers" element={<ProvidersPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/routing" element={<RoutingPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/vector-flow" element={<VectorVisualizerPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      )}
    </ThemeProvider>
  );
}
