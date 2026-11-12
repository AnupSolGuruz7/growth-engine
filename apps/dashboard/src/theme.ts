import type { ThemeConfig } from 'antd';

/**
 * Admin theme: dark navy sidebar, teal accent, slate text, light grey canvas, white panels.
 * Chart series colours are validated (dataviz validator, light surface):
 *   series1 teal + series2 slate blue pass every check;
 *   series1–3 (+ orange) pass all-pairs for donuts (orange is < 3:1, so donuts always carry labels).
 * Status colours (good/critical) are reserved and never used as series.
 */
export const brand = {
  navy: '#2A3F54',
  navyDark: '#1F3142',
  navyText: '#E7E7E7',
  teal: '#169F85',
  tealBright: '#1ABB9C',
  canvas: '#F7F7F7',
  header: '#EDEDED',
  panelBorder: '#E6E9ED',
  text: '#5A738E',
  heading: '#2A3F54',
  muted: '#8A9AAD',
};

export const viz = {
  series1: '#169F85', // current period / the single series
  series2: '#3E6FA8', // previous period (dashed + legend)
  series3: '#D9822B', // third category (donuts only, always labelled)
  other: '#B9C2CB', // "other / unknown" bucket — neutral, not a category hue
  barTrack: '#E8F5F2',
  grid: '#EEF1F4',
  axis: '#9AA8B6',
  textPrimary: '#2A3F54',
  textSecondary: '#73879C',
  good: '#0A8A0A',
  critical: '#C0392B',
  surface: '#FFFFFF',
};

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: brand.teal,
    colorLink: brand.teal,
    colorInfo: brand.teal,
    colorText: '#3F5268',
    colorTextSecondary: '#73879C',
    colorTextHeading: brand.heading,
    colorBorderSecondary: brand.panelBorder,
    colorBgLayout: brand.canvas,
    borderRadius: 4,
    fontFamily: '"Helvetica Neue", Roboto, Arial, "Segoe UI", system-ui, sans-serif',
  },
  components: {
    Layout: { headerBg: brand.header, siderBg: brand.navy, bodyBg: brand.canvas, triggerBg: brand.navyDark },
    Menu: {
      darkItemBg: brand.navy,
      darkSubMenuItemBg: brand.navy,
      darkItemColor: brand.navyText,
      darkItemHoverBg: 'rgba(255,255,255,0.06)',
      darkItemHoverColor: '#FFFFFF',
      darkItemSelectedBg: '#35495E',
      darkItemSelectedColor: '#FFFFFF',
      darkGroupTitleColor: '#B7C4D0',
      itemBorderRadius: 0,
      itemMarginInline: 0,
    },
    Card: { headerFontSize: 17, paddingLG: 18, headerBg: 'transparent' },
    Segmented: { itemSelectedBg: '#FFFFFF' },
    Tabs: { inkBarColor: brand.teal, itemSelectedColor: brand.teal },
  },
};
