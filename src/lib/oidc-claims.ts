/** Claim configuration is operator-controlled, never supplied by an IdP token. */
export type ClaimOptions = {
  scopes: string;
  groupsClaim: string;
  rolesClaim: string;
  roleMap: Record<string, "admin" | "member">;
  userInfo: boolean;
  sessionTtlSeconds?: number;
};

export function claimOptions(env: NodeJS.ProcessEnv = process.env): ClaimOptions {
  const scopes = [...new Set(['openid', ...(env.OCTAVO_OIDC_SCOPES || 'email profile').split(/\s+/).filter(Boolean)])];
  if (scopes.some(s => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s))) throw new Error('Invalid OIDC scopes');
  const roleMap = JSON.parse(env.OCTAVO_OIDC_ROLE_MAP || '{}');
  if (!roleMap || Array.isArray(roleMap) || typeof roleMap !== 'object' || Object.values(roleMap).some(r => r !== 'admin' && r !== 'member')) throw new Error('OIDC role map must map exact claim values to admin or member');
  const groupsClaim = env.OCTAVO_OIDC_GROUPS_CLAIM || 'groups';
  const rolesClaim = env.OCTAVO_OIDC_ROLES_CLAIM || '';
  for (const path of [groupsClaim, rolesClaim].filter(Boolean)) {
    if (path.split('.').some(p => !p || ['__proto__','constructor','prototype'].includes(p))) throw new Error('Invalid OIDC claim path');
  }
  if (Object.keys(roleMap).length && !rolesClaim) throw new Error('OIDC role mapping requires a roles claim');
  if (env.OCTAVO_OIDC_USERINFO && !['0','1'].includes(env.OCTAVO_OIDC_USERINFO)) throw new Error('OIDC UserInfo must be 0 or 1');
  const rawTtl = env.OCTAVO_OIDC_SESSION_TTL_SECONDS;
  const sessionTtlSeconds = rawTtl === undefined || rawTtl === '' ? undefined : Number(rawTtl);
  if (sessionTtlSeconds !== undefined && (!/^\d+$/.test(rawTtl!) || !Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 86400)) throw new Error('OIDC session TTL must be an integer from 60 to 86400 seconds');
  return { sessionTtlSeconds, scopes: scopes.join(' '), groupsClaim, rolesClaim, roleMap, userInfo: env.OCTAVO_OIDC_USERINFO === '1' };
}

export function stringClaim(claims: Record<string, unknown>, path: string): string[] {
  let value: unknown = claims;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return [];
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined || value === null) return [];
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw new Error('OIDC mapped claim must contain strings');
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

export function mappedRole(claims: Record<string, unknown>, options: ClaimOptions): 'admin' | 'member' | undefined {
  if (!Object.keys(options.roleMap).length) return undefined;
  const roles = stringClaim(claims, options.rolesClaim).filter(v => Object.hasOwn(options.roleMap, v)).map(v => options.roleMap[v]);
  return roles.includes('admin') ? 'admin' : 'member';
}

/** UserInfo can supply profile claims only after subject verification. Never replace token identity. */
export function mergeUserInfo(token: Record<string, unknown>, info: Record<string, unknown>): Record<string, unknown> {
  if (!token.sub || info.sub !== token.sub) throw new Error('OIDC UserInfo subject mismatch');
  if (token.email !== undefined && info.email !== undefined && token.email !== info.email) throw new Error('OIDC profile email mismatch');
  const merged = { ...info, ...token };
  // Verification belongs to its email assertion, never a different source.
  if (token.email !== undefined) merged.email_verified = token.email_verified;
  else if (info.email !== undefined) merged.email_verified = info.email_verified;
  return merged;
}
