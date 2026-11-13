import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { AskAiPage } from './pages/AskAi';
import { KnowledgePage } from './pages/Knowledge';
import { GrowthPage } from './pages/Growth';
import { DevicesPage } from './pages/Devices';
import { EventsPage } from './pages/Events';
import { OverviewPage } from './pages/Overview';
import { PagesPage } from './pages/Pages';
import { RealtimePage } from './pages/Realtime';
import { SeoPage } from './pages/Seo';
import { SitesPage } from './pages/Sites';
import { SourcesPage } from './pages/Sources';
import { antdTheme } from './theme';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider theme={antdTheme}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<OverviewPage />} />
                <Route path="realtime" element={<RealtimePage />} />
                <Route path="pages" element={<PagesPage />} />
                <Route path="sources" element={<SourcesPage />} />
                <Route path="events" element={<EventsPage />} />
                <Route path="devices" element={<DevicesPage />} />
                <Route path="seo" element={<SeoPage />} />
                <Route path="growth" element={<GrowthPage />} />
                <Route path="ask" element={<AskAiPage />} />
                <Route path="knowledge" element={<KnowledgePage />} />
                <Route path="sites" element={<SitesPage />} />
                <Route path="*" element={<OverviewPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
