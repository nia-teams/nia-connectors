import { useState } from 'react';
import { LinkIcon } from '@heroicons/react/24/outline';
import type { PublicConnector } from '../../shared/catalog.js';

export type ConnectorView = PublicConnector;

export function NiaMark() {
  return <span className="nia-mark" aria-hidden="true"><LinkIcon /></span>;
}

function monogram(name: string, english: string) {
  const han = name.match(/\p{Script=Han}/u)?.[0];
  if (han) return han;
  const words = (name.match(/[A-Za-z0-9]+/g) ?? english.match(/[A-Za-z0-9]+/g) ?? []);
  const [first = '', second = ''] = words;
  if (second && first.length !== 2) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  return first ? first.slice(0, 2).toUpperCase() : 'NC';
}

export function Avatar({ connector }: { connector: ConnectorView }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const { id, name, icon } = connector;
  const filename = icon?.match(/^icons\/([a-z\d][a-z\d_.-]*\.(?:svg|png|webp))$/i)?.[1];
  const iconUrl = filename ? `/icons/${filename}` : undefined;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const showIcon = iconUrl && iconUrl !== failedUrl;
  return <span className={`avatar ${showIcon ? 'avatar-image' : `tone-${(hash >>> 0) % 10}`}`} aria-hidden="true">
    {showIcon ? <img src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(iconUrl)} /> : monogram(name.zh, name.en)}
  </span>;
}
