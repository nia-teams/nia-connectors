import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ClipboardDocumentIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline';

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) throw new Error(data?.error ?? '请求失败，请稍后重试。');
  return data as T;
}
export const write = (method: 'POST' | 'PATCH', data: unknown = {}) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
export const message = (error: unknown) => error instanceof Error ? error.message : '请求失败，请稍后重试。';

export function Loading({ children = '正在加载…' }: { children?: ReactNode }) { return <div className="notice" role="status">{children}</div>; }
export function Failure({ children }: { children: ReactNode }) { return <div className="notice error" role="alert">{children}</div>; }
export function Dialog({ title, close, children, variant }: { title: string; close: () => void; children: ReactNode; variant: 'detail' | 'agent' }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`modal modal-${variant}`} aria-label={variant === 'detail' ? title : undefined} aria-labelledby={variant === 'agent' ? 'dialog-heading' : undefined}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-layout">
      <header className="dialog-header">{variant === 'agent' && <h2 id="dialog-heading">{title}</h2>}<button className="icon-btn" type="button" onClick={close} aria-label="关闭"><XMarkIcon /></button></header>
      <div className="dialog-body">{children}</div>
    </div>
  </dialog>;
}
export function useCopy() {
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy(value: string) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const node = document.createElement('textarea'); node.value = value; node.className = 'clipboard-fallback';
        const focus = document.activeElement;
        (document.querySelector('dialog[open]') ?? document.body).append(node);
        try { node.select(); if (!document.execCommand('copy')) throw new Error('Clipboard permission denied'); }
        finally { node.remove(); if (focus instanceof HTMLElement) focus.focus({ preventScroll: true }); }
      }
      setStatus('ok');
    } catch { setStatus('error'); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setStatus('idle'), 1800);
  }
  return { status, copy };
}
export function Copy({ value }: { value: string }) {
  const { status, copy } = useCopy();
  return <button type="button" className="btn copy" onClick={() => void copy(value)}>
    {status === 'ok' ? <CheckIcon /> : <ClipboardDocumentIcon />}<span aria-live="polite">{status === 'ok' ? '已复制' : status === 'error' ? '请手动复制' : '复制'}</span>
  </button>;
}
export function CodeBlock({ value, label = 'SHELL' }: { value: string; label?: string }) {
  const parts = value.split(/("(?:\\.|[^"\\])*"(?:\s*(?=:))?|\[[^\[\]\n]+\]|--[\w-]+|'[^']*')/g);
  return <div className="code-box"><div className="code-header"><span>{label}</span><Copy key={value} value={value} /></div>
    <pre><code>{parts.map((part, i) => i % 2 === 0 ? part : <span key={i} className={part.startsWith('--') || part.startsWith('[') || parts[i + 1]?.startsWith(':') ? 'code-key' : 'code-string'}>{part}</span>)}</code></pre></div>;
}
