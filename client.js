/**
 * Browser half: the "归档会话" page inside Settings.
 *
 * DSH already archives a session and already keeps archived ones out of the
 * sidebar — the sidebar's own row menu archives, and its default filter hides
 * the archived set. What it has no seat for is the archive itself: there is no
 * page that lists what is in there, no way back except the sidebar's
 * "All conversations (show archived)" filter, and no way to retire a session
 * for good. This page is that seat, next to the shipped sections.
 *
 * Three things are read, and none is re-derived:
 *  - the archive set and its ORDER come from the client workspace store
 *    (`useWorkspaces`), which the workspace controller keeps in sync from the
 *    Host. The registry appends on archive, so the array is archive order and
 *    its last entry is the most recently archived session — that is the time
 *    ordering this page shows, newest first.
 *  - titles, directories, and last-activity times come from the session
 *    summaries the sidebar itself renders (`useSessions`).
 *  - whether the log still exists, how big it is, and when it was last written
 *    can only be answered by the Host, so they arrive from this bundle's own
 *    route (`GET /dsh-session-archive/archived`).
 *
 * Restore goes through the same client service the sidebar's row action uses
 * (`ctx.uiWorkspace.unarchiveSession`), so the toast, the sidebar, and the
 * archive set all follow one path. Only permanent deletion is this plugin's own
 * Host route, because unlinking a log is not something a page can do.
 *
 * A plain-JS client plugin must not require a Harness Client package, so the
 * shipped look is reproduced rather than imported: row metrics follow the
 * settings rows (`border-bottom: .5px solid border-l2`, 14px/22px title,
 * 12px/18px tertiary meta) and buttons follow the shipped small button recipe.
 * Every token comes from the theme sheets, so both schemes track the host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-archive',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Locale namespace owned by this plugin. */
    const NS = 'sessionArchive';
    /** The settings page seat, declared by ui-settings-general's shell. */
    const SLOT = 'settings.section';
    /**
     * Section key. `archived-sessions` is deliberately the id the shipped
     * settings shell already maps to the archive glyph (its nav icon table
     * falls back to the gear for unknown ids), so this page gets the right
     * icon without reaching into shell internals.
     */
    const SECTION_ID = 'archived-sessions';
    /** Nav position: after the shipped feature sections, before Plugins. */
    const SECTION_ORDER = 25;
    /** This bundle's Host route namespace. */
    const ROUTE = '/dsh-session-archive';

    const zh = {
      'nav.label': '归档会话',
      'page.title': '归档会话',
      'page.intro': '共 {n} 个已归档会话，按最后活动时间从新到旧排列。已归档的会话默认不会出现在侧边栏，这里是查看和管理它们的地方。',
      'page.empty': '暂无已归档会话',
      'page.emptyHint': '在侧边栏把鼠标移到会话上，从「…」菜单里选择「归档会话」，它就会出现在这里。',
      'page.readError': '无法读取宿主信息（{message}），列表仍按当前会话状态显示。',
      'page.staleError': '列表可能不是最新的，重新打开设置即可刷新。',
      'row.untitled': '未命名会话',
      'row.blank': '新会话',
      'row.missing': '会话记录不存在',
      'row.missingHint': '本地日志已不存在，这条归档记录可以安全清理',
      'row.meta.cwd': '目录 {path}',
      'row.meta.cwdUnknown': '目录未知',
      'row.meta.active': '最后活动 {time}',
      'row.meta.activeUnknown': '最后活动未知',
      'row.meta.size': '日志 {size}',
      'row.meta.sizeUnknown': '日志不可读',
      'row.meta.rank': '第 {n} 个归档',
      'action.restore': '恢复',
      'action.delete': '彻底删除',
      'action.restoring': '恢复中…',
      'action.deleting': '删除中…',
      'confirm.title': '彻底删除这个会话？',
      'confirm.body': '将永久删除「{title}」的会话记录与本地日志，无法撤销。',
      'confirm.detail': '删除内容：会话日志、工作区里的记录、以及本机的会话缓存。工作区目录里的文件不会被删除。',
      'confirm.path': '日志位置：{path}',
      'confirm.hint': '如果只是想让它回到侧边栏，请选择「恢复」。',
      'confirm.cancel': '取消',
      'confirm.confirm': '彻底删除',
      'status.restored': '已恢复「{title}」，它回到了侧边栏。',
      'status.deleted': '已彻底删除「{title}」。',
      'status.failed': '操作失败：{message}',
      'error.noUiWorkspace': '当前界面没有提供工作区服务，无法恢复会话。',
      'error.sessionOpen': '「{title}」正开着，请先切换到其他会话，再彻底删除它。',
      'error.activeWork': '这个会话还有正在进行的工作，等它结束或先停掉，然后再删除。',
      'error.notArchived': '这个会话已经不在归档列表里了，重新打开设置页面刷新一下。',
      'error.subagent': '这个会话属于子代理世系，由拥有它的会话负责，不能单独删除。',
      'time.now': '刚刚',
      'time.minutes': '{n}分钟',
      'time.hours': '{n}小时',
      'time.days': '{n}天',
      'time.months': '{n}个月',
      'time.years': '{n}年',
      'time.ago': '{t}前',
      'date.ymd': '{y}年{m}月{d}日',
      'size.b': '{n} B',
      'size.kb': '{n} KB',
      'size.mb': '{n} MB',
      'size.gb': '{n} GB',
      'aria.list': '已归档会话列表',
      'aria.confirm': '彻底删除会话确认',
    };

    const en = {
      'nav.label': 'Archived sessions',
      'page.title': 'Archived sessions',
      'page.intro': '{n} archived session(s), newest activity first. Archived sessions are hidden from the sidebar by default; this page is where you view and manage them.',
      'page.empty': 'No archived sessions',
      'page.emptyHint': 'Hover a session in the sidebar and pick “Archive session” from its “…” menu; it will show up here.',
      'page.readError': 'Host details are unavailable ({message}); the list still follows the current session state.',
      'page.staleError': 'The list may be out of date. Reopen Settings to refresh.',
      'row.untitled': 'Untitled session',
      'row.blank': 'New session',
      'row.missing': 'Session record is gone',
      'row.missingHint': 'Its local log no longer exists, so this archive entry can be cleaned up safely',
      'row.meta.cwd': 'Directory {path}',
      'row.meta.cwdUnknown': 'Directory unknown',
      'row.meta.active': 'Last active {time}',
      'row.meta.activeUnknown': 'Last activity unknown',
      'row.meta.size': 'Log {size}',
      'row.meta.sizeUnknown': 'Log unreadable',
      'row.meta.rank': 'archived #{n}',
      'action.restore': 'Restore',
      'action.delete': 'Delete permanently',
      'action.restoring': 'Restoring…',
      'action.deleting': 'Deleting…',
      'confirm.title': 'Permanently delete this session?',
      'confirm.body': 'This deletes the session record and its local log for “{title}”. It cannot be undone.',
      'confirm.detail': 'Removed: the session log, its workspace entry, and this machine’s session cache. Files in the workspace directory are never touched.',
      'confirm.path': 'Log location: {path}',
      'confirm.hint': 'Choose “Restore” instead if you only want it back in the sidebar.',
      'confirm.cancel': 'Cancel',
      'confirm.confirm': 'Delete permanently',
      'status.restored': 'Restored “{title}” — it is back in the sidebar.',
      'status.deleted': 'Permanently deleted “{title}”.',
      'status.failed': 'That did not work: {message}',
      'error.noUiWorkspace': 'This surface exposes no workspace service, so a session cannot be restored.',
      'error.sessionOpen': '“{title}” is open — switch to another session before deleting it.',
      'error.activeWork': 'This session still has work in progress; let it finish or stop it first.',
      'error.notArchived': 'This session is no longer in the archive list — reopen Settings to refresh.',
      'error.subagent': 'This session belongs to a subagent lineage and cannot be deleted on its own.',
      'time.now': 'now',
      'time.minutes': '{n}min',
      'time.hours': '{n}h',
      'time.days': '{n}d',
      'time.months': '{n}mo',
      'time.years': '{n}y',
      'time.ago': '{t} ago',
      'date.ymd': '{y}-{m}-{d}',
      'size.b': '{n} B',
      'size.kb': '{n} KB',
      'size.mb': '{n} MB',
      'size.gb': '{n} GB',
      'aria.list': 'Archived session list',
      'aria.confirm': 'Permanently delete session confirmation',
    };

    /**
     * Component CSS. Row metrics mirror the shipped settings rows and the
     * button recipe mirrors the shipped small button, so the page reads as one
     * more section of the same panel. Tokens only — no literal colors — so the
     * light and dark sheets both drive it.
     */
    const CSS = [
      // Section frame, copied from the shipped settings page sheet: the host's
      // `.options` column already scrolls and pads (0 24px 24px), so this adds
      // no page chrome of its own.
      '.dsa-root{display:flex;flex-direction:column;gap:12px;max-width:760px;',
      'color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}',
      '.dsa-heading{margin:0;font-size:18px;font-weight:600}',
      '.dsa-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
      '.dsa-banner{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;padding:8px 10px;',
      'border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}',
      '.dsa-banner[data-kind="error"]{color:var(--dsw-alias-state-error-primary);',
      'background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}',
      '.dsa-banner[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);',
      'background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)}',
      '.dsa-banner[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);',
      'background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}',
      '.dsa-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
      // Row metrics copied from the shipped settings row sheet.
      '.dsa-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;',
      'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dsa-row:last-child{border-bottom:0}',
      '.dsa-row[data-confirming="true"]{background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm);',
      'padding-inline:8px;margin-inline:-8px}',
      '.dsa-rowText{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;padding-right:12px}',
      '.dsa-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // The shipped sidebar greys an archived row with label-caption; a session
      // whose record is gone reads the same way.
      '.dsa-title[data-missing="true"]{color:var(--dsw-alias-label-caption)}',
      '.dsa-meta{display:flex;flex-wrap:wrap;gap:4px 12px;min-width:0;margin-top:4px;font-size:12px;',
      'line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsa-metaItem{min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsa-metaItem[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dsa-metaItem[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsa-actions{display:inline-flex;align-items:center;gap:8px;flex:none}',
      '.dsa-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;',
      'padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dsa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsa-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
      'outline-offset:-2px}',
      '.dsa-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.dsa-btn[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsa-btn[data-tone="danger"]:hover:not(:disabled){',
      'background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',
      '.dsa-btn[data-variant="solid-danger"]{color:var(--dsw-alias-state-error-primary);',
      'background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)}',
      '.dsa-btn[data-variant="solid-danger"]:hover:not(:disabled){',
      'background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent)}',
      // The confirmation is an inline elevated card, not a fixed overlay: the
      // settings panel already owns the modal layer, and a plugin has no portal
      // service, so anything fixed here would only fight that layer and its
      // clip.
      '.dsa-confirm{box-sizing:border-box;padding:12px;border:0;border-radius:var(--dsw-radius-lg);',
      'background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));',
      'backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);',
      'display:flex;flex-direction:column;gap:8px}',
      '.dsa-confirmTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
      '.dsa-confirmBody{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dsa-confirmDetail{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dsa-confirmHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsa-confirmActions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',
      '.dsa-empty{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:80px;',
      'padding:0 12px;text-align:center;font-size:13px;line-height:20px}',
      '.dsa-emptyGlyph{color:var(--dsw-alias-label-tertiary)}',
      '.dsa-emptyTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}',
      '.dsa-emptyHint{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;max-width:44ch}',
      '.dsa-visuallyHidden{position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap}',
    ].join('');

    /**
     * Install this plugin's stylesheet once per document.
     * @returns the element this call installed, or null when one was already there.
     */
    function ensureStyles() {
      const tagId = 'dsh-session-archive/section.css';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return null;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-session-archive';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return tag;
    }

    const MINUTE = 6e4;
    const HOUR = 36e5;
    const DAY = 864e5;
    const MONTH = 30 * DAY;
    const YEAR = 365 * DAY;

    /**
     * The shipped relative-time buckets, mirrored so this page's timestamps
     * agree with the sidebar's.
     * @param at - epoch ms of the moment.
     * @param now - current epoch ms.
     * @returns the bucket unit and magnitude.
     */
    function timeBucket(at, now) {
      const diff = Math.max(0, now - at);
      if (diff < MINUTE) return { unit: 'now', n: 0 };
      if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MINUTE) };
      if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) };
      if (diff < MONTH) return { unit: 'days', n: Math.floor(diff / DAY) };
      if (diff < YEAR) return { unit: 'months', n: Math.floor(diff / MONTH) };
      return { unit: 'years', n: Math.floor(diff / YEAR) };
    }

    /**
     * Compact relative label ("3天前" / "3d ago").
     * @param at - epoch ms of the moment.
     * @param now - current epoch ms.
     * @param t - the section's translator.
     * @returns the label.
     */
    function relativeLabel(at, now, t) {
      const bucket = timeBucket(at, now);
      if (bucket.unit === 'now') return t('time.now');
      return t('time.ago', { t: t(`time.${bucket.unit}`, { n: bucket.n }) });
    }

    /**
     * Absolute local timestamp through the dictionary's date template, so the
     * app locale — not the browser's — decides the wording.
     * @param at - epoch ms of the moment.
     * @param t - the section's translator.
     * @returns the label.
     */
    function absoluteLabel(at, t) {
      const date = new Date(at);
      const pad2 = (value) => String(value).padStart(2, '0');
      const day = t('date.ymd', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
      return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    /**
     * Human byte size, one decimal above a kilobyte.
     * @param bytes - a non-negative byte count.
     * @param t - the section's translator.
     * @returns the label.
     */
    function sizeLabel(bytes, t) {
      if (!Number.isFinite(bytes) || bytes <= 0) return t('size.b', { n: 0 });
      if (bytes < 1024) return t('size.b', { n: bytes });
      if (bytes < 1024 * 1024) return t('size.kb', { n: Math.round(bytes / 1024) });
      if (bytes < 1024 * 1024 * 1024) return t('size.mb', { n: (bytes / (1024 * 1024)).toFixed(1) });
      return t('size.gb', { n: (bytes / (1024 * 1024 * 1024)).toFixed(1) });
    }

    /**
     * One line for any thrown value.
     * @param error - the thrown value.
     * @returns the message text.
     */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /**
     * Turn a Host refusal into text the user can act on.
     *
     * The route answers with stable machine codes; showing them verbatim would
     * put `session has active work` in front of a user reading Chinese. Anything
     * unrecognized is passed through unchanged, so a real failure is still
     * visible rather than hidden behind a generic string.
     * @param t - the section's translator.
     * @param message - the Host's message.
     * @returns the localized or verbatim text.
     */
    function failureText(t, message) {
      switch (message) {
        case 'session has active work': return t('error.activeWork');
        case 'session is not archived': return t('error.notArchived');
        case 'session belongs to a subagent lineage': return t('error.subagent');
        default: return message;
      }
    }

    /**
     * Re-pull the Host session catalog after a permanent delete.
     *
     * Removing the log makes the Host stop listing the session — `sessionQuery`
     * reads `sessionPersistence.list()`, which is derived from the session
     * directories on disk. The *client* catalog, though, is built from one
     * `session.list` pull and then kept incrementally, so the identity survives
     * until the next pull. That survivor is exactly the ghost this exists to
     * avoid: because a deleted session is no longer archived, the sidebar's
     * default "hide archived" filter no longer hides it, so its stray row stays
     * in the list and opening it fails with `session/not-found`.
     *
     * `ctx.sessions.refresh()` is the client service's own full pull, and the
     * baseline merge behind it drops every identity absent from the new rows —
     * so one call removes the session from the sidebar, the search results, and
     * every other catalog reader at once.
     *
     * Guarded on purpose: an older or reduced composition without that method
     * keeps working, and the identity then disappears on the next natural pull
     * (a page load, or any reconnect).
     * @param ctx - the client plugin context.
     * @returns whether a pull was issued.
     */
    async function refreshSessionCatalog(ctx) {
      const face = ctx.get('sessions');
      if (typeof face?.refresh !== 'function') return false;
      await face.refresh();
      return true;
    }

    /** A small archive glyph, matching the shipped nav icon's stroke weight. */
    function ArchiveGlyph({ size }) {
      return React.createElement('svg', {
        className: 'dsa-emptyGlyph',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        React.createElement('rect', { key: 'lid', x: 3, y: 4, width: 18, height: 4.5, rx: 1.2 }),
        React.createElement('path', { key: 'body', d: 'M4.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8.5' }),
        React.createElement('path', { key: 'slot', d: 'M9.5 13h5' }),
      ]);
    }

    /**
     * The archived-session page.
     *
     * `useWorkspaces` and `useSessions` are standard props of a
     * `settings.section` entry: the renderer's standard kit supplies them to
     * every section, so the page reads the same stores the sidebar reads and
     * stays live without polling. `restore` is this bundle's own injection (the
     * lazy workspace-service call); `t` comes from the entry's locale
     * namespace.
     * @param props - the section's kit.
     * @returns the rendered page.
     */
    function ArchivedSessionsSection({ useWorkspaces, useSessions, restore, refreshCatalog, t }) {
      const archivedIds = useWorkspaces((state) => state.archivedSessionIds);
      const sessionsById = useSessions((state) => state.byId);
      const [facts, setFacts] = useState({ byId: {}, error: null, ready: false });
      const [confirming, setConfirming] = useState(null);
      const [busy, setBusy] = useState({});
      const [status, setStatus] = useState(null);
      const [now, setNow] = useState(() => Date.now());
      const confirmRef = useRef(null);
      const cancelRef = useRef(null);
      /**
       * Titles of rows whose delete is in flight. The purge removes the log and
       * the catalog pull then drops the summary, all while the archive entry —
       * and therefore this row — still exists; holding the title keeps that row
       * from flashing "record is gone" on its way out.
       */
      const heldTitles = useRef({});

      const ids = useMemo(
        () => (Array.isArray(archivedIds) ? archivedIds.filter((id) => typeof id === 'string') : []),
        [archivedIds],
      );

      /** Read the Host's on-disk facts; the page degrades without them. */
      const loadFacts = useCallback(async () => {
        try {
          const response = await fetch(`${ROUTE}/archived`, { cache: 'no-store' });
          const body = await response.json();
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`);
          const byId = {};
          for (const entry of Array.isArray(body.sessions) ? body.sessions : []) {
            if (typeof entry?.id === 'string') byId[entry.id] = entry;
          }
          setFacts({ byId, error: null, ready: true });
        } catch (error) {
          setFacts({ byId: {}, error: messageOf(error), ready: true });
        }
      }, []);

      // One effect for both: the first read, and a re-read whenever the archive
      // set changes (archiving, restoring, deleting all land here).
      useEffect(() => {
        void loadFacts();
      }, [loadFacts, ids]);

      // Relative labels stay honest while the page sits open.
      useEffect(() => {
        const handle = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(handle);
      }, []);

      const rows = useMemo(() => {
        const built = [];
        ids.forEach((id, archivedRank) => {
          const summary = sessionsById?.[id];
          // Sidebar parity: a subagent-origin session is never a sidebar row, and
          // its log belongs to the lineage that owns it, so it is not offered here.
          if (summary?.origin === 'subagent') return;
          const factsForId = facts.byId[id];
          // The app's own display policy: stored title, else the workspace
          // directory's name, else the id — the same fallback the sidebar rows use.
          const rawTitle = typeof summary?.displayTitle === 'string' && summary.displayTitle !== ''
            ? summary.displayTitle
            : (typeof summary?.title === 'string' ? summary.title.trim() : '');
          // A delete in flight purges the log and then pulls the catalog clean
          // before the archive entry goes away, so for a moment the summary is
          // already gone while the row still has to render. Hold the title it had
          // rather than flashing the "record is gone" state at the user.
          const held = heldTitles.current[id];
          const deleting = busy[id] === 'delete';
          const summarized = summary !== undefined;
          const title = summarized
            ? (summary.blank === true ? t('row.blank') : (rawTitle === '' ? t('row.untitled') : rawTitle))
            : (deleting && held !== undefined ? held : t('row.missing'));
          const updatedAt = typeof summary?.updatedAt === 'number' && summary.updatedAt > 0
            ? summary.updatedAt
            : null;
          const artifacts = Array.isArray(factsForId?.artifacts) ? factsForId.artifacts : null;
          const logArtifact = artifacts?.find((artifact) => artifact?.kind === 'log-directory') ?? null;
          built.push({
            id,
            archivedRank,
            title,
            present: summarized || (deleting && held !== undefined),
            cwd: typeof summary?.cwd === 'string' && summary.cwd !== '' ? summary.cwd : null,
            updatedAt,
            hasLog: artifacts === null ? null : artifacts.length > 0,
            logPath: typeof logArtifact?.path === 'string' ? logArtifact.path : null,
            bytes: typeof factsForId?.bytes === 'number' ? factsForId.bytes : null,
            mtimeMs: typeof factsForId?.mtimeMs === 'number' ? factsForId.mtimeMs : null,
            // Whether the session is currently open in the main view: the one
            // retention that makes deleting it unsafe.
            openInMainView: (summary?.retainedBy?.mainView ?? 0) > 0,
          });
        });
        // Newest first, by the timestamp this page actually shows. The archive set
        // stores ids and no wall-clock stamp, so the truthful visible time is the
        // session's last activity; the archive ordinal is the deterministic
        // tie-break, and each row states its position so the order is auditable.
        built.sort((left, right) => (right.updatedAt ?? -1) - (left.updatedAt ?? -1)
          || right.archivedRank - left.archivedRank);
        return built;
      }, [ids, sessionsById, facts, busy, t]);

      useEffect(() => {
        if (confirming === null) return undefined;
        cancelRef.current?.focus();
        confirmRef.current?.scrollIntoView({ block: 'nearest' });
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setConfirming(null);
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [confirming]);

      /**
       * Restore one session through the surface's own workspace service, so the
       * sidebar, the toast, and this list all follow one path.
       * @param row - the row's view.
       */
      const restoreRow = useCallback(async (row) => {
        setStatus(null);
        setBusy((current) => ({ ...current, [row.id]: 'restore' }));
        try {
          await restore(row.id);
          setStatus({ kind: 'ok', text: t('status.restored', { title: row.title }) });
        } catch (error) {
          setStatus({ kind: 'error', text: t('status.failed', { message: failureText(t, messageOf(error)) }) });
        } finally {
          setBusy((current) => {
            const next = { ...current };
            delete next[row.id];
            return next;
          });
        }
      }, [restore, t]);

      /**
       * Permanently delete one archived session through this bundle's Host
       * route. The route also unarchives it, so the row leaves this list
       * through the same workspace store that added it.
       *
       * Three steps, and the middle one is why the transition is invisible:
       *
       *  1. `purge` removes the log and the accounting but leaves the session
       *     ARCHIVED, so every surface that hides archived sessions keeps hiding
       *     it — including the sidebar, whose "hide archived" filter is the only
       *     thing standing between a log-less session and a broken row.
       *  2. the catalog pull then drops the identity while it is still hidden, so
       *     nothing can render it even for a frame.
       *  3. `forget` drops the archive entry, which is what removes this page's
       *     row. By then no other surface holds the identity at all.
       *
       * Doing it in one request instead is correct but visible: between the
       * unarchive and the pull, a session that is no longer archived and no
       * longer listed by the Host is still in the client catalog, so the sidebar
       * paints it — the flicker this ordering exists to remove.
       *
       * A failed pull does not fail the delete: step 3 still runs, and the
       * identity leaves on the next natural pull.
       *
       * The `forget` step tolerates one specific refusal — "not archived" — so
       * this half stays compatible with a Host module that does not know about
       * phases yet (it does the whole delete on the first call, making the
       * second a no-op). Any other failure is reported.
       * @param row - the row's view.
       */
      const deleteRow = useCallback(async (row) => {
        setStatus(null);
        setBusy((current) => ({ ...current, [row.id]: 'delete' }));
        /** One phase call against this bundle's Host route. */
        const phase = async (name) => {
          const response = await fetch(`${ROUTE}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: row.id, phase: name }),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`);
          return body;
        };
        try {
          await phase('purge');
          if (typeof refreshCatalog === 'function') await refreshCatalog().catch(() => {});
          try {
            await phase('forget');
          } catch (error) {
            // A phase-unaware Host already finalized on the first call.
            if (messageOf(error) !== 'session is not archived') throw error;
          }
          setStatus({ kind: 'ok', text: t('status.deleted', { title: row.title }) });
        } catch (error) {
          setStatus({ kind: 'error', text: t('status.failed', { message: failureText(t, messageOf(error)) }) });
        } finally {
          delete heldTitles.current[row.id];
          setBusy((current) => {
            const next = { ...current };
            delete next[row.id];
            return next;
          });
          setConfirming(null);
          void loadFacts();
        }
      }, [loadFacts, refreshCatalog, t]);

      /**
       * Ask for confirmation before deleting, unless the session is currently
       * open in the main view — deleting the session the user is looking at is
       * the one case where the follow-up prompt could recreate the log we just
       * removed, so it is refused with an instruction instead of being attempted.
       * @param row - the row's view.
       */
      const requestDelete = useCallback((row) => {
        heldTitles.current[row.id] = row.title;
        if (row.openInMainView === true) {
          setStatus({ kind: 'error', text: t('error.sessionOpen', { title: row.title }) });
          return;
        }
        setStatus(null);
        setConfirming(row.id);
      }, [t]);

      /**
       * The confirmation card's detail line: what a permanent delete removes.
       * @returns the detail text.
       */
      const confirmDetail = () => t('confirm.detail');

      const confirmingRow = confirming === null ? null : rows.find((row) => row.id === confirming) ?? null;

      const list = ids.length === 0
        ? React.createElement('div', { className: 'dsa-empty' }, [
          React.createElement(ArchiveGlyph, { key: 'glyph', size: 24 }),
          React.createElement('div', { key: 'title', className: 'dsa-emptyTitle' }, t('page.empty')),
          React.createElement('div', { key: 'hint', className: 'dsa-emptyHint' }, t('page.emptyHint')),
        ])
        : React.createElement('ul', { className: 'dsa-list', 'aria-label': t('aria.list') },
          rows.map((row) => {
            const pending = busy[row.id];
            const meta = [];
            if (row.present === false) {
              meta.push(React.createElement('span', {
                key: 'missing',
                className: 'dsa-metaItem',
                'data-tone': 'warn',
                title: t('row.missingHint'),
              }, t('row.missingHint')));
            } else {
              meta.push(React.createElement('span', {
                key: 'cwd',
                className: 'dsa-metaItem',
                title: row.cwd ?? undefined,
              }, row.cwd === null ? t('row.meta.cwdUnknown') : t('row.meta.cwd', { path: row.cwd })));
              const activeAt = row.mtimeMs ?? row.updatedAt;
              meta.push(React.createElement('span', {
                key: 'active',
                className: 'dsa-metaItem',
                title: activeAt === null ? undefined : absoluteLabel(activeAt, t),
              }, activeAt === null
                ? t('row.meta.activeUnknown')
                : t('row.meta.active', { time: relativeLabel(activeAt, now, t) })));
              meta.push(React.createElement('span', {
                key: 'size',
                className: 'dsa-metaItem',
                'data-tone': row.hasLog === false ? 'warn' : undefined,
              }, row.hasLog === false
                ? t('row.meta.sizeUnknown')
                : (row.bytes === null ? t('row.meta.sizeUnknown') : t('row.meta.size', { size: sizeLabel(row.bytes, t) }))));
              meta.push(React.createElement('span', {
                key: 'rank',
                className: 'dsa-metaItem',
              }, t('row.meta.rank', { n: row.archivedRank + 1 })));
            }
            return React.createElement('li', {
              key: row.id,
              className: 'dsa-row',
              'data-confirming': confirming === row.id ? 'true' : undefined,
            }, [
              React.createElement('div', { key: 'text', className: 'dsa-rowText' }, [
                React.createElement('div', {
                  key: 'title',
                  className: 'dsa-title',
                  'data-missing': row.present === false ? 'true' : undefined,
                  title: row.title,
                }, row.title),
                React.createElement('div', { key: 'meta', className: 'dsa-meta' }, meta),
              ]),
              React.createElement('div', { key: 'actions', className: 'dsa-actions' }, [
                React.createElement('button', {
                  key: 'restore',
                  type: 'button',
                  className: 'dsa-btn',
                  disabled: pending !== undefined,
                  onClick: () => { void restoreRow(row); },
                }, pending === 'restore' ? t('action.restoring') : t('action.restore')),
                React.createElement('button', {
                  key: 'delete',
                  type: 'button',
                  className: 'dsa-btn',
                  'data-tone': 'danger',
                  disabled: pending !== undefined,
                  onClick: () => { requestDelete(row); },
                }, pending === 'delete' ? t('action.deleting') : t('action.delete')),
              ]),
            ]);
          }));

      return React.createElement('div', { className: 'dsa-root' }, [
        React.createElement('h2', { key: 'heading', className: 'dsa-heading' }, t('page.title')),
        React.createElement('p', { key: 'intro', className: 'dsa-intro' }, t('page.intro', { n: ids.length })),
        confirmingRow === null ? null : React.createElement('div', {
          key: 'confirm',
          className: 'dsa-confirm',
          ref: confirmRef,
          role: 'alertdialog',
          'aria-modal': 'false',
          'aria-label': t('aria.confirm'),
        }, [
          React.createElement('div', { key: 'title', className: 'dsa-confirmTitle' }, t('confirm.title')),
          React.createElement('div', { key: 'body', className: 'dsa-confirmBody' }, t('confirm.body', { title: confirmingRow.title })),
          React.createElement('div', { key: 'detail', className: 'dsa-confirmDetail' }, confirmDetail()),
          confirmingRow.logPath === null ? null : React.createElement('div', {
            key: 'path',
            className: 'dsa-confirmDetail',
          }, t('confirm.path', { path: confirmingRow.logPath })),
          React.createElement('div', { key: 'hint', className: 'dsa-confirmHint' }, t('confirm.hint')),
          React.createElement('div', { key: 'actions', className: 'dsa-confirmActions' }, [
            React.createElement('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsa-btn',
              ref: cancelRef,
              onClick: () => setConfirming(null),
            }, t('confirm.cancel')),
            React.createElement('button', {
              key: 'confirm',
              type: 'button',
              className: 'dsa-btn',
              'data-variant': 'solid-danger',
              disabled: busy[confirmingRow.id] !== undefined,
              onClick: () => { void deleteRow(confirmingRow); },
            }, t('confirm.confirm')),
          ]),
        ]),
        status === null ? null : React.createElement('div', {
          key: 'status',
          className: 'dsa-banner',
          'data-kind': status.kind,
          role: 'status',
        }, status.text),
        facts.error === null ? null : React.createElement('div', {
          key: 'readError',
          className: 'dsa-banner',
          'data-kind': 'warn',
        }, t('page.readError', { message: facts.error })),
        list,
      ]);
    }

    return {
      name: NS,
      // `slots` and `locale` are all this half requires to render. The workspace
      // service is reached lazily at call time, so a composition without it
      // still shows the page (and reports why restoring is unavailable) instead
      // of dropping the whole plugin.
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the Settings page, and own both.
       * @param ctx - the client plugin context.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        // Styles and dictionaries are effects, so disabling the plugin removes
        // both; the tag is keyed so a re-apply reinstalls exactly one.
        ctx.effect(() => {
          const tag = ensureStyles();
          return () => {
            if (tag !== null) tag.remove();
          };
        }, 'session-archive: stylesheet');
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-archive: dictionaries');
        // The sidebar is deliberately left alone: its own default already hides
        // archived sessions, and its View options menu stays the user's to use.
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: SECTION_ID,
          order: SECTION_ORDER,
          // A thunk label is re-read on every projection, and the settings shell
          // re-reads these rows on locale change — so the nav entry follows the
          // active locale without re-registering.
          label: () => t('nav.label'),
          locale: NS,
          inject: () => ({
            /**
             * Restore one archived session through the surface's workspace
             * service — the same call the sidebar's row action makes.
             * @param sessionId - the archived session id.
             */
            restore: async (sessionId) => {
              const face = ctx.get('uiWorkspace');
              if (face === undefined) throw new Error(t('error.noUiWorkspace'));
              await face.unarchiveSession(sessionId);
            },
            /**
             * Re-pull the session catalog, so a permanently deleted session
             * leaves every client surface — the sidebar above all, which would
             * otherwise keep rendering its row (a deleted session is no longer
             * archived, so nothing hides it) and fail on open with
             * `session/not-found`.
             * @returns whether a pull was issued.
             */
            refreshCatalog: () => refreshSessionCatalog(ctx),
          }),
        }, ArchivedSessionsSection));
      },
    };
  },
});
