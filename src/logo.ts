// Resolve a real brand logo URL from Brandfetch.
//
// Two-step, because the free Search API's `icon` is usually a generated
// lettermark fallback (URL contains "/fallback/"), not the real logo:
//   1. Search → choose the candidate whose name/domain actually matches the
//      brand (not just "first result with an icon", which grabs wrong brands).
//   2. Brand API (/v2/brands/{domain}, needs a token) → real logo asset.
// If no token, or no real logo, we only accept a non-fallback search icon,
// else return null (no logo beats a wrong/ugly one).

export const brandKey = (b: string) => b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function bestMatch(brand: string, arr: any): any | null {
  const bk = norm(brand);
  if (!bk) return null;
  const cands = (Array.isArray(arr) ? arr : [])
    .map((x: any) => {
      const nameN = norm(x.name);
      const domN = norm(String(x.domain || '').split('.')[0]);
      let score = 0;
      if (nameN === bk || domN === bk) score = 3;
      else if (bk.length >= 4 && (nameN.startsWith(bk) || bk.startsWith(nameN) || domN.startsWith(bk))) score = 2;
      return { x, score, q: Number(x.qualityScore) || 0 };
    })
    .filter((c) => c.score > 0);
  cands.sort((a, b) => b.score - a.score || b.q - a.q);
  return cands[0]?.x ?? null;
}

async function brandApiLogo(domain: string, token: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.brandfetch.io/v2/brands/${domain}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d: any = await r.json();
    const logos: any[] = Array.isArray(d.logos) ? d.logos : [];
    const pick = (t: string) => logos.find((l) => l.type === t);
    const chosen = pick('symbol') || pick('icon') || pick('logo') || logos[0];
    const fmts: any[] = chosen?.formats || [];
    const f = fmts.find((x) => x.format === 'png') || fmts.find((x) => x.format === 'webp')
      || fmts.find((x) => x.format === 'svg') || fmts[0];
    return f?.src ?? null;
  } catch {
    return null;
  }
}

export async function resolveLogo(brand: string, token?: string): Promise<string | null> {
  let arr: any = null;
  try {
    const r = await fetch(`https://api.brandfetch.io/v2/search/${encodeURIComponent(brand)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (r.ok) arr = await r.json();
  } catch { /* network/API issue → null */ }

  const m = bestMatch(brand, arr);
  if (!m) return null;

  if (token && m.domain) {
    const real = await brandApiLogo(m.domain, token);
    if (real) return real;
  }
  const icon: string | null = m.icon || null;
  return icon && !icon.includes('/fallback/') ? icon : null;
}
