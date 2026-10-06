const STORAGE_KEY = 'tensorv:scripts:v1';
const LEGACY_KEY = 'tensorv:code:v1';
const MAX_SCRIPTS = 20;
const MAX_CODE_LENGTH = 20000;
const MAX_NAME_LENGTH = 80;
const MAX_CACHE_LENGTH = MAX_SCRIPTS * (MAX_CODE_LENGTH * 6 + 1024);
let fallbackId = 0;

function makeId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* Some browser contexts restrict access to crypto. */ }
  fallbackId += 1;
  return `script-${Date.now().toString(36)}-${fallbackId.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function validateCode(code) {
  if (typeof code !== 'string') throw new Error('脚本内容必须是文本');
  if (code.length > MAX_CODE_LENGTH) throw new Error('每个脚本最多保存 20000 个字符');
  return code;
}

function normalizeName(name) {
  if (typeof name !== 'string') throw new Error('请输入脚本名称');
  let result = name.trim();
  if (!result || /^[.\s]+$/.test(result) || /[\\/\u0000-\u001f\u007f]/.test(result)) {
    throw new Error('请输入有效的脚本名称');
  }
  if (!/\.py$/i.test(result)) result += '.py';
  if (result.toLowerCase() === '.py' || result.length > MAX_NAME_LENGTH) {
    throw new Error('脚本名称需为 1 至 77 个字符，不含 .py 后缀');
  }
  return result;
}

function uniqueName(name, scripts, exceptId) {
  const taken = new Set(scripts.filter(script => script.id !== exceptId).map(script => script.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const base = name.slice(0, -3);
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}.py`;
    const candidate = base.slice(0, MAX_NAME_LENGTH - ending.length) + ending;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function readStorage(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function readScripts(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CACHE_LENGTH) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !Array.isArray(value.scripts)) return null;
    const scripts = [];
    const ids = new Set();
    for (const item of value.scripts) {
      if (scripts.length === MAX_SCRIPTS) break;
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id)) continue;
      try {
        const code = validateCode(item.code);
        const name = uniqueName(normalizeName(item.name), scripts);
        const updatedAt = Number.isFinite(item.updatedAt) && item.updatedAt >= 0 ? item.updatedAt : Date.now();
        scripts.push({ id: item.id, name, code, updatedAt, ...(item.reviewRequired === true ? { reviewRequired: true } : {}) });
        ids.add(item.id);
      } catch { /* Recover the other valid scripts from a damaged cache. */ }
    }
    if (!scripts.length) return null;
    return { scripts, currentId: ids.has(value.currentId) ? value.currentId : scripts[0].id };
  } catch { return null; }
}

/** Browser-local scripts. Storage failures preserve changes in memory. */
export function createScriptStore(storage, initialCode = '') {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  validateCode(initialCode);
  let state = readScripts(readStorage(storage, STORAGE_KEY));
  if (!state) {
    const legacy = readStorage(storage, LEGACY_KEY);
    const code = typeof legacy === 'string' && legacy.length <= MAX_CODE_LENGTH ? legacy : initialCode;
    const script = { id: makeId(), name: 'playground.py', code, updatedAt: Date.now() };
    state = { scripts: [script], currentId: script.id };
  }

  let persisted = false;
  function save() {
    try {
      if (!storage || typeof storage.setItem !== 'function') throw new Error('Storage unavailable');
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...state }));
      persisted = true;
    } catch { persisted = false; }
  }
  function find(id) {
    const script = state.scripts.find(item => item.id === id);
    if (!script) throw new Error('脚本不存在');
    return script;
  }
  function current() { return { ...find(state.currentId) }; }
  save();

  return {
    get persisted() { return persisted; },
    list() { return state.scripts.map(script => ({ ...script })); },
    current,
    approveCurrent() {
      const script = find(state.currentId);
      if (script.reviewRequired) { delete script.reviewRequired; save(); }
    },
    create(name = 'untitled.py', code = '', { reviewRequired = false } = {}) {
      if (state.scripts.length >= MAX_SCRIPTS) throw new Error('最多保存 20 个脚本');
      validateCode(code);
      const resolvedName = uniqueName(normalizeName(name), state.scripts);
      const script = { id: makeId(), name: resolvedName, code, updatedAt: Date.now(), ...(reviewRequired ? { reviewRequired: true } : {}) };
      state.scripts.push(script);
      state.currentId = script.id;
      save();
      return { ...script };
    },
    select(id) {
      find(id);
      if (state.currentId !== id) {
        state.currentId = id;
        save();
      }
      return current();
    },
    update(code) {
      validateCode(code);
      const script = find(state.currentId);
      if (script.code !== code) {
        script.code = code;
        script.updatedAt = Date.now();
        save();
      }
      return { ...script };
    },
    rename(id, name) {
      const script = find(id);
      const resolvedName = uniqueName(normalizeName(name), state.scripts, id);
      if (script.name !== resolvedName) {
        script.name = resolvedName;
        script.updatedAt = Date.now();
        save();
      }
      return { ...script };
    },
    remove(id) {
      find(id);
      if (state.scripts.length === 1) throw new Error('至少保留一个脚本');
      const index = state.scripts.findIndex(script => script.id === id);
      state.scripts.splice(index, 1);
      if (state.currentId === id) state.currentId = state.scripts[Math.min(index, state.scripts.length - 1)].id;
      save();
      return current();
    },
  };
}
