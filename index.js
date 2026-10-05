/**
 * Host half of the session-archive bundle.
 *
 * DSH can archive a Session, but the archive is otherwise a one-way door: the
 * shipped composition documents "No Session deletion" (`dsh-client-ui-workspace`
 * README, Known Limitations), `sessionPersistence` exposes
 * `create`/`open`/`flush`/`stat`/`list` with no removal verb, and `ctx.fs` has no
 * unlink either. Nothing retires a session's durable record, so "permanently
 * delete" has to be built — and only a Host half can build it, because a page
 * cannot unlink a log file.
 *
 * This half is therefore one same-origin route pair, and no service:
 *
 *   GET  /dsh-session-archive/archived  archive order + on-disk facts per id
 *   POST /dsh-session-archive/delete    permanent deletion of one archived id
 *
 * The browser half already holds the archive set through its workspace store;
 * the GET exists because only the Host can say whether a session still has a
 * log, how big it is, when it was last written, and whether it is live.
 *
 * Deletion is artifact-first on purpose. A failure while removing the log
 * changes no registry state at all, and a failure after it leaves the id
 * archived with its log already gone — a state the Settings page renders as a
 * missing log and the user can retry. The opposite order would report success
 * while the log survived, which is the one outcome a delete must never produce.
 *
 * What is removed, and why each step is a supported one:
 *  - the session's own log directory, recursively. `sessionDir` is documented
 *    as "the directory owned by one session", and it holds every format
 *    generation (v0…v4) because committed events are never rewritten — so the
 *    directory, never one file, is the deletion unit. The path comes from the
 *    backend's own `locate(header)` refusal-diagnostics hook when the installed
 *    backend offers it, and otherwise from scanning one level of project
 *    directories for the `encodeSegment(id)` name, which never re-derives the
 *    lossy, truncated project key.
 *  - the projection-cache record, through the domain that owns it:
 *    `ctx.storageDomain.get('session_projcache').table('sessions').delete(id)`.
 *    The cache is a fold shortcut, never an authority, so this is hygiene; the
 *    domain is already open, which is why this never calls `open`.
 *  - the workspace accounting slot (`Workspace.detachSession`), which the
 *    archived session deliberately kept so unarchiving could restore its
 *    position;
 *  - the registry-global pin and archive sets (`unpinSession`,
 *    `unarchiveSession`), both idempotent for ids absent from them.
 *
 * What is deliberately left alone: `attachments/` and its request cache
 * (content-addressed and shared — one object may serve many sessions, so
 * deleting it would corrupt others), spill files (a per-process temp root the
 * backend does not expose a delete for), the SQLite query index (mounted at
 * `:memory:` with `openAt: never` in this composition, and self-pruning by
 * reconciliation elsewhere — never a file to delete), and `workspace.json`
 * wholesale (the registry owns it; only its published methods are used).
 *
 * Lineage is respected: a session whose header says `origin: 'subagent'` owns
 * no independent lifetime, so it is refused rather than deleted.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Cordis plugin name; matches the bundle row id in cordis.patch.yml. */
export const name = 'dsh-session-archive';

/** Route namespace owned by this plugin. */
const ROUTE_PREFIX = '/dsh-session-archive';

/** Largest accepted request body for the delete route. */
const BODY_LIMIT_BYTES = 64 * 1024;

/** The projection-cache domain and table, as its own declaration names them. */
const PROJECTION_CACHE_DOMAIN = 'session_projcache';
const PROJECTION_CACHE_TABLE = 'sessions';

/**
 * Shape of every Session id this plugin will touch. Ids reach the route from
 * the browser, so the shape is validated before any path is built from one —
 * membership in the archive set is the real authorization, and this is the
 * defence that keeps a malformed id from ever becoming a path traversal.
 */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9-]+$/;

