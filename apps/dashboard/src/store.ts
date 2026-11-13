import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PresetKey = 'today' | 'yesterday' | '7d' | '30d' | '90d' | '12mo' | 'custom';

interface DashboardState {
  siteId: string | null;
  preset: PresetKey;
  custom: { from: string; to: string } | null;
  compare: boolean;
  navCollapsed: boolean;
  setNavCollapsed(v: boolean): void;
  setSite(id: string): void;
  setPreset(p: Exclude<PresetKey, 'custom'>): void;
  setCustom(from: string, to: string): void;
  setCompare(on: boolean): void;
}

export const useDashboard = create<DashboardState>()(
  persist(
    (set) => ({
      siteId: null,
      preset: '30d',
      custom: null,
      compare: true,
      navCollapsed: false,
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      setSite: (siteId) => set({ siteId }),
      setPreset: (preset) => set({ preset, custom: null }),
      setCustom: (from, to) => set({ preset: 'custom', custom: { from, to } }),
      setCompare: (compare) => set({ compare }),
    }),
    {
      name: 'growthos-dashboard',
      // v1: forget the remembered site once so the dashboard opens on the default site (the one with a knowledge base)
      version: 1,
      migrate: (state, version) => (version < 1 ? { ...(state as DashboardState), siteId: null } : state) as DashboardState,
    },
  ),
);
