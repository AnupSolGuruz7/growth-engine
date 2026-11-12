import {
  AppstoreOutlined,
  BarChartOutlined,
  BulbOutlined,
  CommentOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LaptopOutlined,
  MenuOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, DatePicker, Drawer, Grid, Layout, Menu, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { AddSiteModal } from './components/AddSiteModal';
import { PRESETS, presetRange } from './dates';
import { useCurrentSite } from './hooks';
import { useDashboard } from './store';

interface NavItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  /** Uses the date range in the header. */
  dated?: boolean;
}

/** Grouped by job: read the numbers, act on them, configure. */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Analytics',
    items: [
      { key: '/', icon: <BarChartOutlined />, label: 'Overview', dated: true },
      { key: '/realtime', icon: <ThunderboltOutlined />, label: 'Realtime' },
      { key: '/pages', icon: <FileTextOutlined />, label: 'Pages', dated: true },
      { key: '/sources', icon: <GlobalOutlined />, label: 'Sources', dated: true },
      { key: '/events', icon: <AppstoreOutlined />, label: 'Events', dated: true },
      { key: '/devices', icon: <LaptopOutlined />, label: 'Devices', dated: true },
    ],
  },
  {
    title: 'Grow',
    items: [
      { key: '/seo', icon: <SearchOutlined />, label: 'SEO audit' },
      { key: '/growth', icon: <BulbOutlined />, label: 'Growth suggestions' },
      { key: '/ask', icon: <CommentOutlined />, label: 'Ask AI' },
    ],
  },
  { title: 'Settings', items: [{ key: '/sites', icon: <SettingOutlined />, label: 'Sites & install' }] },
];
const ALL = NAV_GROUPS.flatMap((g) => g.items);

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="GrowthOS home">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect width="26" height="26" rx="7" fill="#2a78d6" />
        <rect x="6" y="14" width="3.2" height="6" rx="1.2" fill="#fff" opacity="0.7" />
        <rect x="11.4" y="10" width="3.2" height="10" rx="1.2" fill="#fff" opacity="0.85" />
        <rect x="16.8" y="6" width="3.2" height="14" rx="1.2" fill="#fff" />
      </svg>
      <span>GrowthOS</span>
    </Link>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const items: MenuProps['items'] = NAV_GROUPS.map((g) => ({
    type: 'group' as const,
    key: g.title,
    label: g.title,
    children: g.items.map((n) => ({ key: n.key, icon: n.icon, label: <Link to={n.key} onClick={onNavigate}>{n.label}</Link> })),
  }));
  return <Menu mode="inline" selectedKeys={[pathname]} className="side-nav" items={items} />;
}

function DateControls({ compact }: { compact?: boolean }) {
  const { site } = useCurrentSite();
  const { preset, custom, compare, setPreset, setCustom, setCompare } = useDashboard();
  const tz = site?.timezone ?? 'UTC';
  const range = preset === 'custom' && custom ? custom : presetRange(preset === 'custom' ? '30d' : preset, tz);
  return (
    <Space wrap size={8} className="date-controls">
      <Select
        value={preset}
        style={{ width: compact ? 140 : 150 }}
        aria-label="Date range"
        onChange={(v) => (v === 'custom' ? setCustom(range.from, range.to) : setPreset(v))}
        options={[...PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: 'custom', label: 'Custom range' }]}
      />
      {preset === 'custom' && (
        <DatePicker.RangePicker
          allowClear={false}
          value={[dayjs(range.from), dayjs(range.to)]}
          disabledDate={(d) => d.isAfter(dayjs().add(1, 'day'))}
          onChange={(v) => v?.[0] && v[1] && setCustom(v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD'))}
        />
      )}
      <Space size={6}>
        <Switch size="small" checked={compare} onChange={setCompare} id="compare-toggle" />
        <label htmlFor="compare-toggle" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
          {compact ? 'Compare' : 'Compare to previous period'}
        </label>
      </Space>
    </Space>
  );
}

function SiteSwitcher({ onAdd, compact }: { onAdd: () => void; compact?: boolean }) {
  const { sites, site, detail } = useCurrentSite();
  const setSite = useDashboard((s) => s.setSite);
  const live = !!detail.data?.last_event_received_at && Date.now() - Date.parse(detail.data.last_event_received_at) < 86_400_000;
  return (
    <Space.Compact className="site-switcher">
      <Select
        style={{ minWidth: compact ? 0 : 240, flex: 1 }}
        placeholder="Select a site"
        value={site?.id}
        onChange={setSite}
        aria-label="Site"
        data-testid="site-switcher"
        popupMatchSelectWidth={false}
        labelRender={() =>
          site ? (
            <span className="site-label">
              <Tooltip title={live ? 'Receiving events' : 'No events in the last 24 hours'}>
                <span className={`dot ${live ? 'on' : ''}`} aria-hidden />
              </Tooltip>
              <b>{site.name}</b>
              {!compact && <Typography.Text type="secondary"> · {site.domain}</Typography.Text>}
            </span>
          ) : null
        }
        options={(sites ?? []).map((s) => ({
          value: s.id,
          label: (
            <span>
              {s.name} <Typography.Text type="secondary">· {s.domain}</Typography.Text>
              {s.status === 'inactive' && <Tag style={{ marginLeft: 6 }}>inactive</Tag>}
            </span>
          ),
        }))}
      />
      <Tooltip title="Add a site">
        <Button icon={<PlusOutlined />} onClick={onAdd} aria-label="Add site">
          {compact ? null : 'Add site'}
        </Button>
      </Tooltip>
    </Space.Compact>
  );
}

export function AppLayout() {
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  const desktop = !!screens.lg;
  const { pathname } = useLocation();
  const current = ALL.find((n) => n.key === pathname);
  const dated = !!current?.dated;

  useEffect(() => {
    document.title = current ? `${current.label} · GrowthOS` : 'GrowthOS';
  }, [current]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {desktop && (
        <Layout.Sider width={232} theme="light" className="app-sider">
          <Brand />
          <Nav />
        </Layout.Sider>
      )}
      <Drawer open={!desktop && menuOpen} onClose={() => setMenuOpen(false)} placement="left" width={260} title={<Brand />} styles={{ body: { padding: 8 } }}>
        <Nav onNavigate={() => setMenuOpen(false)} />
      </Drawer>
      <Layout>
        <Layout.Header className={`app-header ${desktop ? '' : 'mobile'}`}>
          <div className="header-row">
            {!desktop && <Button type="text" icon={<MenuOutlined />} onClick={() => setMenuOpen(true)} aria-label="Open navigation" />}
            <SiteSwitcher onAdd={() => setAdding(true)} compact={!desktop} />
            {desktop && <div style={{ flex: 1 }} />}
            {desktop && dated && <DateControls />}
          </div>
          {!desktop && dated && (
            <div className="header-row">
              <DateControls compact />
            </div>
          )}
        </Layout.Header>
        <Layout.Content className="app-content">
          <Outlet />
        </Layout.Content>
      </Layout>
      <AddSiteModal open={adding} onClose={() => setAdding(false)} />
    </Layout>
  );
}
