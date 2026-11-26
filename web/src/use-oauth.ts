import { useEffect, useRef, useState } from 'react';
import type { PublicConnector } from '../../shared/catalog.js';
import { message, request, write } from './ui.js';

type Attempt = { url: string; started: number; previous?: number; linkOnly: boolean };

export function useConnectorOAuth(onAuthorized: (connector: PublicConnector) => void) {
  const popup = useRef<Window | null>(null);
  const launch = useRef<AbortController | undefined>(undefined);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<Attempt>();
  const [starting, setStarting] = useState(false);
  const clear = () => {
    launch.current?.abort();
    try { popup.current?.close(); } catch { /* The provider may have isolated the popup. */ }
    popup.current = null;
  };
  useEffect(() => clear, []);

  async function begin(id: string, previous?: number) {
    clear();
    setAttempt(undefined);
    setActiveId(id); setError('');
    const path = `/connectors/${encodeURIComponent(id)}`;
    // Create the window within the click gesture, then detach its opener before visiting a provider.
    const tab = window.open('about:blank', '_blank', 'popup,width=550,height=720');
    if (tab) tab.opener = null;
    popup.current = tab;
    const controller = new AbortController();
    launch.current = controller;
    setStarting(true);
    try {
      const { authorizationUrl } = await request<{ authorizationUrl: string }>(`${path}/oauth/start`, { ...write('POST'), signal: controller.signal });
      if (controller.signal.aborted) return;
      const url = new URL(authorizationUrl);
      let linkOnly = !tab || tab.closed;
      if (!linkOnly) {
        try { tab!.location.replace(url.href); } catch { tab!.close(); linkOnly = true; }
      }
      setAttempt({ url: url.href, started: Date.now(), previous, linkOnly });
    } catch (error) {
      tab?.close();
      if (!controller.signal.aborted) setError(message(error));
    } finally { if (!controller.signal.aborted) setStarting(false); }
  }

  useEffect(() => {
    if (!attempt || !activeId) return;
    const path = `/connectors/${encodeURIComponent(activeId)}`;
    let closedAt: number | undefined;
    let inFlight = false;
    const controller = new AbortController();
    const finish = (error?: string) => {
      controller.abort();
      if (error) setError(error);
      popup.current?.close();
      popup.current = null;
      setAttempt(undefined);
    };
    const check = async () => {
      if (controller.signal.aborted || inFlight) return;
      inFlight = true;
      try {
        const status = await request<PublicConnector>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (status.enabled && status.oauthAuthorizedAt && status.oauthAuthorizedAt !== attempt.previous) {
          onAuthorized(status);
          finish();
          return;
        }
        if (Date.now() - attempt.started >= 10 * 60_000) finish('授权已过期，请重新开始。');
        if (!attempt.linkOnly && popup.current?.closed) {
          closedAt ??= Date.now();
          if (Date.now() - closedAt > 3000) finish('授权未完成，请重试。');
        }
      } catch { /* Transient network changes are expected while switching tabs. */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => { void check(); }, 1500);
    window.addEventListener('focus', check);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', check); };
  }, [attempt, activeId, onAuthorized]);

  return { begin, starting, attempt, activeId, active: starting || !!attempt, error, cancel: () => { clear(); setStarting(false); setAttempt(undefined); setActiveId(undefined); setError(''); } };
}

export type OAuthControls = ReturnType<typeof useConnectorOAuth>;
