export interface PageSpeedResult {
  url: string;
  /** 'field' = real-user Chrome UX Report data; 'lab' = one simulated Lighthouse run. */
  source: 'field' | 'lab';
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  performanceScore: number | null;
}

interface PsiResponse {
  loadingExperience?: { metrics?: Record<string, { percentile?: number }> };
  lighthouseResult?: {
    categories?: { performance?: { score?: number } };
    audits?: Record<string, { numericValue?: number }>;
  };
}

/** Parses a PageSpeed Insights v5 response, preferring real-user (field) data over lab data. */
export function parsePageSpeed(url: string, body: PsiResponse): PageSpeedResult {
  const field = body.loadingExperience?.metrics ?? {};
  const lab = body.lighthouseResult?.audits ?? {};
  const fieldLcp = field.LARGEST_CONTENTFUL_PAINT_MS?.percentile;
  const hasField = typeof fieldLcp === 'number';
  const score = body.lighthouseResult?.categories?.performance?.score;
  return {
    url,
    source: hasField ? 'field' : 'lab',
    lcpMs: hasField ? fieldLcp! : lab['largest-contentful-paint']?.numericValue ?? null,
    // CrUX reports CLS ×100 as an integer percentile
    cls: hasField
      ? typeof field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile === 'number'
        ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
        : null
      : lab['cumulative-layout-shift']?.numericValue ?? null,
    // INP only exists as field data; lab has no interactions
    inpMs: hasField ? field.INTERACTION_TO_NEXT_PAINT?.percentile ?? null : null,
    performanceScore: typeof score === 'number' ? Math.round(score * 100) : null,
  };
}

/**
 * Runs Google PageSpeed Insights (mobile) for a public URL. Works without a key at a low quota;
 * pass PAGESPEED_API_KEY for more. Returns null on any failure — performance data is optional.
 */
export async function runPageSpeed(url: string, apiKey?: string, timeoutMs = 60_000): Promise<PageSpeedResult | null> {
  const q = new URLSearchParams({ url, strategy: 'mobile', category: 'performance' });
  if (apiKey) q.set('key', apiKey);
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return parsePageSpeed(url, (await res.json()) as PsiResponse);
  } catch {
    return null;
  }
}
