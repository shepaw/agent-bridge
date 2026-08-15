const ABSOLUTE_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

export function isRelativeWorkspaceHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('store://')) return false;
  return !ABSOLUTE_HREF.test(trimmed);
}

export function joinStoreUri(rootUri: string, relPath: string): string | null {
  const root = rootUri.trim().replace(/\/+$/, '');
  if (!root.startsWith('store://')) return null;
  const rel = relPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  if (!rel) return root;
  const parts: string[] = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  if (parts.length === 0) return root;
  return `${root}/${parts.join('/')}`;
}

export function resolveWorkspaceFileUri(
  workspaceRootUri: string | readonly string[] | undefined,
  href: string,
): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('store://')) return trimmed;
  if (!isRelativeWorkspaceHref(trimmed) || workspaceRootUri === undefined) return null;
  const roots = typeof workspaceRootUri === 'string' ? [workspaceRootUri] : workspaceRootUri;
  for (const root of roots) {
    const joined = joinStoreUri(root, trimmed);
    if (joined) return joined;
  }
  return null;
}