/**
 * Mount the routes once the Web carrier exists, and remove them with the fiber.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        host.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/archived`,
          handler: async (request, response) => {
            if (!requireMethod(request, response, 'GET')) return;
            try {
              sendJson(response, 200, await archivedReport(host));
            } catch (error) {
              sendJson(response, 500, { error: errorText(error) });
            }
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/delete`,
          handler: async (request, response) => {
            if (!requireTrustedPost(request, response)) return;
            let body;
            try {
              body = await readJsonBody(request);
            } catch (error) {
              sendJson(response, 400, { error: errorText(error) });
              return;
            }
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
            if (!SESSION_ID_PATTERN.test(sessionId)) {
              sendJson(response, 400, { error: 'invalid session id' });
              return;
            }
            const registry = host.get('workspaceRegistry');
            if (registry === undefined) {
              sendJson(response, 503, { error: 'workspace registry is unavailable' });
              return;
            }
            if (!registry.archivedSessionIds.includes(sessionId)) {
              sendJson(response, 409, { error: 'session is not archived' });
              return;
            }
            const phase = body?.phase === undefined ? 'both' : body.phase;
            if (phase !== 'purge' && phase !== 'forget' && phase !== 'both') {
              sendJson(response, 400, { error: 'invalid phase' });
              return;
            }
            try {
              const snapshot = await sessionSnapshot(host, sessionId);
              if (snapshot?.header !== undefined && snapshot.header.origin === 'subagent') {
                sendJson(response, 409, { error: 'session belongs to a subagent lineage' });
                return;
              }
              const activity = await activeWork(host, sessionId);
              if (activity !== null && activity.length > 0) {
                // The same waterfall the archive path consults, so this refuses
                // exactly what archiving would have refused.
                sendJson(response, 409, { error: 'session has active work', activity });
                return;
              }
              if (activity === null && isResident(host, sessionId)) {
                // No activity registry to consult: fall back to the narrower,
                // more conservative test rather than deleting something that
                // might be mid-write.
                sendJson(response, 409, {
                  error: 'session is resident and its activity cannot be determined',
                });
                return;
              }
              sendJson(response, 200, await deleteArchivedSession(host, registry, sessionId, snapshot, phase));
            } catch (error) {
              sendJson(response, 500, { error: errorText(error), sessionId });
            }
          },
        }),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-session-archive: routes');
  });
}

/**
 * Whether a session is resident in this process's in-memory stores.
 *
 * This is deliberately NOT the delete guard. Being resident only means the
 * session was materialized at some point — opened, retained by a view, or
 * touched by a subagent — and an archived session that a user merely looked at
 * stays resident while doing nothing at all. Treating residence as "running"
 * refused perfectly deletable sessions (observed live: every archived session on
 * this machine reports resident, none of them running).
 * @param ctx - a context exposing the optional session and agent services.
 * @param sessionId - the candidate session id.
 * @returns true when the session is held in memory.
 */
function isResident(ctx, sessionId) {
  const sessions = ctx.get('sessions');
  if (sessions?.get(sessionId) !== undefined) return true;
  const agents = ctx.get('agents');
  return agents?.get(sessionId) !== undefined;
}

/**
 * What the session is actually doing, asked exactly the way the archive path
 * asks it: the `workspace/session-activity` waterfall, whose providers report
 * running turns, jobs, subagents, and schedules. An archived session has no
 * activity by construction — archiving either refused because there was some,
 * or stopped it — so this passes for every session the archive gate admits
 * while still refusing anything that is genuinely mid-work.
 * @param ctx - the plugin's context.
 * @param sessionId - the candidate session id.
 * @returns the reported activity kinds, or null when no registry answers.
 */
async function activeWork(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return null;
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
    return Array.isArray(activity) ? activity : null;
  } catch {
    return null;
  }
}

/**
 * One stored session's snapshot (header included), or undefined when the
 * persistence service or the session is absent.
 * @param ctx - the plugin's context.
 * @param sessionId - the session id.
 * @returns the persistence snapshot.
 */
async function sessionSnapshot(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) return undefined;
  try {
    return await persistence.stat(sessionId);
  } catch {
    // A backend that rejects stat for an unknown id is not a delete failure:
    // the registry's archive set remains the authority for what may be deleted.
    return undefined;
  }
}

