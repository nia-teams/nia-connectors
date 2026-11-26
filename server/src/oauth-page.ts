import { randomBytes } from 'node:crypto';
import type { Response } from 'express';

export function oauthPage(res: Response, { status, ok, id, senderOrigin, providerRejected }: { status: number; ok: boolean; id?: string; senderOrigin?: string; providerRejected?: boolean }) {
  const nonce = randomBytes(20).toString('base64');
  const message = JSON.stringify({ type: 'nia-connectors:oauth', id, ok }).replaceAll('<', '\\u003c');
  const origin = JSON.stringify(senderOrigin ?? null).replaceAll('<', '\\u003c');
  res.set('Content-Security-Policy', `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`);
  res.set('Referrer-Policy', 'no-referrer');
  res.status(status).type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nia Connectors · ${ok ? '授权成功' : '授权未完成'}</title><link rel="stylesheet" href="/nia-design-tokens.css">
<link rel="stylesheet" href="/oauth-callback.css"><script nonce="${nonce}">
try {
  const target = ${origin};
  if (window.opener && target) {
    window.opener.postMessage(${message}, target);
    setTimeout(() => window.close(), 850);
  }
  history.replaceState(null, '', location.pathname);
  const saved = localStorage.getItem('nia-connectors-theme');
  document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch {}
</script></head><body><main><p class="brand">NIA CONNECTORS</p><h1>${ok ? '授权成功' : '授权未完成'}</h1>
<p>${ok ? '连接器已启用。可以关闭此窗口，或返回连接器中心。' : providerRejected ? '服务提供方未完成授权。请返回连接器中心重试。' : '授权已取消、过期或交换失败。请返回连接器中心重新授权。'}</p>
<a href="/">返回连接器中心</a></main></body></html>`);
}
