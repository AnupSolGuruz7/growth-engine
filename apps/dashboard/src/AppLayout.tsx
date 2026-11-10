import {
  AppstoreOutlined,
  BarChartOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LaptopOutlined,
  PlusOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, DatePicker, Drawer, Grid, Layout, Menu, Select, Space, Switch, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { AddSiteModal } from './components/AddSiteModal';
import { PRESETS, presetRange } from './dates';
import { useCurrentSite } from './hooks';
import { useDashboard } from './store';

const NAV = [
  { key: '/', icon: <BarChartOutlined />, label: 'Overview' },
  { key: '/realtime', icon: <ThunderboltOutlined />, label: 'Realtime' },
  { key: '/pages', icon: <FileTextOutlined />, label: 'Pages' },
  { key: '/sources', icon: <GlobalOutlined />, label: 'Sources' },
  { key: '/events', icon: <AppstoreOutlined />, label: 'Events' },
  { key: '/devices', icon: <LaptopOutlined />, label: 'Devices' },
  { key: '/sites', icon: <SettingOutlined />, label: 'Sites' },
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <Menu
      mode="inline"
      selectedKeys={[pathname]}
      style={{ borderInlineEnd: 'none' }}
      items={NAV.map((n) => ({ ...n, label: <Link to={n.key} onClick={onNavigate}>{n.label}</Link> }))}
    />
  );
}

function DateControls() {
  const { site } = useCurrentSite();
  const { preset, custom, compare, setPreset, setCustom, setCompare } = useDashboard();
  const tz = site?.timezone ?? 'UTC';
  const range = preset === 'custom' && custom ? custom : presetRange(preset === 'custom' ? '30d' : preset, tz);
  return (
    <Space wrap size={8}>
      <Select
        size="middle"
        value={preset}
        style={{ width: 150 }}
        aria-label="Date range preset"
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
        <label htmlFor="compare-toggle" style={{ fontSize: 13 }}>
          Compare to previous period
        </label>
      </Space>
    </Space>
  );
}

export function AppLayout() {
  const { sites, site } = useCurrentSite();
  const setSite = useDashboard((s) => s.setSite);
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  const desktop = !!screens.lg;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {desktop && (
        <Layout.Sider width={220} theme="light" style={{ borderRight: '1px solid #eceef1' }}>
          <div className="brand">GrowthOS</div>
          <Nav />
        </Layout.Sider>
      )}
      <Drawer open={!desktop && menuOpen} onClose={() => setMenuOpen(false)} placement="left" width={240} title="GrowthOS">
        <Nav onNavigate={() => setMenuOpen(false)} />
      </Drawer>
      <Layout>
        <Layout.Header className="app-header">
          {!desktop && (
            <Button onClick={() => setMenuOpen(true)} aria-label="Open navigation">
              ☰
            </Button>
          )}
          <Space wrap size={8}>
            <Select
              style={{ minWidth: 200 }}
              placeholder="Select a site"
              value={site?.id}
              onChange={setSite}
              aria-label="Site"
              data-testid="site-switcher"
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
            <Button icon={<PlusOutlined />} onClick={() => setAdding(true)}>
              Add site
            </Button>
          </Space>
          <div style={{ flex: 1 }} />
          <DateControls />
        </Layout.Header>
        <Layout.Content className="app-content">
          <Outlet />
        </Layout.Content>
      </Layout>
      <AddSiteModal open={adding} onClose={() => setAdding(false)} />
    </Layout>
  );
}