/**
 * The archive report the page reads: the registry's archive order plus what the
 * Host can see on disk for each id.
 * @param ctx - a context exposing `workspaceRegistry`.
 * @returns the JSON body.
 */
async function archivedReport(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const ids = registry === undefined ? [] : [...registry.archivedSessionIds];
  const sessions = [];
  for (const [archivedRank, id] of ids.entries()) {
    sessions.push({
      id,
      archivedRank,
      // Residence is reported for diagnosis only: it says the session is held in
      // memory, not that it is doing anything (see isResident).
      resident: isResident(ctx, id),
      // What the delete guard actually consults. Empty means deletable.
      activity: await activeWork(ctx, id),
      ...describeArtifacts(id, archivedRank, locateLogDirectory(ctx, id)),
    });
  }
  return { ok: true, sessionsRoot: sessionsRoot(), sessions };
}

/**
 * Permanently delete one archived session, in the phase the caller asked for.
 *
 * The two phases exist to make the transition invisible. `purge` removes the
 * artifacts and the accounting while leaving the id in the archive set, so every
 * surface that hides archived sessions (the sidebar above all) keeps hiding it
 * while the browser pulls its session catalog clean; `forget` then drops the
 * archive entry, which is what removes the row from the Settings page. Calling
 * with `both` does them in one request — correct, but a client that refreshes
 * its catalog only afterwards can show the session for one round trip.
 *
 * Artifacts first in every case (see the module note), and every step is
 * idempotent, so a retry after a partial failure finishes the job.
 * @param ctx - the plugin's context.
 * @param registry - the workspace registry service.
 * @param sessionId - a validated, currently archived, non-lineage session id.
 * @param snapshot - that session's persistence snapshot, when one exists.
 * @param phase - `purge`, `forget`, or `both`.
 * @returns the JSON body: what was removed and which workspaces released it.
 */
async function deleteArchivedSession(ctx, registry, sessionId, snapshot, phase) {
  const removed = [];
  const detachedFrom = [];
  if (phase === 'purge' || phase === 'both') {
    removed.push(...removeArtifacts(sessionId, locateLogDirectory(ctx, sessionId, snapshot?.header)));
    const cache = await removeProjectionCache(ctx, sessionId);
    if (cache !== null) removed.push(cache);
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue;
      await workspace.detachSession(sessionId);
      detachedFrom.push(workspace.id);
    }
    await registry.unpinSession(sessionId);
  }
  if (phase === 'forget' || phase === 'both') await registry.unarchiveSession(sessionId);
  return {
    ok: true,
    sessionId,
    phase,
    removed,
    detachedFrom,
    archived: registry.archivedSessionIds.includes(sessionId),
    resident: isResident(ctx, sessionId),
  };
}

/**
 * The dsh home this installation uses. The composition resolves the session
 * root through `dshHomePath`, which reads the same `DSH_HOME` the Host exports
 * to every child process, and falls back to `~/.dsh`.
 * @returns the absolute dsh home directory.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/** @returns the configured session-persistence root. */
function sessionsRoot() {
  return join(dshHome(), 'sessions');
}

/** @returns the projection-cache record path for one session. */
function projectionCacheFile(sessionId) {
  return join(dshHome(), 'storages', PROJECTION_CACHE_DOMAIN, PROJECTION_CACHE_TABLE, `${sessionId}.json`);
}

/**
 * Path-segment encoding of `dsh-session-persistence-jsonl`, mirrored so the
 * session's own directory name can be compared. Session ids are
 * `session-<uuid>` in every composition this ships against, where the encoding
 * is the identity; the escape is kept so an unusual id still matches rather
 * than silently missing its log.
 * @param raw - a non-empty path segment.
 * @returns the encoded segment.
 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Ask the installed persistence backend for the exact log path.
 *
 * `locate(header)` is the backend's own refusal-diagnostics hook, so using it
 * beats re-deriving `projectKey` — which is lossy by design and explicitly not
 * reversible. It is not part of the abstract `sessionPersistence` contract, so
 * a backend without it simply yields null and the directory scan takes over.
 * @param ctx - the plugin's context.
 * @param sessionId - the session id, used only when no header is available.
 * @param header - the session header, when the caller already read one.
 * @returns the log directory path, or null when it cannot be resolved.
 */
