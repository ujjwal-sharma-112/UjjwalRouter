import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  AppBar,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import CloudQueueOutlinedIcon from '@mui/icons-material/CloudQueueOutlined';
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import AltRouteOutlinedIcon from '@mui/icons-material/AltRouteOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import MenuIcon from '@mui/icons-material/Menu';

const DRAWER_WIDTH = 240;

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: <DashboardOutlinedIcon fontSize="small" /> },
  { to: '/providers', label: 'Providers', icon: <CloudQueueOutlinedIcon fontSize="small" /> },
  { to: '/models', label: 'Models', icon: <MemoryOutlinedIcon fontSize="small" /> },
  { to: '/routing', label: 'Routing', icon: <AltRouteOutlinedIcon fontSize="small" /> },
  { to: '/logs', label: 'Request Logs', icon: <ReceiptLongOutlinedIcon fontSize="small" /> },
  { to: '/analytics', label: 'Analytics', icon: <InsightsOutlinedIcon fontSize="small" /> },
  { to: '/vector-flow', label: 'Vector Flow', icon: <HubOutlinedIcon fontSize="small" /> },
  { to: '/settings', label: 'Settings', icon: <SettingsOutlinedIcon fontSize="small" /> },
];

interface LayoutProps {
  children: ReactNode;
  onLogout: () => Promise<void>;
}

export function Layout({ children, onLogout }: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  const drawerContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 1.5 }}>
      <Box sx={{ px: 1.5, py: 2 }}>
        <Typography variant="h6" color="primary.main" className="ur-mono">
          UjjwalRouter
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Free-Only LLM Gateway
        </Typography>
      </Box>

      <List component="nav" aria-label="Dashboard sections" sx={{ flexGrow: 1 }}>
        {NAV_ITEMS.map((item) => {
          const active = location.pathname === item.to;
          return (
            <ListItemButton
              key={item.to}
              component={NavLink}
              to={item.to}
              selected={active}
              onClick={() => setMobileOpen(false)}
              sx={{
                borderRadius: 1.5,
                mb: 0.5,
                '&.Mui-selected': {
                  backgroundColor: 'rgba(16, 185, 129, 0.14)',
                  color: 'primary.main',
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          );
        })}
      </List>

      <Box sx={{ p: 1.5, borderTop: '1px solid rgba(148,163,184,0.16)' }}>
        <Chip
          icon={<LockOutlinedIcon fontSize="small" />}
          label="STRICT_FREE_ONLY"
          color="success"
          variant="outlined"
          size="small"
          sx={{ width: '100%', fontWeight: 700 }}
        />
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          ml: { md: `${DRAWER_WIDTH}px` },
          bgcolor: 'rgba(11, 15, 23, 0.85)',
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid rgba(148, 163, 184, 0.16)',
        }}
      >
        <Toolbar sx={{ justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <IconButton
              color="inherit"
              edge="start"
              aria-label="Open navigation menu"
              onClick={() => setMobileOpen((prev) => !prev)}
              sx={{ display: { md: 'none' } }}
            >
              <MenuIcon />
            </IconButton>
            <Typography variant="subtitle1" fontWeight={600}>
              {NAV_ITEMS.find((i) => i.to === location.pathname)?.label ?? 'Overview'}
            </Typography>
          </Stack>

          <Stack direction="row" spacing={1.5} alignItems="center">
            <Chip
              size="small"
              color="success"
              icon={<LockOutlinedIcon />}
              label="Zero-Cost Enforced"
              sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
            />
            <Button
              type="button"
              size="small"
              color="inherit"
              startIcon={<LogoutOutlinedIcon />}
              onClick={() => void onLogout()}
            >
              Sign out
            </Button>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box component="aside" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH, bgcolor: '#0f1623' },
          }}
        >
          {drawerContent}
        </Drawer>
        <Drawer
          variant="permanent"
          open
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              bgcolor: '#0f1623',
              borderRight: '1px solid rgba(148, 163, 184, 0.16)',
            },
          }}
        >
          {drawerContent}
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, md: 3 }, mt: 8, minWidth: 0 }}>
        {children}
      </Box>
    </Box>
  );
}
