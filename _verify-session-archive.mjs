/**
 * Offline verification for the session-archive bundle, run against the real
 * module contracts rather than assumptions.
 *
 * Covers:
 *  1. package/bundle declarations (dsh.bundle.patch, dsh.client, exports, files)
 *  2. the browser half's factory + `settings.section` registration contract
 *  3. the Host route guards (method, origin, id shape, archived, live)
 *  4. a REAL end-to-end permanent delete inside a throwaway DSH_HOME, proving
 *     the deletion removes the log directory, the projection-cache record, the
 *     workspace slot and both registry sets — and touches nothing else.
 *
 * The script never reads or writes the user's own DSH_HOME: it points DSH_HOME
 * at a temp directory for the whole run.
 *
 * Exits non-zero on the first failed assertion.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * This script ships inside the package it verifies, so the package directory is
 * simply its own directory — no relative hop, and nothing that depends on the
 * repository layout around it.
 */
const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** A temp DSH_HOME laid out exactly like a real one. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-archive-'));
  const sessionA = 'session-aaaaaaaa-1111-2222-3333-444444444444';
  const sessionB = 'session-bbbbbbbb-5555-6666-7777-888888888888';
  const projectA = '--F-Project-Demo--';
  const projectB = '--F-Project-Other--';
  const logA = join(home, 'sessions', projectA, sessionA, 'session.v4.jsonl.zstd');
  const logB = join(home, 'sessions', projectB, sessionB, 'session.v4.jsonl.zstd');
  mkdirSync(join(home, 'sessions', projectA, sessionA), { recursive: true });
  mkdirSync(join(home, 'sessions', projectB, sessionB), { recursive: true });
  writeFileSync(logA, 'a'.repeat(1500));
  writeFileSync(logB, 'b'.repeat(64));
  // A legacy flat log beside the project directory, as an older layout left it.
  const legacy = join(home, 'sessions', projectB, `${sessionB}.jsonl`);
  writeFileSync(legacy, 'legacy');
  const cacheA = join(home, 'storages', 'session_projcache', 'sessions', `${sessionA}.json`);
  const cacheB = join(home, 'storages', 'session_projcache', 'sessions', `${sessionB}.json`);
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  writeFileSync(cacheA, '{}');
  writeFileSync(cacheB, '{}');
  // A lineage-owned session: deletable only if the guard fails.
  const sessionC = 'session-cccccccc-9999-0000-1111-222222222222';
  const logC = join(home, 'sessions', projectA, sessionC, 'session.v4.jsonl.zstd');
  const cacheC = join(home, 'storages', 'session_projcache', 'sessions', `${sessionC}.json`);
  mkdirSync(join(home, 'sessions', projectA, sessionC), { recursive: true });
  writeFileSync(logC, 'c'.repeat(16));
  writeFileSync(cacheC, '{}');
  // A session directory outside the configured root: only the backend's own
  // locate() hook can name it, which is what makes preferring that hook worth it.
  const sessionD = 'session-dddddddd-3333-4444-5555-666666666666';
  const logD = join(home, 'root-elsewhere', projectA, sessionD, 'session.v4.jsonl.zstd');
  mkdirSync(join(home, 'root-elsewhere', projectA, sessionD), { recursive: true });
  writeFileSync(logD, 'd'.repeat(32));
  // A session used only by the phase-protocol checks.
  const sessionE = 'session-eeeeeeee-7777-8888-9999-000000000000';
  const logE = join(home, 'sessions', projectA, sessionE, 'session.v4.jsonl.zstd');
  mkdirSync(join(home, 'sessions', projectA, sessionE), { recursive: true });
  writeFileSync(logE, 'e'.repeat(24));
  return {
    home, sessionA, sessionB, sessionC, sessionD, sessionE,
    projectA, projectB, logA, logB, logC, logD, logE, legacy, cacheA, cacheB, cacheC,
  };
}