function locateLogDirectory(ctx, sessionId, header) {
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined || typeof persistence.locate !== 'function') return null;
  try {
    const meta = header !== undefined ? header : persistence.stat === undefined ? undefined : undefined;
    if (meta === undefined) {
      // Without a header the hook cannot be called; the caller's scan handles it.
      return null;
    }
    const located = persistence.locate(meta);
    return typeof located?.path === 'string' ? dirname(located.path) : null;
  } catch {
    return null;
  }
}

/**
 * Every artifact this plugin considers owned by one session: its log directory,
 * a legacy flat log beside the project directory, and the projection-cache
 * record.
 *
 * The project key is lossy, so when the backend cannot name the path the
 * session directory is found by scanning the project directories instead of
 * recomputing their names. `_no-cwd` is one of them and the same scan covers
 * it. A legacy flat `<id>.jsonl[.zstd]` is reported too: the backend refuses
 * that layout now, but a machine that migrated may still hold one.
 * @param sessionId - a validated session id.
 * @param locatedDirectory - the backend-reported log directory, when known.
 * @returns located artifacts, log first.
 */
function locateArtifacts(sessionId, locatedDirectory) {
  const found = [];
  const seen = new Set();
  if (typeof locatedDirectory === 'string' && existsSync(locatedDirectory)) {
    found.push({ kind: 'log-directory', path: locatedDirectory });
    seen.add(locatedDirectory.toLowerCase());
  }
  const root = sessionsRoot();
  if (existsSync(root)) {
    const encoded = encodeSegment(sessionId);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const project = join(root, entry.name);
      const directory = join(project, encoded);
      if (!seen.has(directory.toLowerCase()) && existsSync(directory)) {
        found.push({ kind: 'log-directory', path: directory });
        seen.add(directory.toLowerCase());
      }
      for (const suffix of ['.jsonl', '.jsonl.zstd']) {
        const flat = join(project, `${sessionId}${suffix}`);
        if (!seen.has(flat.toLowerCase()) && existsSync(flat)) {
          found.push({ kind: 'legacy-log', path: flat });
          seen.add(flat.toLowerCase());
        }
      }
    }
  }
  const cache = projectionCacheFile(sessionId);
  if (existsSync(cache)) found.push({ kind: 'projection-cache', path: cache });
  return found;
}

/**
 * Describe one session's artifacts for the page: kind, path, total bytes, and
 * the newest write. A raced removal is not a read failure, so it is skipped.
 * @param sessionId - a validated session id.
 * @param archivedRank - the registry order index.
 * @param locatedDirectory - the backend-reported log directory, when known.
 * @returns the JSON fields merged into the report row.
 */
