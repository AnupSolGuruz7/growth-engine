import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type RangeQuery } from './api';
import { presetRange } from './dates';
import { useDashboard } from './store';

export function useSites() {
  return useQuery({ queryKey: ['sites'], queryFn: api.sites });
}

/** The selected site (falls back to the first one) with its detail (install snippet, last event). */
export function useCurrentSite() {
  const { data: sites, isLoading: sitesLoading, error } = useSites();
  const { siteId, setSite } = useDashboard();
  const selected = sites?.find((s) => s.id === siteId) ?? sites?.[0] ?? null;
  useEffect(() => {
    if (selected && selected.id !== siteId) setSite(selected.id);
  }, [selected, siteId, setSite]);
  const detail = useQuery({
    queryKey: ['site', selected?.id],
    queryFn: () => api.site(selected!.id),
    enabled: !!selected,
  });
  return { sites, site: selected, detail, isLoading: sitesLoading, error };
}

/** The analytics query for the current site + date range, or null while no site is selected. */
export function useRangeQuery(): RangeQuery | null {
  const { site } = useCurrentSite();
  const { preset, custom, compare } = useDashboard();
  if (!site) return null;
  const r = preset === 'custom' && custom ? custom : presetRange(preset === 'custom' ? '30d' : preset, site.timezone);
  return { site_id: site.id, from: r.from, to: r.to, compare: compare ? 'previous' : 'none' };
}

export function useReport<T>(name: string, fn: (q: RangeQuery) => Promise<T>, extra: unknown[] = []) {
  const q = useRangeQuery();
  return useQuery({
    queryKey: [name, q, ...extra],
    queryFn: () => fn(q!),
    enabled: !!q,
    // keep showing the previous range while a new one loads — but never another site's data
    placeholderData: (prev, prevQuery) =>
      (prevQuery?.queryKey[1] as RangeQuery | null)?.site_id === q?.site_id ? prev : undefined,
  });
}