/** A request the route handler accepts, shaped like node:http's IncomingMessage. */
function fakeRequest({ method = 'GET', origin, host = '127.0.0.1:19387', body } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

/** A response recorder with the two methods the plugin uses. */
function fakeResponse() {
  const state = { status: 0, headers: null, body: '' };
  return {
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(text) {
      state.body = text ?? '';
    },
    result() {
      return {
        status: state.status,
        headers: state.headers,
        json: state.body === '' ? null : JSON.parse(state.body),
      };
    },
  };
}

/**
 * The smallest Cordis-shaped context the Host half consumes.
 * `activity` is what the `workspace/session-activity` waterfall reports:
 * `undefined` models a composition without that registry (the conservative
 * fallback path), an array is a real answer.
 */
function createContext({ archivedIds, workspaces, liveIds = [], calls, services = {}, activity }) {
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const registry = {
    archivedSessionIds: archivedIds,
    list: () => workspaces,
    async unpinSession(id) {
      calls.unpinned.push(id);
    },
    async unarchiveSession(id) {
      calls.unarchived.push(id);
      const at = archivedIds.indexOf(id);
      if (at >= 0) archivedIds.splice(at, 1);
    },
  };
  const sessions = {
    get: (id) => (liveIds.includes(id) ? { id } : undefined),
  };
  const ctx = {
    webServer,
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(_services, callback) {
      callback(ctx);
    },
    get(name) {
      if (services[name] !== undefined) return services[name];
      if (name === 'webServer') return webServer;
      if (name === 'workspaceRegistry') return registry;
      if (name === 'sessions') return sessions;
      return undefined;
    },
  };
  if (activity !== undefined) {
    ctx.waterfall = async (name, _input, fallback) => {
      if (name !== 'workspace/session-activity') return fallback();
      return typeof activity === 'function' ? activity() : activity;
    };
  }
  return { ctx, routes };
}

/** A workspace entity stand-in recording every detach. */
function makeWorkspace(id, sessionIds, calls) {
  return {
    id,
    sessionIds,
    async detachSession(sessionId) {
      calls.detached.push({ workspace: id, sessionId });
      const at = sessionIds.indexOf(sessionId);
      if (at >= 0) sessionIds.splice(at, 1);
    },
  };
}

/** A stand-in for the sidebar's viewing store, as its slot entry publishes it. */
function fakeViewStore(initial) {
  let state = { archivedFilter: initial };
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    actions: {
      setArchivedFilter(filter) {
        state = { ...state, archivedFilter: filter };
        for (const listener of listeners) listener();
      },
    },
  };
}

const home = makeHome();
process.env.DSH_HOME = home.home;