function describeArtifacts(sessionId, archivedRank, locatedDirectory) {
  const artifacts = locateArtifacts(sessionId, locatedDirectory);
  let bytes = 0;
  let mtimeMs = null;
  for (const artifact of artifacts) {
    try {
      const info = statSync(artifact.path);
      if (!info.isDirectory()) {
        bytes += info.size;
        mtimeMs = Math.max(mtimeMs ?? 0, info.mtimeMs);
        continue;
      }
      for (const entry of readdirSync(artifact.path, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = statSync(join(artifact.path, entry.name));
        bytes += file.size;
        mtimeMs = Math.max(mtimeMs ?? 0, file.mtimeMs);
      }
    } catch {
      // Removed between the scan and this stat: report what is left.
    }
  }
  return {
    archivedOrder: archivedRank,
    artifacts: artifacts.map((artifact) => ({ kind: artifact.kind, path: artifact.path })),
    bytes,
    mtimeMs,
  };
}

/**
 * Remove every located artifact. Removal is idempotent (`force`, recursive), so
 * a retried delete finishes a partial one.
 * @param sessionId - a validated session id.
 * @param locatedDirectory - the backend-reported log directory, when known.
 * @returns the removed artifacts, as reported to the caller.
 */
function removeArtifacts(sessionId, locatedDirectory) {
  const removed = [];
  for (const artifact of locateArtifacts(sessionId, locatedDirectory)) {
    rmSync(artifact.path, { recursive: true, force: true });
    removed.push({ kind: artifact.kind, path: artifact.path, via: 'filesystem' });
  }
  return removed;
}

/**
 * Drop the projection-cache record.
 *
 * The domain is owned and already open by the projection-cache plugin, so this
 * reaches it with `get` and never `open` (a second `open` of the same domain
 * throws `already-open`). The record file is only touched as a fallback for a
 * composition where the storage domain is not mounted.
 * @param ctx - the plugin's context.
 * @param sessionId - a validated session id.
 * @returns the removal report, or null when there was nothing to remove.
 */
async function removeProjectionCache(ctx, sessionId) {
  const domains = ctx.get('storageDomain');
  const domain = typeof domains?.get === 'function' ? domains.get(PROJECTION_CACHE_DOMAIN) : undefined;
  const table = typeof domain?.table === 'function' ? domain.table(PROJECTION_CACHE_TABLE) : undefined;
  if (table !== undefined && typeof table.delete === 'function') {
    const deleted = await table.delete(sessionId);
    if (deleted === true) {
      return {
        kind: 'projection-cache',
        path: `${PROJECTION_CACHE_DOMAIN}/${PROJECTION_CACHE_TABLE}/${sessionId}.json`,
        via: 'storage-domain',
      };
    }
  }
  const file = projectionCacheFile(sessionId);
  if (!existsSync(file)) return null;
  rmSync(file, { force: true });
  return { kind: 'projection-cache', path: file, via: 'filesystem' };
}

/**
 * Answer only the expected method.
 * @param request - the request.
 * @param response - the response.
 * @param method - the one accepted method.
 * @returns whether the caller may continue.
 */
function requireMethod(request, response, method) {
  if (request.method === method) return true;
  response.writeHead(405, { allow: method });
  response.end();
  return false;
}

/** Loopback host spellings: the same machine and port under three names. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalize `host[:port]` to one loopback identity, or null when it is not a
 * loopback authority.
 * @param authority - the raw authority.
 * @returns the identity key or null.
 */
function loopbackAuthority(authority) {
  try {
    const parsed = new URL(`http://${authority}`);
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null;
    return `loopback:${parsed.port === '' ? '80' : parsed.port}`;
  } catch {
    return null;
  }
}

/**
 * Same-origin admission. The Web carrier documents no authentication or origin
 * policy of its own, so the route applies one. The server binds loopback only,
 * so a non-loopback `Host` (a LAN address, or a rewritten name behind DNS
 * rebinding) is refused; `Origin` must then agree with that same normalized
 * authority. The desktop host page is admitted by its own protocol, which no
 * external page can forge, and a request with no `Origin` can only come from a
 * local native client, which could forge any header anyway.
 * @param request - the request.
 * @returns whether the request may mutate.
 */
function isSameOrigin(request) {
  const host = request.headers.host;
  const hostKey = host === undefined ? null : loopbackAuthority(host);
  if (hostKey === null) return false;
  const origin = request.headers.origin;
  if (origin === undefined || origin === '') return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'dsh-app:') return true;
    return loopbackAuthority(url.host) === hostKey;
  } catch {
    return false;
  }
}

/**
 * Admit a same-origin POST; every other shape is answered here.
 * @param request - the request.
 * @param response - the response.
 * @returns whether the caller may continue.
 */
function requireTrustedPost(request, response) {
  if (!requireMethod(request, response, 'POST')) return false;
  if (isSameOrigin(request)) return true;
  sendJson(response, 403, { error: 'untrusted origin' });
  return false;
}

/**
 * Read a bounded JSON body.
 * @param request - the request.
 * @returns the parsed body.
 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Answer one JSON body.
 * @param response - the response.
 * @param status - the HTTP status.
 * @param value - the JSON value.
 */
function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

/**
 * One message for any thrown value.
 * @param error - the thrown value.
 * @returns the message text.
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
