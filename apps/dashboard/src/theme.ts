import type { ThemeConfig } from 'antd';

/**
 * Chart roles (validated reference palette: categorical slots 1–2, status good/critical).
 * Text never takes a series colour; marks carry identity, ink carries values.
 */
export const viz = {
  series1: '#2a78d6', // current period / the single series
  series2: '#eb6834', // previous period (always dashed + legend, never colour alone)
  barTrack: '#eef3fb',
  grid: '#ecebe8',
  axis: '#8a8984',
  textPrimary: '#0b0b0b',
  textSecondary: '#52514e',
  good: '#0ca30c',
  critical: '#d03b3b',
  surface: '#fcfcfb',
};

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: viz.series1,
    borderRadius: 8,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  components: {
    Layout: { headerBg: '#ffffff', siderBg: '#ffffff', bodyBg: '#f6f7f9' },
    Card: { paddingLG: 20 },
  },
};
