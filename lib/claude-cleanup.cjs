// Local account-data removal. No credentials or database values are printed.
// The CLI is Windows-only; exported functions are tested against synthetic profiles.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ClassicLevel } = require('classic-level');

const domains = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com'];
const processes = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe', 'arc.exe', 'claude.exe', 'code.exe', 'code - insiders.exe', 'vscodium.exe', 'cursor.exe', 'windsurf.exe'];
const authVariables = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_API_KEY'];
const authSettings = ['apiKeyHelper', 'forceLoginOrgUUID', 'forceLoginMethod'];
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const under = (p, root) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
function fail(code) { const e = Error(code); e.code = code; throw e; }
function targetHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  return domains.some(d => host === d || host.endsWith('.' + d));
}
function targetURL(value) { try { return targetHost(new URL(String(value)).hostname); } catch { return targetHost(value); } }
function targetOrigin(value) {
  // Match origin-bearing storage keys, including Chromium's scheme_host_port names.
  return domains.some(d => new RegExp('(^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*' + d.replaceAll('.', '\\.') + '(?=$|[^a-z0-9.-])', 'i').test(String(value)));
}
function extensionKey(value) { return /anthropic\.claude-code|claudevscode|claude-sessions-sidebar|claude-sidebar-secondary/i.test(String(value)); }
function assertSafe(file, roots, recursive = false, checked = null) {
  const absolute = path.resolve(file);
  if (!roots.some(root => under(absolute, path.resolve(root)))) fail('OUTSIDE_APPROVED_SCOPE');
  // Reject junctions/reparse symlinks in every existing ancestor, not only the leaf.
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (checked?.has(current)) continue;
    if (!fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry:false })) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !same(fs.realpathSync.native(current), path.resolve(current))) fail('LINKED_PATH_REJECTED');
    checked?.add(current);
  }
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (stat.isFile() && stat.nlink > 1) fail('HARDLINK_REJECTED');
    if (recursive && stat.isDirectory()) for (const name of fs.readdirSync(absolute)) assertSafe(path.join(absolute, name), roots, true, checked);
  }
  return absolute;
}
function makePlan(context) {
  const { home, local, roaming } = context;
  for (const root of [home, local, roaming]) if (!root || !path.isAbsolute(root) || same(path.resolve(root), path.parse(root).root)) fail('INVALID_USER_ROOT');
  const plan = { context, roots:[], operations:[], issues:[], notices:[] };
  const seen = new Set();
  // Discovery does not mutate data; cache ancestor checks only for this preview.
  // applyPlan always revalidates each full target tree using a fresh check set.
  const checked = new Set();
  const root = p => { plan.roots.push(path.resolve(p)); return p; };
  function issue(label, e) { plan.issues.push({label, code:e.code || 'DISCOVERY_FAILED'}); }
  function children(p) {
    if (!fs.existsSync(p)) return [];
    try { assertSafe(p, plan.roots, false, checked); return fs.readdirSync(p, {withFileTypes:true}); }
    catch (e) { issue(p, e); return []; }
  }
  function add(kind, file, label, extra = {}) {
    if (!fs.existsSync(file) && !fs.lstatSync(file, {throwIfNoEntry:false})) return;
    try {
      // Do not walk large cache trees during preview. Nested links are checked before apply.
      assertSafe(file, plan.roots, false, checked);
      const key = kind + ':' + path.resolve(file);
      if (!seen.has(key)) { seen.add(key); plan.operations.push({kind, file:path.resolve(file), label, ...extra}); }
    } catch (e) { issue(label, e); }
  }
  const cli = root(path.join(home, '.claude'));
  // Only these explicit user-level files are eligible; project .claude folders are never traversed.
  const userFiles = ['.claude.json', ...fs.readdirSync(home).filter(n => /^\.claude\.json\.(?:backup|bak)(?:[.-].*)?$/.test(n))];
  for (const name of userFiles) { const p = root(path.join(home, name)); add('delete', p, 'Claude Code account metadata'); }
  for (const entry of children(cli)) {
    if (/^(backups|projects|sessions|session-env|shell-snapshots|debug|statsig|telemetry|cache|ide|todos|tasks|plans|history\.jsonl|stats-cache\.json|\.credentials\.json(?:\..*)?|settings\.json\.(?:bak|backup)(?:\..*)?)$/.test(entry.name)) add('delete', path.join(cli, entry.name), 'Claude Code credentials/history/cache');
  }
  add('settings', path.join(cli, 'settings.json'), 'Claude Code global authentication settings');

  const chromium = [
    ['Chrome', path.join(local, 'Google', 'Chrome', 'User Data')],
    ['Edge', path.join(local, 'Microsoft', 'Edge', 'User Data')],
    ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Vivaldi', path.join(local, 'Vivaldi', 'User Data')],
    ['Opera', path.join(roaming, 'Opera Software', 'Opera Stable')],
    ['Opera GX', path.join(roaming, 'Opera Software', 'Opera GX Stable')]
  ];
  function browser(profile, label) {
    for (const [file, type] of [['Network/Cookies','cookies'], ['Cookies','cookies'], ['Login Data','logins'], ['Login Data For Account','logins'], ['History','history']]) add('sqlite', path.join(profile, ...file.split('/')), label + ' site records', {type});
    for (const [dir, type] of [['Local Storage/leveldb','local'], ['Session Storage','session']]) {
      const p = path.join(profile, ...dir.split('/'));
      if (fs.existsSync(path.join(p, 'CURRENT'))) add('level', p, label + ' site storage', {type});
    }
    add('origins', path.join(profile, 'Preferences'), label + ' site preferences');
    for (const dir of ['IndexedDB', 'Storage']) for (const entry of children(path.join(profile, dir))) if (targetOrigin(entry.name)) add('delete', path.join(profile, dir, entry.name), label + ' Claude origin storage');
    // Shared, disposable browser caches are explicit in the confirmation and documentation.
    for (const dir of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'Service Worker']) add('delete', path.join(profile, dir), label + ' shared cache/offline service-worker data');
    const extensions = path.join(profile, 'Extensions');
    for (const ext of children(extensions)) {
      if (!/^[a-p]{32}$/.test(ext.name) || !ext.isDirectory()) continue;
      let identified = false;
      for (const version of children(path.join(extensions, ext.name))) {
        const dir = path.join(extensions, ext.name, version.name), manifest = path.join(dir, 'manifest.json');
        if (!fs.existsSync(manifest)) continue;
        try {
          assertSafe(manifest, plan.roots, false, checked); const m = readJSON(manifest); let name = m.name || '';
          const message = name.match(/^__MSG_([A-Za-z0-9_]+)__$/);
          if (message) for (const lang of [m.default_locale, 'en', 'en_US', 'zh_CN'].filter(x => /^[A-Za-z0-9_]+$/.test(x || ''))) {
            const messages = path.join(dir, '_locales', lang, 'messages.json');
            if (fs.existsSync(messages)) { assertSafe(messages, plan.roots, false, checked); name = readJSON(messages)[message[1]]?.message || name; }
          }
          if (/\b(?:Claude|Anthropic)\b/i.test(name)) identified = true;
        } catch (e) { issue(label + ' extension manifest', e); }
      }
      if (identified) {
        for (const dir of ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings', 'IndexedDB']) {
          const name = dir === 'IndexedDB' ? 'chrome-extension_' + ext.name + '_0.indexeddb.leveldb' : ext.name;
          add('delete', path.join(profile, dir, name), label + ' Claude extension data');
        }
        plan.notices.push(label + ': Claude-related extension detected; installation is retained; synced data may return.');
      }
    }
  }
  for (const [name, base] of chromium) {
    root(base);
    if (fs.existsSync(path.join(base, 'Preferences'))) browser(base, name);
    for (const entry of children(base)) if (entry.isDirectory() && /^(Default|Profile \d+|Guest Profile)$/.test(entry.name)) browser(path.join(base, entry.name), name + ' / ' + entry.name);
  }
  const firefox = root(path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'));
  for (const entry of children(firefox)) if (entry.isDirectory()) {
    const p = path.join(firefox, entry.name), label = 'Firefox / ' + entry.name;
    add('sqlite', path.join(p, 'cookies.sqlite'), label + ' cookies', {type:'firefox-cookies'});
    add('sqlite', path.join(p, 'places.sqlite'), label + ' history', {type:'firefox-history'});
    add('firefox-logins', path.join(p, 'logins.json'), label + ' Claude saved logins');
    for (const dir of ['default', 'permanent', 'temporary']) for (const origin of children(path.join(p, 'storage', dir))) if (targetOrigin(origin.name)) add('delete', path.join(p, 'storage', dir, origin.name), label + ' Claude origin storage');
  }

  const desktop = [path.join(roaming, 'Claude'), path.join(local, 'Claude-3p')];
  const external = root(path.join(local, 'Claude-Data'));
  for (const entry of children(external)) if (entry.isDirectory() && /^claude_[a-z0-9]+$/i.test(entry.name)) desktop.push(path.join(external, entry.name));
  const packages = root(path.join(local, 'Packages'));
  for (const entry of children(packages)) if (entry.isDirectory() && /^Claude_[a-z0-9]+$/i.test(entry.name)) {
    for (const dir of ['Roaming', 'Local']) desktop.push(path.join(packages, entry.name, 'LocalCache', dir, 'Claude'));
    plan.notices.push('Packaged Claude: only recognized profile data is cleaned; unrecognized LocalState/Cowork data requires manual review.');
  }
  for (const base of desktop) {
    root(base);
    for (const name of ['Network', 'Cookies', 'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Service Worker', 'Cache', 'Code Cache', 'GPUCache', 'Crashpad', 'sentry', 'logs', 'blob_storage', 'claude-code-sessions', 'configLibrary', 'config.json', 'config.json.journal', 'plan-usage-history.json', 'remote-control-state.json']) add('delete', path.join(base, name), 'Claude desktop login/session/cache');
    if (fs.existsSync(path.join(base, 'local-agent-mode-sessions'))) plan.notices.push('Cowork local-agent-mode-sessions retained: review manually to avoid deleting VM/work files.');
    add('desktop-settings', path.join(base, 'claude_desktop_config.json'), 'Claude desktop account preferences');
  }
  const desktopLogs = root(path.join(local, 'Claude', 'logs')); add('delete', desktopLogs, 'Claude desktop logs');
  for (const editor of ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf']) {
    const base = root(path.join(roaming, editor)), user = path.join(base, 'User');
    const users = [user, ...children(path.join(user, 'profiles')).filter(e => e.isDirectory()).map(e => path.join(user, 'profiles', e.name))];
    for (const u of users) {
      const global = path.join(u, 'globalStorage');
      add('delete', path.join(global, 'anthropic.claude-code'), editor + ' Claude extension storage');
      const states = [global, ...children(path.join(u, 'workspaceStorage')).filter(e => e.isDirectory()).map(e => path.join(u, 'workspaceStorage', e.name))];
      for (const s of states) for (const n of ['state.vscdb', 'state.vscdb.backup']) add('sqlite', path.join(s, n), editor + ' Claude extension state', {type:'vscode'});
    }
    function logs(dir, depth = 0) {
      if (depth > 8) return;
      for (const e of children(dir)) if (e.isDirectory()) {
        if (/^(anthropic\.claude-code|claude-code)$/i.test(e.name)) add('delete', path.join(dir, e.name), editor + ' Claude extension logs');
        else logs(path.join(dir, e.name), depth + 1);
      }
    }
    logs(path.join(base, 'logs'));
  }
  // Do not descend into CloudStack instances, project directories, arbitrary custom profiles or WSL.
  return plan;
}
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function writeJSON(file, value) {
  const temporary = file + '.cloud-stack-cleanup.tmp';
  // Exclusive create prevents following a pre-existing link or clobbering someone else's file.
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } catch (e) { fs.unlinkSync(temporary); throw e; }
}
function pruneOrigins(value) {
  let count = 0;
  if (!value || typeof value !== 'object') return count;
  for (const key of Object.keys(value)) {
    if (targetOrigin(key)) { delete value[key]; count++; }
    else count += pruneOrigins(value[key]);
  }
  return count;
}
function cleanJSON(op) {
  const value = readJSON(op.file); let changed = 0;
  if (op.kind === 'origins') changed = pruneOrigins(value);
  if (op.kind === 'settings') {
    for (const k of authVariables) if (value.env && Object.hasOwn(value.env, k)) { delete value.env[k]; changed++; }
    for (const k of authSettings) if (Object.hasOwn(value, k)) { delete value[k]; changed++; }
  }
  if (op.kind === 'desktop-settings') {
    for (const k of Object.keys(value)) if (!['mcpServers', 'coworkUserFilesPath'].includes(k)) { delete value[k]; changed++; }
  }
  if (op.kind === 'firefox-logins') {
    if (!Array.isArray(value.logins)) fail('UNRECOGNIZED_FIREFOX_LOGINS');
    const kept = value.logins.filter(x => !targetURL(x.hostname)); changed = value.logins.length - kept.length; value.logins = kept;
  }
  if (changed) writeJSON(op.file, value);
  return changed;
}
function cleanSQLite(op) {
  const db = new DatabaseSync(op.file, {enableForeignKeyConstraints:false}); let changed = 0;
  try {
    db.function('is_target', v => targetURL(v) ? 1 : 0);
    db.function('is_extension', v => extensionKey(v) ? 1 : 0);
    db.exec('PRAGMA busy_timeout=1500; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
    const run = sql => { changed += Number(db.prepare(sql).run().changes); };
    const requireTable = name => { if (!tables.has(name)) fail('UNRECOGNIZED_DATABASE_SCHEMA'); };
    if (op.type === 'cookies') { requireTable('cookies'); run('DELETE FROM cookies WHERE is_target(host_key)'); }
    else if (op.type === 'logins') {
      requireTable('logins'); run('DELETE FROM logins WHERE is_target(origin_url) OR is_target(signon_realm)');
      if (tables.has('stats')) run('DELETE FROM stats WHERE is_target(origin_domain)');
    } else if (op.type === 'history') {
      requireTable('urls');
      if (tables.has('visits')) run('DELETE FROM visits WHERE url IN (SELECT id FROM urls WHERE is_target(url))');
      if (tables.has('keyword_search_terms')) run('DELETE FROM keyword_search_terms WHERE url_id IN (SELECT id FROM urls WHERE is_target(url))');
      run('DELETE FROM urls WHERE is_target(url)');
      if (tables.has('downloads') && tables.has('downloads_url_chains')) {
        run('DELETE FROM downloads WHERE id IN (SELECT id FROM downloads_url_chains WHERE is_target(url))');
        run('DELETE FROM downloads_url_chains WHERE is_target(url)');
      }
    } else if (op.type === 'vscode') { requireTable('ItemTable'); run('DELETE FROM ItemTable WHERE is_extension(key)'); }
    else if (op.type === 'firefox-cookies') { requireTable('moz_cookies'); run('DELETE FROM moz_cookies WHERE is_target(host)'); }
    else if (op.type === 'firefox-history') {
      requireTable('moz_places');
      if (tables.has('moz_historyvisits')) run('DELETE FROM moz_historyvisits WHERE place_id IN (SELECT id FROM moz_places WHERE is_target(url))');
      // Bookmarks are deliberately retained; deleting their referenced place would corrupt them.
      const keep = tables.has('moz_bookmarks') ? ' AND id NOT IN (SELECT fk FROM moz_bookmarks WHERE fk IS NOT NULL)' : '';
      run('DELETE FROM moz_places WHERE is_target(url)' + keep);
    } else fail('UNKNOWN_DATABASE_TYPE');
    db.exec('COMMIT');
    if (changed) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); }
    return changed;
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  finally { db.close(); }
}
async function cleanLevel(op) {
  const db = new ClassicLevel(op.file, {createIfMissing:false, keyEncoding:'buffer', valueEncoding:'buffer'});
  try {
    await db.open(); const entries = [], maps = new Set();
    for await (const [key, value] of db.iterator()) {
      entries.push([key, value]); const text = key.toString('utf8');
      if (op.type === 'session' && text.startsWith('namespace-') && targetOrigin(text)) maps.add(value.toString('utf8'));
    }
    const doomed = entries.filter(([key]) => {
      const text = key.toString('utf8');
      return targetOrigin(text) || (op.type === 'session' && [...maps].some(id => text.startsWith('map-' + id + '-')));
    });
    if (doomed.length) {
      await db.batch(doomed.map(([key]) => ({type:'del', key})), {sync:true});
      await db.compactRange(Buffer.alloc(0), Buffer.from([255,255,255,255]));
    }
    return doomed.length;
  } finally { await db.close(); }
}
async function applyPlan(plan) {
  const report = {time:new Date().toISOString(), completed:[], errors:[...plan.issues], notices:plan.notices};
  // Revalidate every operation before the first mutation, then recheck at each operation.
  for (const op of plan.operations) assertSafe(op.file, plan.roots, op.kind === 'delete' || op.kind === 'level', new Set());
  for (const op of plan.operations) {
    try {
      if (!fs.existsSync(op.file)) continue;
      assertSafe(op.file, plan.roots, op.kind === 'delete' || op.kind === 'level', new Set());
      // SQLite WAL/SHM files must not lead to unrelated files either.
      if (op.kind === 'sqlite') for (const suffix of ['-wal','-shm','-journal']) assertSafe(op.file + suffix, plan.roots);
      let changed;
      if (op.kind === 'delete') { fs.rmSync(op.file, {recursive:true, force:false}); changed = 1; }
      else if (op.kind === 'sqlite') changed = cleanSQLite(op);
      else if (op.kind === 'level') changed = await cleanLevel(op);
      else changed = cleanJSON(op);
      report.completed.push({label:op.label, kind:op.kind, changed});
    } catch (e) { report.errors.push({label:op.label, code:e.code || 'OPERATION_FAILED'}); }
  }
  return report;
}
function assertApplicationsClosed() {
  const result = cp.spawnSync('tasklist.exe', ['/FO','CSV','/NH'], {encoding:'utf8', windowsHide:true, timeout:15000});
  if (result.status !== 0) fail('PROCESS_CHECK_FAILED');
  const names = result.stdout.split(/\r?\n/).map(line => line.match(/^"([^"]+)"/)?.[1]?.toLowerCase());
  if (processes.some(name => names.includes(name))) fail('CLOSE_BROWSERS_CLAUDE_AND_EDITORS_FIRST');
}
async function main() {
  if (process.platform !== 'win32') fail('WINDOWS_ONLY');
  const args = process.argv.slice(2);
  if (args.some(x => !['--preview', '--apply', '--confirm-delete-local-data'].includes(x))) fail('UNKNOWN_ARGUMENT');
  const apply = args.includes('--apply');
  if (apply && !args.includes('--confirm-delete-local-data')) fail('EXPLICIT_DELETE_CONFIRMATION_REQUIRED');
  const plan = makePlan({home:process.env.USERPROFILE, local:process.env.LOCALAPPDATA, roaming:process.env.APPDATA});
  if (!apply) {
    console.log(JSON.stringify({mode:'preview', operations:plan.operations.map(({kind,file,label}) => ({kind,file,label})), issues:plan.issues, notices:plan.notices}, null, 2));
    return;
  }
  if (plan.issues.length) fail('DISCOVERY_ISSUES_REVIEW_PREVIEW');
  assertApplicationsClosed();
  const report = await applyPlan(plan);
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.code || 'CLEANUP_FAILED'); process.exitCode = 1; });
module.exports = {makePlan, applyPlan, assertSafe, targetHost, targetURL, targetOrigin, cleanSQLite, cleanLevel, cleanJSON};
