// 总账户/子账户多账户体系：真鉴权（scrypt 口令 + Bearer 令牌）与 accounts-v1 数据归属迁移。
// 设计：口令只存 scrypt 派生哈希；令牌只在库中存 sha256，12h 滑动过期；禁用账户立即失效。
import { scryptSync, timingSafeEqual, randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, copyFileSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { rows } from './intake.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, KEYLEN: 64 };
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, SCRYPT.KEYLEN, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  let expected;
  try { expected = Buffer.from(hashHex, 'hex'); } catch { return false; }
  let actual;
  try {
    actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createAccountStore(db, persist, { dbPath } = {}) {
  db.run(`CREATE TABLE IF NOT EXISTS account(
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    pass_hash TEXT,
    role TEXT CHECK(role IN ('master','sub')),
    display_name TEXT,
    email_bindings TEXT DEFAULT '[]',
    disabled INTEGER DEFAULT 0,
    must_change_pwd INTEGER DEFAULT 0,
    created_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS auth_token(
    token_hash TEXT PRIMARY KEY,
    account_id TEXT,
    expires_at TEXT
  )`);
  migrateAccounts(db, dbPath);

  const now = () => new Date().toISOString();
  const accountById = (id) => rows(db, 'SELECT * FROM account WHERE id=?', [id])[0];
  const publicAccount = (a) => a && ({
    id: a.id,
    username: a.username,
    role: a.role,
    displayName: a.display_name,
    disabled: !!a.disabled,
    mustChangePwd: !!a.must_change_pwd,
    emailBindings: JSON.parse(a.email_bindings || '[]'),
    createdAt: a.created_at,
  });
  function issueToken(accountId) {
    const token = randomBytes(32).toString('hex');
    db.run('INSERT INTO auth_token VALUES(?,?,?)', [sha256(token), accountId, new Date(Date.now() + TOKEN_TTL_MS).toISOString()]);
    persist();
    return token;
  }
  const store = {
    migrate: () => migrateAccounts(db, dbPath),
    masterId() {
      return rows(db, "SELECT id FROM account WHERE role='master' ORDER BY created_at LIMIT 1")[0]?.id || null;
    },
    workspaceSession(token) {
      const current=token?store.authenticate(token):null;
      const account=accountById(current?.accountId||store.masterId());
      if(!account||account.disabled)throw new Error('工作台账户不可用');
      return {account:publicAccount(account),token:current?token:issueToken(account.id)};
    },
    verifyLogin(username, password) {
      const account = rows(db, 'SELECT * FROM account WHERE username=?', [String(username || '')])[0];
      if (!account || account.disabled || !verifyPassword(password, account.pass_hash)) return null;
      return { account: publicAccount(account), token: issueToken(account.id) };
    },
    authenticate(token) {
      if (!token) return null;
      const row = rows(db, 'SELECT * FROM auth_token WHERE token_hash=?', [sha256(String(token))])[0];
      if (!row || row.expires_at < now()) return null;
      const account = accountById(row.account_id);
      if (!account || account.disabled) return null;
      // 滑动续期：每次鉴权顺延 12h
      db.run('UPDATE auth_token SET expires_at=? WHERE token_hash=?', [new Date(Date.now() + TOKEN_TTL_MS).toISOString(), row.token_hash]);
      return { accountId: account.id, role: account.role, name: account.display_name || account.username };
    },
    logout(token) {
      db.run('DELETE FROM auth_token WHERE token_hash=?', [sha256(String(token || ''))]);
      persist();
    },
    changePassword(accountId, oldPassword, newPassword) {
      const account = accountById(accountId);
      if (!account || !verifyPassword(oldPassword, account.pass_hash))
        throw Object.assign(new Error('原密码不正确'), { status: 400 });
      if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200)
        throw Object.assign(new Error('新密码需 6–200 位'), { status: 400 });
      db.run('UPDATE account SET pass_hash=?,must_change_pwd=0 WHERE id=?', [hashPassword(newPassword), accountId]);
      persist();
    },
    listAccounts() {
      return rows(db, 'SELECT * FROM account ORDER BY created_at').map(publicAccount);
    },
    createSubAccount({ username, password, displayName } = {}) {
      username = String(username || '').trim();
      if (!/^[a-zA-Z0-9_.-]{2,60}$/.test(username)) throw Object.assign(new Error('用户名需 2–60 位字母数字'), { status: 400 });
      if (typeof password !== 'string' || password.length < 6 || password.length > 200)
        throw Object.assign(new Error('密码需 6–200 位'), { status: 400 });
      if (rows(db, 'SELECT id FROM account WHERE username=?', [username]).length)
        throw Object.assign(new Error('用户名已存在'), { status: 409 });
      const account = { id: randomUUID(), username, role: 'sub', display_name: String(displayName || username).slice(0, 100), created_at: now() };
      db.run('INSERT INTO account(id,username,pass_hash,role,display_name,email_bindings,disabled,must_change_pwd,created_at) VALUES(?,?,?,?,?,?,0,1,?)',
        [account.id, username, hashPassword(password), 'sub', account.display_name, '[]', account.created_at]);
      persist();
      return publicAccount(accountById(account.id));
    },
    resetPassword(accountId, newPassword) {
      if (!accountById(accountId)) throw Object.assign(new Error('账户不存在'), { status: 404 });
      if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200)
        throw Object.assign(new Error('密码需 6–200 位'), { status: 400 });
      db.run('UPDATE account SET pass_hash=?,must_change_pwd=1 WHERE id=?', [hashPassword(newPassword), accountId]);
      db.run('DELETE FROM auth_token WHERE account_id=?', [accountId]);
      persist();
    },
    setDisabled(accountId, flag) {
      if (!accountById(accountId)) throw Object.assign(new Error('账户不存在'), { status: 404 });
      db.run('UPDATE account SET disabled=? WHERE id=?', [flag ? 1 : 0, accountId]);
      if (flag) db.run('DELETE FROM auth_token WHERE account_id=?', [accountId]);
      persist();
    },
    getEmailBindings(accountId) {
      const account = accountById(accountId);
      if (!account) throw Object.assign(new Error('账户不存在'), { status: 404 });
      return JSON.parse(account.email_bindings || '[]');
    },
    setEmailBindings(accountId, bindings) {
      const account = accountById(accountId);
      if (!account) throw Object.assign(new Error('账户不存在'), { status: 404 });
      if (!Array.isArray(bindings) || bindings.length > 20 ||
        bindings.some((b) => !b || typeof b.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || b.email.length > 200 || (b.purpose !== undefined && String(b.purpose).length > 200)))
        throw Object.assign(new Error('邮箱绑定格式无效'), { status: 400 });
      const clean = bindings.map((b) => ({ email: b.email.trim(), purpose: String(b.purpose || 'inquiry_intake').slice(0, 200) }));
      db.run('UPDATE account SET email_bindings=? WHERE id=?', [JSON.stringify(clean), accountId]);
      persist();
      return clean;
    },
    /** 启动时同步 config/accounts.json：按 username 对齐——不存在则创建，存在则只更新提供的字段；密码仅创建或 resetPassword:true 时生效。 */
    syncFromConfig(config = {}) {
      const entries = [];
      if (config.master && typeof config.master === 'object') entries.push({ ...config.master, role: 'master' });
      for (const sub of Array.isArray(config.subAccounts) ? config.subAccounts : [])
        if (sub && typeof sub === 'object') entries.push({ ...sub, role: 'sub' });
      const created = [], updated = [];
      for (const entry of entries) {
        const username = String(entry.username || '').trim();
        if (!username || username.startsWith('_')) continue;
        if (!/^[a-zA-Z0-9_.-]{2,60}$/.test(username))
          throw Object.assign(new Error(`配置项 ${username}：用户名需 2–60 位字母数字`), { status: 400 });
        let account = rows(db, 'SELECT * FROM account WHERE username=?', [username])[0];
        if (!account) {
          if (typeof entry.password !== 'string' || entry.password.length < 6 || entry.password.length > 200)
            throw Object.assign(new Error(`配置项 ${username}：新建账户必须提供 6–200 位 password`), { status: 400 });
          db.run('INSERT INTO account(id,username,pass_hash,role,display_name,email_bindings,disabled,must_change_pwd,created_at) VALUES(?,?,?,?,?,?,0,?,?)',
            [randomUUID(), username, hashPassword(entry.password), entry.role, String(entry.displayName || username).slice(0, 100), '[]', entry.mustChangePwd === false ? 0 : 1, now()]);
          account = rows(db, 'SELECT * FROM account WHERE username=?', [username])[0];
          created.push(username);
        } else {
          updated.push(username);
        }
        try {
          if (entry.displayName !== undefined) db.run('UPDATE account SET display_name=? WHERE id=?', [String(entry.displayName).slice(0, 100), account.id]);
          if (entry.disabled !== undefined) store.setDisabled(account.id, !!entry.disabled);
          if (entry.emailBindings !== undefined) store.setEmailBindings(account.id, entry.emailBindings);
          if (entry.resetPassword === true) store.resetPassword(account.id, entry.password);
        } catch (error) {
          throw Object.assign(new Error(`配置项 ${username}：${error.message}`), { status: error.status || 400 });
        }
      }
      persist();
      return { created, updated };
    },
  };
  return store;
}

