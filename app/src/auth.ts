// 鉴权状态：token + 账户信息存 localStorage，全站唯一真源。
// appFetch（engine/appUrl.ts）读取这里的 token 注入 Authorization，
// 收到 401 时清场并广播 AUTH_EXPIRED_EVENT，App 监听后回登录页。
export type AccountRole = 'master' | 'sub';

export interface EmailBinding {
  email: string;
  purpose: string;
}

export interface AuthAccount {
  id: string;
  username: string;
  role: AccountRole;
  displayName: string;
  mustChangePwd: boolean;
  emailBindings?: EmailBinding[];
}

export interface AuthState {
  token: string;
  account: AuthAccount;
}

const STORAGE_KEY = 'quanta-auth';

/** 任意 /api/* 响应 401 时广播（登录接口自身除外），App 监听后回登录页 */
export const AUTH_EXPIRED_EVENT = 'quanta-auth-expired';

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function getAuth(): AuthState | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthState;
    if (!parsed?.token || !parsed?.account?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setAuth(next: AuthState): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    window.dispatchEvent(new Event('quanta-save-failed'));
  }
}

/** 仅更新账户资料（如 /api/auth/me 刷新、改密后清除 mustChangePwd），保留 token */
export function updateAccount(patch: Partial<AuthAccount>): void {
  const current = getAuth();
  if (!current) return;
  setAuth({ ...current, account: { ...current.account, ...patch } });
}

export function clearAuth(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch { /* 忽略 */ }
}

/** 账户已失效：清场并通知 App 回登录页 */
export function expireAuth(): void {
  clearAuth();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}