section('1. bundle declarations');
{
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  equal('package name', pkg.name, 'dsh-session-archive');
  equal('dsh.bundle.patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  equal('dsh.client.platform', pkg.dsh?.client?.platform, 'web');
  check('dsh.client.inject names the slot owner', Array.isArray(pkg.dsh?.client?.inject)
    && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'));
  check('exports a ./client bundle', existsSync(join(PLUGIN_DIR, pkg.exports['./client'])));
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    check(`file exists: ${file}`, existsSync(join(PLUGIN_DIR, file)));
  }
  const patch = readFileSync(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
  check('patch inserts the host entry', patch.includes('id: session-archive') && patch.includes("name: 'dsh-session-archive'"));
}

section('2. browser half registration contract');
{
  const source = readFileSync(join(PLUGIN_DIR, 'client.js'), 'utf8');
  const installed = [];
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(value) { this._text = value; } }),
    head: { appendChild: (tag) => installed.push(tag) },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let loaded = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry;
      },
    },
  };
  globalThis.document = documentStub;
  // The client half is a plain script, so evaluate it and read what it registered.
  const factory = new Function(`${source}; return window.__ModuleLoader__.__entry;`);
  globalThis.window.__ModuleLoader__.__entry = null;
  const moduleLoaderLoad = globalThis.window.__ModuleLoader__.load;
  globalThis.window.__ModuleLoader__.load = (entry) => {
    globalThis.window.__ModuleLoader__.__entry = entry;
    moduleLoaderLoad(entry);
  };
  factory();
  equal('registered module id', loaded?.id, 'dsh-session-archive');
  check('factory is a function', typeof loaded?.factory === 'function');

  const registered = [];
  const effects = [];
  const dicts = [];
  const ledgerListeners = [];
  const sidebarStore = fakeViewStore('show');
  const fakeReact = {
    createElement: (type, props, children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useState: (initial) => [initial, () => {}],
  };
  let services = {};
  const ctx = {
    get: (name) => services[name],
    effect(fn, label) {
      effects.push(label);
      fn();
      return () => {};
    },
    locale: {
      // Resolve through the dictionaries the plugin registers, so the label
      // assertion proves the real zh wording rather than the key.
      bind: (ns) => (key, params) => {
        const found = dicts.find((entry) => entry.ns === ns);
        const template = found?.dict.zh[key];
        if (template === undefined) return key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
      },
      register: (ns, dict) => {
        dicts.push({ ns, dict });
        return () => {};
      },
    },
    slots: {
      inject: (key, callback) => {
        callback();
        return () => {};
      },
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
      entries: (key) => (key === 'sidebar.workspaces'
        ? [{ options: { id: 'workspace-browser', store: sidebarStore } }]
        : []),
      subscribe: (key, listener) => {
        if (key === 'sidebar.workspaces') ledgerListeners.push(listener);
        return () => {};
      },
    },
  };
  const plugin = loaded.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected require: ${name}`);
  });
  equal('plugin name', plugin.name, 'sessionArchive');
  check('plugin injects slots + locale', Array.isArray(plugin.inject)
    && plugin.inject.includes('slots') && plugin.inject.includes('locale'));
  plugin.apply(ctx);
  equal('one slot registration', registered.length, 1);
  const entry = registered[0];
  equal('registered into settings.section', entry.options.name, 'settings.section');
  equal('section id (shipped shell gives it the archive icon)', entry.options.id, 'archived-sessions');
  check('section order is numeric', typeof entry.options.order === 'number');
  equal('locale namespace declared', entry.options.locale, 'sessionArchive');
  check('label is a thunk (follows locale without re-registering)', typeof entry.options.label === 'function');
  check('component is a function', typeof entry.component === 'function');
  const injected = entry.options.inject();
  check('inject exposes restore()', typeof injected.restore === 'function');
  check('stylesheet installed once', installed.length === 1);
  check('two dictionaries registered', dicts.length === 1 && dicts[0].dict.zh !== undefined && dicts[0].dict.en !== undefined);
  const zhKeys = Object.keys(dicts[0].dict.zh).sort();
  const enKeys = Object.keys(dicts[0].dict.en).sort();
  check('zh and en dictionaries cover the same keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `only-zh: ${zhKeys.filter((k) => !enKeys.includes(k))} only-en: ${enKeys.filter((k) => !zhKeys.includes(k))}`);
  const label = entry.options.label();
  equal('zh label is the requested page name', label, '归档会话');

  // The sidebar is deliberately left alone. Its own default already hides
  // archived sessions, and the View options menu ("show archived" / "archived
  // only") stays the user's to use — so activation must neither write that
  // store nor subscribe to the sidebar ledger.
  equal('apply leaves the sidebar archived view untouched', sidebarStore.getSnapshot().archivedFilter, 'show');
  equal('apply does not subscribe to the sidebar ledger', ledgerListeners.length, 0);
  equal('no slot outside settings.section is registered', registered.length, 1);

  // A permanent delete must also re-pull the session catalog: removing the log
  // stops the Host listing the session, but the client catalog keeps the
  // identity until its next pull — and because the session is no longer
  // archived, nothing hides that ghost row from the sidebar.
  check('inject exposes refreshCatalog()', typeof injected.refreshCatalog === 'function');
  equal('refreshCatalog reports an absent sessions service', await injected.refreshCatalog(), false);
  let catalogPulls = 0;
  services = {
    sessions: {
      async refresh() {
        catalogPulls += 1;
      },
    },
  };
  equal('refreshCatalog reports the pull it issued', await injected.refreshCatalog(), true);
  equal('the pull reached the sessions service', catalogPulls, 1);

  // A minimal composition — no sidebar, no sessions service — must still apply
  // cleanly rather than throwing on activation.
  const bare = {
    get: () => undefined,
    effect: (fn) => {
      fn();
      return () => {};
    },
    locale: { bind: () => () => '', register: () => () => {} },
    slots: {
      inject: () => () => {},
      register: () => () => {},
      entries: () => [],
      subscribe: () => () => {},
    },
  };
  let degraded = null;
  try {
    loaded.factory((name) => {
      if (name === 'react') return fakeReact;
      throw new Error(`unexpected require: ${name}`);
    }).apply(bare);
  } catch (error) {
    degraded = error;
  }
  check('applies cleanly when no sidebar store is published', degraded === null,
    degraded === null ? '' : String(degraded));
}

section('3. host half: routes and guards');
const hostModule = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href);
equal('host plugin name', hostModule.name, 'dsh-session-archive');
{
  const calls = { detached: [], unarchived: [], unpinned: [] };
  const archivedIds = [home.sessionB, home.sessionA];
  const workspace = makeWorkspace('ws-1', [home.sessionA, home.sessionB], calls);
  const { ctx, routes } = createContext({ archivedIds, workspaces: [workspace], calls, activity: [] });
  hostModule.apply(ctx);
  check('GET route mounted', routes.has('/dsh-session-archive/archived'));
  check('POST route mounted', routes.has('/dsh-session-archive/delete'));

  const get = routes.get('/dsh-session-archive/archived');
  const report = fakeResponse();
  await get.handler(fakeRequest(), report);
  const listed = report.result();
  equal('GET answered 200', listed.status, 200);
  equal('GET reports both archived sessions', listed.json.sessions.length, 2);
  equal('GET preserves archive order (oldest first)', listed.json.sessions[0].id, home.sessionB);
  equal('GET exposes archive rank', listed.json.sessions[1].archivedRank, 1);
  equal('GET reports the log-directory artifact', listed.json.sessions[1].artifacts.some((a) => a.kind === 'log-directory'), true);
  // The report sums every artifact the delete would remove: this session's log
  // (1500 B) plus its projection-cache record ("{}" = 2 B).
  equal('GET sums every deletable artifact', listed.json.sessions[1].bytes, 1502);
  check('GET reports a write time', typeof listed.json.sessions[1].mtimeMs === 'number' && listed.json.sessions[1].mtimeMs > 0);
  equal('GET reports residence (diagnostic only)', listed.json.sessions[1].resident, false);
  equal('GET reports no activity for a deletable session', listed.json.sessions[1].activity.length, 0);

  const wrongMethod = fakeResponse();
  await get.handler(fakeRequest({ method: 'POST' }), wrongMethod);
  equal('GET route rejects POST', wrongMethod.result().status, 405);

  const del = routes.get('/dsh-session-archive/delete');
  const crossOrigin = fakeResponse();
  await del.handler(fakeRequest({ method: 'POST', origin: 'https://evil.example', body: { sessionId: home.sessionA } }), crossOrigin);
  equal('cross-origin POST rejected', crossOrigin.result().status, 403);
  check('cross-origin POST deleted nothing', existsSync(home.logA));

  const sameOrigin = fakeResponse();
  await del.handler(fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { sessionId: home.sessionA } }), sameOrigin);
  equal('same-origin POST accepted', sameOrigin.result().status, 200);
  const deleted = sameOrigin.result().json;
  equal('deleted session echoed', deleted.sessionId, home.sessionA);
  check('log directory reported removed', deleted.removed.some((r) => r.kind === 'log-directory'));
  check('projection cache reported removed', deleted.removed.some((r) => r.kind === 'projection-cache'));
  equal('workspace released the slot', deleted.detachedFrom[0], 'ws-1');
  check('workspace slot actually gone', !workspace.sessionIds.includes(home.sessionA));
  check('unpin issued', calls.unpinned.includes(home.sessionA));
  check('unarchive issued', calls.unarchived.includes(home.sessionA));
  check('id dropped from the archive set', !archivedIds.includes(home.sessionA));
  check('log directory gone from disk', !existsSync(join(home.home, 'sessions', home.projectA, home.sessionA)));
  check('projection cache gone from disk', !existsSync(home.cacheA));
  check('other session untouched: log', existsSync(home.logB));
  check("other session untouched: cache", existsSync(home.cacheB));
  check("other session untouched: workspace slot", workspace.sessionIds.includes(home.sessionB));
  check("other project directory untouched", existsSync(join(home.home, 'sessions', home.projectA)));

  const again = fakeResponse();
  await del.handler(fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { sessionId: home.sessionA } }), again);
  equal('deleting an unarchived id is refused', again.result().status, 409);

  const traversal = fakeResponse();
  await del.handler(fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { sessionId: '../../storages' } }), traversal);
  equal('malformed id refused', traversal.result().status, 400);

  const unknown = fakeResponse();
  await del.handler(fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { sessionId: 'session-ffffffff-0000-0000-0000-000000000000' } }), unknown);
  equal('unknown id refused', unknown.result().status, 409);

  const badBody = fakeResponse();
  await del.handler({ method: 'POST', headers: { host: 'localhost:19387' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{not json'); } }, badBody);
  equal('malformed body refused', badBody.result().status, 400);
}

section('4. the guard asks about work, not residence — and the legacy flat log');
{
  // The defect this covers: a session that was merely *loaded* — opened once,
  // retained by a view, touched by a subagent — stays resident in the Host's
  // in-memory store forever, so a residence test refused perfectly deletable
  // archived sessions. Measured on the live machine: every archived session
  // reported resident, none of them running.
  const calls = { detached: [], unarchived: [], unpinned: [] };
  const archivedIds = [home.sessionB];
  const residentIdle = createContext({
    archivedIds,
    workspaces: [],
    liveIds: [home.sessionB],
    calls,
    activity: [],
  });
  hostModule.apply(residentIdle.ctx);
  const deleted = fakeResponse();
  await residentIdle.routes.get('/dsh-session-archive/delete').handler(
    fakeRequest({ method: 'POST', origin: 'http://localhost:19387', body: { sessionId: home.sessionB } }),
    deleted,
  );
  equal('a resident but idle session is deletable', deleted.result().status, 200);
  check('residence is reported, not used as a refusal', deleted.result().json.resident === true);
  check('legacy flat log removed', deleted.result().json.removed.some((r) => r.kind === 'legacy-log'));
  check('legacy flat file gone from disk', !existsSync(home.legacy));
  check('log directory gone from disk', !existsSync(join(home.home, 'sessions', home.projectB, home.sessionB)));
  check('_no-cwd scan path is harmless', !existsSync(join(home.home, 'sessions', '_no-cwd')));

  // Real work is still refused, and nothing is touched.
  const busyIds = [home.sessionC];
  const busy = createContext({
    archivedIds: busyIds,
    workspaces: [],
    calls: { detached: [], unarchived: [], unpinned: [] },
    activity: () => ['turn'],
  });
  hostModule.apply(busy.ctx);
  const refused = fakeResponse();
  await busy.routes.get('/dsh-session-archive/delete').handler(
    fakeRequest({ method: 'POST', origin: 'http://localhost:19387', body: { sessionId: home.sessionC } }),
    refused,
  );
  equal('a session with active work is refused', refused.result().status, 409);
  equal('the refusal names the activity', refused.result().json.error, 'session has active work');
  check('a refused session keeps its log', existsSync(home.logC));
  check('a refused session stays archived', busyIds.includes(home.sessionC));

  // No activity registry at all: stay conservative instead of guessing.
  const unknownIds = [home.sessionD];
  const unknown = createContext({
    archivedIds: unknownIds,
    workspaces: [],
    liveIds: [home.sessionD],
    calls: { detached: [], unarchived: [], unpinned: [] },
  });
  hostModule.apply(unknown.ctx);
  const unknownAnswer = fakeResponse();
  await unknown.routes.get('/dsh-session-archive/delete').handler(
    fakeRequest({ method: 'POST', origin: 'http://localhost:19387', body: { sessionId: home.sessionD } }),
    unknownAnswer,
  );
  equal('no activity registry + resident refuses conservatively', unknownAnswer.result().status, 409);
  check('the conservative refusal keeps the log', existsSync(home.logD));
}

section('5. backend locate(), the storage-domain cache route, and the lineage guard');
{
  // locate(): the installed backend names the artifact path, so it wins over the
  // directory scan — the only way to reach a session directory outside the root.
  const calls = { detached: [], unarchived: [], unpinned: [] };
  const archivedIds = [home.sessionD];
  const domainDeletes = [];
  const located = createContext({
    archivedIds,
    workspaces: [],
    calls,
    services: {
      sessionPersistence: {
        async stat(id) { return { header: { id, cwd: 'C:\\demo\\workspace' }, revision: 'r1' }; },
        locate(meta) { return { kind: 'jsonl', path: home.logD }; },
      },
      storageDomain: {
        get(name) {
          return {
            table(table) {
              return {
                async delete(key) {
                  domainDeletes.push([name, table, key]);
                  return true;
                },
              };
            },
          };
        },
      },
    },
  });
  hostModule.apply(located.ctx);
  const locatedAnswer = fakeResponse();
  await located.routes.get('/dsh-session-archive/delete').handler(
    fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { sessionId: home.sessionD } }),
    locatedAnswer,
  );
  const locatedBody = locatedAnswer.result();
  equal('locate()-named session deleted', locatedBody.status, 200);
  check('located log directory reported removed', locatedBody.json.removed
    .some((entry) => entry.kind === 'log-directory' && entry.path === dirname(home.logD)));
  check('located log directory gone from disk', !existsSync(dirname(home.logD)));
  check('cache removal delegated to the owning domain', domainDeletes
    .some(([domain, table, key]) => domain === 'session_projcache' && table === 'sessions' && key === home.sessionD));
  check('cache removal reports its route', locatedBody.json.removed
    .some((entry) => entry.kind === 'projection-cache' && entry.via === 'storage-domain'));

  // The lineage guard runs before any artifact is touched.
  const lineageIds = [home.sessionC];
  const lineage = createContext({
    archivedIds: lineageIds,
    workspaces: [],
    calls: { detached: [], unarchived: [], unpinned: [] },
    services: {
      sessionPersistence: {
        async stat(id) { return { header: { id, cwd: 'C:\\demo\\workspace', origin: 'subagent' }, revision: 'r2' }; },
      },
    },
  });
  hostModule.apply(lineage.ctx);
  const lineageAnswer = fakeResponse();
  await lineage.routes.get('/dsh-session-archive/delete').handler(
    fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { sessionId: home.sessionC } }),
    lineageAnswer,
  );
  equal('subagent-origin session refused', lineageAnswer.result().status, 409);
  check('refused session log untouched', existsSync(home.logC));
  check('refused session cache untouched', existsSync(home.cacheC));
  check('refused session stays archived', lineageIds.includes(home.sessionC));
}

section('6. the delete phase protocol: purge → client pull → forget');
{
  // The browser runs these as three steps so the session stays hidden for the
  // whole transition: purge removes the artifacts while leaving it archived
  // (still hidden by the sidebar's filter), the client pulls its catalog clean,
  // and only then does forget drop the archive entry.
  const calls = { detached: [], unarchived: [], unpinned: [] };
  const archivedIds = [home.sessionE];
  const phased = createContext({ archivedIds, workspaces: [], calls, activity: [] });
  hostModule.apply(phased.ctx);
  const route = phased.routes.get('/dsh-session-archive/delete');
  const post = async (body) => {
    const response = fakeResponse();
    await route.handler(fakeRequest({ method: 'POST', origin: 'http://localhost:19387', body }), response);
    return response.result();
  };
  const logE = join(home.home, 'sessions', home.projectA, home.sessionE);

  const invalid = await post({ sessionId: home.sessionE, phase: 'nope' });
  equal('an unknown phase is refused', invalid.status, 400);
  check('an unknown phase touches nothing', existsSync(logE));

  const purge = await post({ sessionId: home.sessionE, phase: 'purge' });
  equal('purge succeeds', purge.status, 200);
  equal('purge reports its phase', purge.json.phase, 'purge');
  check('purge removes the log', !existsSync(logE));
  equal('purge leaves the session archived', purge.json.archived, true);
  check('purge leaves the archive entry in place', archivedIds.includes(home.sessionE));
  check('purge still released the workspace slot', Array.isArray(purge.json.detachedFrom));
  check('purge issued the unpin', calls.unpinned.includes(home.sessionE));
  check('purge did not unarchive', !calls.unarchived.includes(home.sessionE));

  const forget = await post({ sessionId: home.sessionE, phase: 'forget' });
  equal('forget succeeds', forget.status, 200);
  equal('forget drops the archive entry', forget.json.archived, false);
  check('forget removes the id from the registry', !archivedIds.includes(home.sessionE));
  check('forget re-unarchives idempotently', calls.unarchived.includes(home.sessionE));
}

section('7. styles use theme tokens only, and no Harness Client package is imported');
{
  const source = readFileSync(join(PLUGIN_DIR, 'client.js'), 'utf8');
  check('no Harness Client package is required', !/require\(\s*['"]@deepseek-ai\//.test(source));

  const cssStart = source.indexOf('const CSS = [');
  const cssEnd = source.indexOf(".join('');", cssStart);
  check('the stylesheet block is locatable', cssStart >= 0 && cssEnd > cssStart);
  const css = source.slice(cssStart, cssEnd);
  const literal = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((match) => match[0]);
  check('no literal colors in the plugin stylesheet', literal.length === 0, literal.join(', '));

  // Resolve every referenced token against the theme sheets when a reference
  // extraction is present, and skip loudly rather than fail without one: those
  // sheets belong to the dsh installation, not to this package, so a published
  // checkout legitimately has none. Candidates are relative to this package, so
  // no absolute machine path is baked into the file.
  const themeCandidates = [
    join(PLUGIN_DIR, '..', '_ref'),
    join(PLUGIN_DIR, '..', '..', '_ref'),
  ].map((root) => join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'));
  const THEME = themeCandidates.find((candidate) => existsSync(candidate));
  if (THEME === undefined) {
    console.log('  --  theme sheets not extracted; token resolution skipped');
  } else {
    const theme = readFileSync(THEME, 'utf8');
    const declared = new Set([...theme.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const used = new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]));
    const unknown = [...used].filter((token) => !declared.has(token));
    check(`every referenced token is declared in the theme sheets (${used.size} used)`,
      unknown.length === 0, `unknown: ${unknown.join(', ')}`);
    // A themed surface must differ between schemes: each alias token must be
    // declared more than once (light block plus dark block).
    const singleScheme = [...used].filter((token) => token.startsWith('--dsw-alias-')
      && theme.split(new RegExp(`${token}\\s*:`)).length - 1 < 2);
    check('every --dsw-alias-* token has both a light and a dark declaration',
      singleScheme.length === 0, `single-scheme: ${singleScheme.join(', ')}`);
  }
}

rmSync(home.home, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
