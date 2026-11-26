export class MissingCredential extends Error {
  constructor(readonly field: string) { super(`Missing credential: ${field}`); }
}

export function inject(template: string, values: Record<string, string>, encode = (value: string) => value): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, field: string) => {
    const value = Object.hasOwn(values, field) ? values[field] : undefined;
    if (!value) throw new MissingCredential(field);
    return encode(value);
  });
}

export function encodeQueryValue(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

export function injectUrl(template: string, values: Record<string, string>): string {
  const queryStart = template.indexOf('?');
  if (queryStart < 0) return inject(template, values);
  // Encode only substituted values, preserving the registry's separators and literal escapes.
  return inject(template.slice(0, queryStart + 1), values) + inject(template.slice(queryStart + 1), values, encodeQueryValue);
}

export function injectMap(templates: Record<string, string> | undefined, values: Record<string, string>) {
  return Object.fromEntries(Object.entries(templates ?? {}).map(([key, value]) => [key, inject(value, values)]));
}
