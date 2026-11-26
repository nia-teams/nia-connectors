import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowPathIcon, MagnifyingGlassIcon, MoonIcon, PlusIcon, SunIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { usesBrowserOAuth } from '../../shared/auth.js';
import type { CatalogResult } from '../../shared/catalog.js';
import { AgentSetup, ConnectorDetails } from './details.js';
import { categories } from './categories.js';
import { Avatar, NiaMark, type ConnectorView } from './brand.js';
import { Failure, Loading, message, request, write } from './ui.js';
import { useConnectorOAuth } from './use-oauth.js';
import './theme.css';

function ConnectorCard({ connector, busy, open, connect }: { connector: ConnectorView; busy: boolean; open: () => void; connect: () => void }) {
  const unavailable = connector.status === 'coming-soon';
  return <article className="connector-card">
    <Avatar connector={connector} />
    <h3 className="card-name"><button className="card-link" type="button" onClick={open} aria-label={`查看 ${connector.name.zh} 连接器`}>
      <span>{connector.name.zh}</span>{connector.enabled && <i className="live-dot" aria-label="已连接" />}
    </button></h3>
    <div className="card-action">
      {connector.enabled ? <span className="connected-chip">已连接</span> : unavailable ? <span className="preview-label">预览</span> :
        <button className="quick-connect" type="button" disabled={busy} aria-label={`${busy ? '正在连接' : '连接'} ${connector.name.zh}`} title="连接" onClick={connect}>
          {busy ? <ArrowPathIcon className="spin" /> : <PlusIcon />}
        </button>}
    </div>
    <p className="card-description">{connector.description.zh}</p>
  </article>;
}

