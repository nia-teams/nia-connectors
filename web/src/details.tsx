import { useEffect, useRef, useState } from 'react';
import { ArrowTopRightOnSquareIcon, BeakerIcon, ClipboardDocumentIcon, EyeIcon, EyeSlashIcon, LinkIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { usesBrowserOAuth } from '../../shared/auth.js';
import type { ClientConfigs, CliStatus, TestResult } from '../../shared/catalog.js';
import { Avatar, NiaMark, type ConnectorView } from './brand.js';
import { CodeBlock, Copy, Dialog, Failure, Loading, message, request, useCopy, write } from './ui.js';
import type { OAuthControls } from './use-oauth.js';

const displayText = (text: string | { zh: string; en: string } | undefined) => typeof text === 'string' ? text : text?.zh;
const commandText = (text: string | string[] | { zh: string; en: string } | undefined) => Array.isArray(text) ? text.join('\n') : displayText(text);
const platforms: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function UsageExamples({ examples }: { examples: string[] }) {
  const { status, copy } = useCopy();
  return <section className="detail-section usage-examples" aria-labelledby="usage-heading">
    <h3 id="usage-heading">连接后你可以这样问</h3>
    <ul className="example-list">{examples.slice(0, 4).map((prompt, i) => <li key={i}>
      <button className="example-card" type="button" onClick={() => void copy(prompt)} title="复制示例">
        <SparklesIcon aria-hidden="true" /><span>{prompt}</span><ClipboardDocumentIcon aria-hidden="true" />
      </button>
    </li>)}</ul>
    <div className={status === 'idle' ? 'visually-hidden' : 'copy-toast'} role="status">
      {status === 'ok' ? '已复制示例' : status === 'error' ? '未能复制，请手动复制' : ''}
    </div>
  </section>;
}

export function ConnectorDetails({ id, initial, latest, setup, close, changed, oauth }: {
  id: string; initial?: ConnectorView; latest?: ConnectorView; setup?: boolean; close: () => void;
  changed: (connector: ConnectorView) => void; oauth: OAuthControls;
}) {
  const path = `/connectors/${encodeURIComponent(id)}`;
  const [connector, setConnector] = useState(initial);
  const [cli, setCli] = useState<CliStatus>();
  const [cliError, setCliError] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [result, setResult] = useState<TestResult>();
  const setupRef = useRef<HTMLElement>(null);
  const needsFocus = useRef(setup);
  const isOAuth = usesBrowserOAuth(connector?.auth.mode);
  const reserved = connector?.status === 'coming-soon';
  const oauthHere = oauth.activeId === id;
  const oauthBusy = oauthHere && oauth.active;
  const isCli = connector?.kind === 'cli';
  const apiKey = connector?.auth.mode === 'api-key' || connector?.auth.mode === 'token-schema';
  const oauthAuthorizedAt = connector?.oauthAuthorizedAt;

  useEffect(() => {
    const controller = new AbortController();
    request<ConnectorView>(path, { signal: controller.signal }).then(entry => {
      if (controller.signal.aborted) return;
      setConnector(entry);
      if (entry.kind === 'cli') request<CliStatus>(`/cli/${encodeURIComponent(id)}/status`, { signal: controller.signal })
        .then(status => { if (!controller.signal.aborted) setCli(status); })
        .catch(e => { if (!controller.signal.aborted) setCliError(message(e)); });
    }).catch(e => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [id, path]);
  useEffect(() => { if (latest?.id === id) setConnector(latest); }, [id, latest]);
  useEffect(() => { setResult(undefined); }, [oauthAuthorizedAt]);
  useEffect(() => {
    const target = setupRef.current;
    if (!needsFocus.current || !target) return;
    const timer = requestAnimationFrame(() => {
      const control = target.querySelector<HTMLElement>('input, button') ?? target;
      control.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
      needsFocus.current = false;
    });
    return () => cancelAnimationFrame(timer);
  }, [connector?.id, isCli, apiKey]);

  const credentials = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== ''));
  const hasDraft = Object.keys(credentials).length > 0;
  const perform = async (action: string, task: () => Promise<void>) => {
    setBusy(action); setError('');
    try { await task(); } catch (e) { setError(message(e)); } finally { setBusy(undefined); }
  };
  const changeStatus = (enable: boolean) => perform('save', async () => {
    if (!enable && oauthHere) oauth.cancel();
    const updating = enable ? 'enable' : isOAuth ? 'oauth/revoke' : 'disable';
    const updated = await request<ConnectorView>(`${path}/${updating}`, write('POST', enable ? { credentials } : {}));
    setConnector(updated); setDraft({}); setVisible({});
    if (!enable) setResult(undefined);
    changed(updated);
  });
  const test = () => perform('test', async () => {
    setResult(undefined);
    setResult(await request<TestResult>(`${path}/test`, write('POST', { credentials })));
  });
  const toggleTool = (name: string, enabled: boolean) => perform('tool', async () => {
    const disabledTools = new Set(connector?.disabledTools);
    if (enabled) disabledTools.delete(name); else disabledTools.add(name);
    setConnector(await request<ConnectorView>(`${path}/tools`, write('PATCH', { disabledTools: [...disabledTools] })));
  });
  const install = connector?.cli?.install;
  const platformSpecific = install && typeof install === 'object' && !Array.isArray(install) && !('zh' in install) ? install : undefined;
  const installText = platformSpecific ? undefined : commandText(install as Parameters<typeof commandText>[0]);
  const primaryLabel = isCli ? '标为已连接' : apiKey ? (connector?.enabled ? '保存密钥' : '保存并连接') : '一键连接';
  const renderTest = () => <button type="button" className="btn primary" disabled={!!busy} onClick={() => void test()}><BeakerIcon />{busy === 'test' ? '测试中…' : '测试连接'}</button>;

  return <Dialog variant="detail" title={connector?.name.zh ?? '连接器详情'} close={close}>
    {!connector && (error ? <Failure>{error}</Failure> : <Loading />)}
    {connector && <>
      <div className="connector-detail-flow">
        <div className="flow-marks"><NiaMark /><span className="flow-bridge" aria-hidden="true"><i /><i /><i /></span><Avatar connector={connector} /></div>
        <h2>{connector.name.zh}</h2>
        <p className="detail-description">{connector.description.zh}</p>
      </div>
      {!!connector.examples?.length && <UsageExamples examples={connector.examples} />}
      {error && <Failure>{error}</Failure>}
      {reserved && <p className="notice">暂未开放连接，敬请期待。</p>}
      {!reserved && !isOAuth && connector.auth.fields?.length ? <section className="detail-section" ref={setupRef} tabIndex={-1}>
        <div className="section-head"><h3>填写连接密钥</h3>{connector.auth.docUrl && <a className="text-link" href={connector.auth.docUrl} rel="noreferrer" target="_blank">获取密钥 <ArrowTopRightOnSquareIcon /></a>}</div>
        {connector.auth.fields.map(field => {
          const configured = connector.configured[field.name];
          return <div className="field" key={field.name}>
            <label htmlFor={`credential-${field.name}`}>{field.labelZh ?? displayText(field.label) ?? field.name} {field.required !== false && <span className="required" title="必填">*</span>}</label>
            <div className="password">
              <input id={`credential-${field.name}`} type={visible[field.name] ? 'text' : 'password'} autoComplete="off" spellCheck={false}
                placeholder={configured ? '已保存，可输入新值替换' : (field.placeholder ?? '请输入密钥')}
                value={draft[field.name] ?? ''} onChange={event => setDraft(current => ({ ...current, [field.name]: event.target.value }))} />
              <button className="field-toggle" type="button" aria-label={visible[field.name] ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible(state => ({ ...state, [field.name]: !state[field.name] }))}>
                {visible[field.name] ? <EyeSlashIcon /> : <EyeIcon />}
              </button>
            </div>
            {field.helpUrl && <a className="text-link" href={field.helpUrl} target="_blank" rel="noreferrer">查看字段说明 <ArrowTopRightOnSquareIcon /></a>}
          </div>;
        })}
      </section> : null}
      {connector.cli && <section className="detail-section" ref={!connector.auth.fields?.length ? setupRef : undefined} tabIndex={-1}>
        <div className="section-head"><h3>本地安装</h3>{cli && <span className={cli.installed ? 'connected-chip' : 'status-label'}>{cli.installed ? `已安装${cli.version ? ` · ${cli.version}` : ''}` : '未安装'}</span>}</div>
        {cliError ? <Failure>{cliError}</Failure> : !cli && <Loading>正在检测本地程序…</Loading>}
        {!!installText && <div className="command"><h4>安装命令</h4><CodeBlock value={installText} /></div>}
        {platformSpecific && Object.entries(platformSpecific).map(([platform, command]) => command && <div className="command" key={platform}><h4>安装 · {platforms[platform] ?? platform}</h4><CodeBlock value={command} /></div>)}
        {connector.cli.authCommand && <div className="command"><h4>登录命令</h4><CodeBlock value={commandText(connector.cli.authCommand)!} /></div>}
        {connector.cli.checkCommand && <div className="command"><h4>检查命令</h4><CodeBlock value={commandText(connector.cli.checkCommand)!} /></div>}
        {connector.cli.docsUrl && <a className="text-link" href={connector.cli.docsUrl} target="_blank" rel="noreferrer">查看文档 <ArrowTopRightOnSquareIcon /></a>}
      </section>}
      {!reserved && <div className="detail-action-area">
        {connector.enabled ? <div className="connection-status"><span className="live-dot" /> 已连接</div> : isOAuth ? <p className="action-note">将打开服务商登录页完成授权</p> : null}
        {oauthHere && oauth.error && <Failure>{oauth.error}</Failure>}
        {oauthHere && oauth.attempt && <p className="small muted">正在等待浏览器授权… {oauth.attempt.linkOnly && <a className="text-link" href={oauth.attempt.url} target="_blank" rel="noreferrer noopener">打开授权页面</a>}</p>}
        {connector.enabled && !isCli && <section className="detail-section tools-section">
          <h3>可用工具{result?.ok && ` (${result.tools.length})`}</h3>
          {!result ? <p className="muted small">测试连接后可以查看和管理工具。</p> : !result.ok ?
            <Failure>{result.error ?? '连接测试失败。'}</Failure> : result.tools.length ? <ul className="tool-list">{result.tools.map(tool => <li key={tool.name}>
              <div><code>{tool.name}</code>{tool.description && <p className="muted small" title={tool.description}>{tool.description}</p>}</div>
              <input className="switch" type="checkbox" role="switch" aria-label={`启用 ${tool.name}`} checked={!connector.disabledTools.includes(tool.name)} disabled={!!busy} onChange={event => void toggleTool(tool.name, event.target.checked)} />
            </li>)}</ul> : <p className="muted small">此服务暂无可用工具。</p>}
        </section>}
        <div className="detail-actions">
          {isOAuth ? <>
            {connector.enabled && renderTest()}
            {oauthBusy ? <button type="button" className="btn" onClick={oauth.cancel}>停止等待</button> :
              <button type="button" className={`btn${connector.enabled ? '' : ' primary'}`} disabled={!!busy} onClick={() => void oauth.begin(id, oauthAuthorizedAt)}>
                {connector.enabled ? '重新授权' : '前往授权连接'}
              </button>}
          </> : <>
            {connector.enabled && !isCli && (!apiKey || !hasDraft) && renderTest()}
            {(!connector.enabled || (apiKey && hasDraft)) && <button className="btn primary" type="button" disabled={!!busy} onClick={() => void changeStatus(true)}>{busy === 'save' ? '保存中…' : primaryLabel}</button>}
          </>}
          {connector.enabled && <button type="button" className="btn quiet-danger" disabled={!!busy} onClick={() => void changeStatus(false)}>断开连接</button>}
        </div>
      </div>}
    </>}
  </Dialog>;
}

export function AgentSetup({ close }: { close: () => void }) {
  const [data, setData] = useState<ClientConfigs>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    request<ClientConfigs>('/client-configs', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch(e => {
      if (!controller.signal.aborted) setError(message(e));
    });
    return () => controller.abort();
  }, []);
  return <Dialog variant="agent" title="接入 Agent" close={close}>
    {error ? <Failure>{error}</Failure> : !data && <Loading />}
    {data && <>
      <p className="agent-intro">支持 Streamable HTTP 的 MCP 客户端可通过下方地址或 JSON 配置接入。</p>
      <div className="endpoint">
        <div className="endpoint-label"><span>Streamable HTTP</span><span><i className="live-dot" />{data.activeConnectors} 个连接器已启用</span></div>
        <div className="endpoint-bar"><LinkIcon /><code>{data.endpoint}</code><Copy key={data.endpoint} value={data.endpoint} /></div>
      </div>
      <CodeBlock value={JSON.stringify(data.config, null, 2)} label="JSON" />
    </>}
  </Dialog>;
}