/** accounts-v1：询价归属 owner_id、基础数据 account_id、field_schema 按账号重建、种子 admin 并回填存量数据。幂等，单事务。 */
export function migrateAccounts(db, dbPath) {
  if (rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migration'").length &&
    rows(db, 'SELECT id FROM schema_migration WHERE id=?', ['accounts-v1']).length) return;
  if (dbPath && existsSync(dbPath) && !existsSync(dbPath + '.pre-accounts.bak')) copyFileSync(dbPath, dbPath + '.pre-accounts.bak');
  const has = (table, name) => rows(db, `PRAGMA table_info("${table}")`).some((c) => c.name === name);
  const tableExists = (table) => rows(db, `PRAGMA table_info("${table}")`).length > 0;
  const now = new Date().toISOString();
  db.run('BEGIN');
  try {
    db.run('CREATE TABLE IF NOT EXISTS schema_migration(id TEXT PRIMARY KEY,applied_at TEXT NOT NULL)');
    if (tableExists('inquiry') && !has('inquiry', 'owner_id')) db.run('ALTER TABLE inquiry ADD COLUMN owner_id TEXT');
    for (const table of ['price_resource', 'inventory', 'unit_conv'])
      if (tableExists(table) && !has(table, 'account_id')) db.run(`ALTER TABLE "${table}" ADD COLUMN account_id TEXT`);
    if (!rows(db, "SELECT id FROM account WHERE role='master'").length) {
      const bootstrapPath = dbPath ? dbPath + '.bootstrap.json' : null;
      let previous = null;
      try {
        const saved = bootstrapPath && existsSync(bootstrapPath) ? JSON.parse(readFileSync(bootstrapPath,'utf8')) : null;
        if(typeof saved?.password==='string' && saved.password.length>=6)previous=saved;
      } catch { /* A partial first-start file is replaced atomically below. */ }
      const bootstrapPassword = process.env.RFQ_BOOTSTRAP_PASSWORD || previous?.password || randomBytes(24).toString('base64url');
      if (!process.env.RFQ_BOOTSTRAP_PASSWORD && bootstrapPath && !previous) {
        const temporaryPath=bootstrapPath+'.'+randomUUID()+'.tmp';
        writeFileSync(temporaryPath, JSON.stringify({username:'admin', password:bootstrapPassword}) + '\n', {mode:0o600, flag:'wx'});
        renameSync(temporaryPath,bootstrapPath);
        console.error(`[accounts] 初始管理员凭据已保存至 ${bootstrapPath}，首次登录须改密`);
      }
      db.run('INSERT INTO account(id,username,pass_hash,role,display_name,email_bindings,disabled,must_change_pwd,created_at) VALUES(?,?,?,?,?,?,0,1,?)',
        [randomUUID(), 'admin', hashPassword(bootstrapPassword), 'master', '总账户', '[]', now]);
    }
    const masterId = rows(db, "SELECT id FROM account WHERE role='master' ORDER BY created_at LIMIT 1")[0].id;
    // field_schema：全局单条(id=1)重建为按账号(account_id PK)，旧配置归初始 master
    const schemaCols = rows(db, 'PRAGMA table_info(field_schema)').map((c) => c.name);
    if (schemaCols.includes('id')) {
      db.run('CREATE TABLE field_schema_new(account_id TEXT PRIMARY KEY, json TEXT NOT NULL)');
      const old = rows(db, 'SELECT json FROM field_schema WHERE id=1');
      if (old.length) db.run('INSERT OR REPLACE INTO field_schema_new VALUES(?,?)', [masterId, old[0].json]);
      db.run('DROP TABLE field_schema');
      db.run('ALTER TABLE field_schema_new RENAME TO field_schema');
    }
    // 全部存量数据回填初始 master
    if (has('inquiry', 'owner_id')) db.run('UPDATE inquiry SET owner_id=? WHERE owner_id IS NULL', [masterId]);
    for (const table of ['price_resource', 'inventory', 'unit_conv'])
      if (has(table, 'account_id')) db.run(`UPDATE "${table}" SET account_id=? WHERE account_id IS NULL`, [masterId]);
    db.run('INSERT INTO schema_migration VALUES(?,?)', ['accounts-v1', now]);
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch { /* 事务未开启 */ }
    throw error;
  }
}