function currentTheme() {
  try { const saved = localStorage.getItem('nia-connectors-theme'); if (saved === 'dark' || saved === 'light') return saved; } catch { /* Use device preference. */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
document.documentElement.dataset.theme = currentTheme();

function App() {
  const [theme, setTheme] = useState(currentTheme);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<CatalogResult>();
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [quickBusy, setQuickBusy] = useState<string[]>([]);
  const [latest, setLatest] = useState<ConnectorView>();
  const [dialog, setDialog] = useState<{ view: 'agent' } | { view: 'details'; id: string; setup?: boolean }>();
  const changed = useCallback((connector: ConnectorView) => { setLatest(connector); setRevision(r => r + 1); }, []);
  const oauth = useConnectorOAuth(changed);
  const searchInput = useRef<HTMLInputElement>(null);
  const current = category === 'all' ? '连接器' : category === 'enabled' ? '已连接' : categories.find(item => item.id === category)?.label ?? '连接器';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('nia-connectors-theme', theme); } catch { /* Persistence is best effort. */ }
  }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    request<CatalogResult>('/catalog', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setCatalog(result); })
      .catch(e => { if (!controller.signal.aborted) setError(message(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const all = catalog?.connectors ?? [];
  const enabledCount = catalog?.counts.enabled ?? 0;
  const gatewayCount = all.filter(item => item.enabled && item.kind === 'mcp').length;
  const keyword = query.trim().toLocaleLowerCase();
  const items = all.filter(item => {
    if (category !== 'all' && (category === 'enabled' ? !item.enabled : item.category !== category)) return false;
    return !keyword || [item.name.zh, item.name.en, item.description.zh, item.description.en, item.id, ...item.tags]
      .some(value => value.toLocaleLowerCase().includes(keyword));
  });
  const grouped = category === 'all' && !keyword;
  const connected = grouped ? items.filter(item => item.enabled) : [];
  const remaining = connected.length ? items.filter(item => !item.enabled) : items;

  function open(id: string, setup = false) { setDialog({ view: 'details', id, setup }); }
  async function quickConnect(connector: ConnectorView) {
    setActionError('');
    if (usesBrowserOAuth(connector.auth.mode)) { void oauth.begin(connector.id, connector.oauthAuthorizedAt); return; }
    if (connector.auth.mode !== 'none') { open(connector.id, true); return; }
    setQuickBusy(current => [...current, connector.id]);
    try { changed(await request<ConnectorView>(`/connectors/${encodeURIComponent(connector.id)}/enable`, write('POST'))); }
    catch (e) { setActionError(message(e)); }
    finally { setQuickBusy(current => current.filter(id => id !== connector.id)); }
  }
  const grid = (list: ConnectorView[]) => <div className="card-grid">{list.map(connector => <ConnectorCard key={connector.id} connector={connector}
    busy={quickBusy.includes(connector.id) || (oauth.activeId === connector.id && oauth.active)} open={() => open(connector.id)} connect={() => void quickConnect(connector)} />)}</div>;
  const showOAuthNotice = dialog?.view !== 'details' || dialog.id !== oauth.activeId;

  const openAgent = () => setDialog({ view: 'agent' });

  return <>
    <header className="topbar">
      <div className="canvas topbar-inner">
        <div className="brand"><NiaMark /><h1>连接器</h1></div>
        <div className="toolbar">
          <div className="search"><MagnifyingGlassIcon /><input ref={searchInput} type="text" role="searchbox" aria-label="搜索连接器" placeholder="搜索连接器…" value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button type="button" className="clear-search" aria-label="清除搜索" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><XMarkIcon /></button>}
          </div>
          <button className="gateway-status" type="button" aria-label={`本地网关 · ${gatewayCount} 已连接，接入 Agent`} title={`本地网关 · ${gatewayCount} 已连接`} onClick={openAgent}>
            <i className="live-dot" /><span className="gateway-caption">本地网关 · </span><span>{gatewayCount}</span><span className="gateway-caption">已连接</span>
          </button>
          <button className="icon-btn theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} type="button" aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} title={theme === 'dark' ? '浅色主题' : '深色主题'}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="btn primary agent-trigger" onClick={openAgent} type="button">接入 Agent</button>
        </div>
      </div>
    </header>
    <main className="canvas main">
      <nav className="category-nav" aria-label="连接器分类">
        {[{ id: 'all', label: '全部' }, { id: 'enabled', label: `已连接 (${enabledCount})` }, ...categories].map(({ id, label }) =>
          <button type="button" className="category" key={id} aria-pressed={id === category} onClick={() => setCategory(id)}>{label}</button>)}
      </nav>
      {catalog?.stale && <div className="notice warning" role="status">无法连接目录源，当前显示上次同步的目录。</div>}
      {error && <Failure>{error}</Failure>}
      {actionError && <Failure>{actionError}</Failure>}
      {showOAuthNotice && oauth.error && <Failure>{oauth.error}</Failure>}
      {showOAuthNotice && oauth.attempt && <div className="notice oauth-attempt" role="status">
        <span>正在等待浏览器授权…</span>{oauth.attempt.linkOnly && <a className="text-link" href={oauth.attempt.url} target="_blank" rel="noreferrer noopener">打开授权页面</a>}
        <button className="btn" type="button" onClick={oauth.cancel}>停止等待</button>
      </div>}
      {!catalog && loading && <Loading>正在加载连接器…</Loading>}
      <div className="catalog-results" aria-busy={loading}>
        {connected.length > 0 && <section className="catalog-section" aria-labelledby="connected-title"><div className="section-title">
          <span className="live-dot" /><h2 id="connected-title">已连接</h2><span className="counter">{connected.length}</span>
        </div>{grid(connected)}</section>}
        {(remaining.length > 0 || (catalog && !connected.length && !loading && !error)) && <section className="catalog-section" aria-labelledby="catalog-title">
          <div className="section-title"><h2 id="catalog-title">{keyword ? '搜索结果' : connected.length ? '探索更多' : category === 'all' ? '全部连接器' : current}</h2><span className="counter">{remaining.length}</span></div>
          {remaining.length ? grid(remaining) : !connected.length && <div className="empty"><MagnifyingGlassIcon /><h3>{category === 'enabled' && !keyword ? '还没有连接器' : '没有匹配的连接器'}</h3><p>{category === 'enabled' && !keyword ? '连接后，服务会显示在这里。' : '试试其他关键词，或切换分类。'}</p></div>}
        </section>}
      </div>
    </main>
    {dialog?.view === 'agent' && <AgentSetup close={() => setDialog(undefined)} />}
    {dialog?.view === 'details' && <ConnectorDetails key={dialog.id} id={dialog.id} initial={all.find(item => item.id === dialog.id)} latest={latest} setup={dialog.setup}
      oauth={oauth} close={() => setDialog(undefined)} changed={changed} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
