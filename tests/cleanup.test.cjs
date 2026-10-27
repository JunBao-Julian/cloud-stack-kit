const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ClassicLevel } = require('classic-level');
const {makePlan, applyPlan, assertSafe, targetHost, targetURL, targetOrigin, cleanSQLite, cleanLevel} = require('../lib/claude-cleanup.cjs');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-stack-cleanup-test-'));
  const context = {home:path.join(base, 'user'), local:path.join(base, 'user', 'Local'), roaming:path.join(base, 'user', 'Roaming')};
  Object.values(context).forEach(p => fs.mkdirSync(p, {recursive:true}));
  return {base, context, remove() {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.match(path.basename(base), /^cloud-stack-cleanup-test-/);
    fs.rmSync(base, {recursive:true, force:true});
  }};
}
function write(file, value = 'TEST DATA') { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, value); }
function createDB(file, sql) {
  fs.mkdirSync(path.dirname(file), {recursive:true}); const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}
function rows(file, sql) { const db = new DatabaseSync(file, {readOnly:true}); try { return db.prepare(sql).all(); } finally { db.close(); } }

test('cleanup origin matching includes subdomains but excludes lookalikes', () => {
  for (const value of ['claude.ai', '.claude.ai', 'api.anthropic.com']) assert.equal(targetHost(value), true);
  for (const value of ['notclaude.ai', 'claude.ai.example.org', 'evil-anthropic.com']) assert.equal(targetHost(value), false);
  assert.equal(targetURL('https://example.com/?next=https://claude.ai'), false);
  for (const value of ['_https://api.anthropic.com\x00TOKEN', 'https_claude.ai_0.indexeddb.leveldb', 'https+++claude.ai^userContextId=2']) assert.equal(targetOrigin(value), true);
  for (const value of ['_https://claude.ai.evil.test\0', 'https_notclaude.ai_0.indexeddb.leveldb']) assert.equal(targetOrigin(value), false);
});

test('preview is read-only; apply preserves projects, other sites, CloudStack and MCP settings', async () => {
  const f = fixture(); const {home, local, roaming} = f.context;
  try {
    const old = path.join(home, '.claude', 'projects', 'old', 'session.jsonl'); write(old);
    const source = path.join(home, 'code', 'project', '.claude', 'settings.json'); write(source, '{"keep":true}');
    const cloud = path.join(local, 'CloudStack', 'new-vps', 'claude-settings.json'); write(cloud, '{"keep":true}');
    const plugin = path.join(home, '.claude', 'plugins', 'my-plugin.cjs'); write(plugin, 'KEEP');
    const cowork = path.join(roaming, 'Claude', 'local-agent-mode-sessions', 'work.vhdx'); write(cowork, 'KEEP');
    const settings = path.join(home, '.claude', 'settings.json'); write(settings, JSON.stringify({env:{ANTHROPIC_API_KEY:'TEST',OTHER:'KEEP'},permissions:{allow:['Read']}}));
    const desktop = path.join(roaming, 'Claude', 'claude_desktop_config.json'); write(desktop, JSON.stringify({oauthAccount:{id:'TEST'},mcpServers:{example:{command:'keep'}},coworkUserFilesPath:'KEEP-WORK-PATH'}));
    const cookie = path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies');
    createDB(cookie, "CREATE TABLE cookies(host_key TEXT,value TEXT); INSERT INTO cookies VALUES('.claude.ai','TEST'),('.example.org','KEEP');");
    const before = fs.readFileSync(cookie); const plan = makePlan(f.context);
    assert.ok(fs.existsSync(old)); assert.deepEqual(fs.readFileSync(cookie), before);
    assert.ok(!plan.operations.some(x => x.file === source || x.file === cloud || x.file === plugin));
    const report = await applyPlan(plan); assert.deepEqual(report.errors, []);
    assert.equal(fs.existsSync(old), false); assert.equal(fs.readFileSync(plugin,'utf8'), 'KEEP');
    assert.equal(fs.readFileSync(cowork,'utf8'), 'KEEP');
    for (const file of [source,cloud]) assert.equal(fs.readFileSync(file,'utf8'), '{"keep":true}');
    assert.deepEqual(JSON.parse(fs.readFileSync(settings)), {env:{OTHER:'KEEP'},permissions:{allow:['Read']}});
    assert.deepEqual(JSON.parse(fs.readFileSync(desktop)), {mcpServers:{example:{command:'keep'}},coworkUserFilesPath:'KEEP-WORK-PATH'});
    assert.deepEqual(rows(cookie,'SELECT host_key FROM cookies').map(x=>x.host_key), ['.example.org']);
  } finally { f.remove(); }
});

test('SQLite cleanup removes only Claude passwords, history and extension state', () => {
  const f = fixture();
  try {
    const login = path.join(f.base, 'Login Data');
    createDB(login, "CREATE TABLE logins(origin_url TEXT, signon_realm TEXT); INSERT INTO logins VALUES('https://claude.ai','https://claude.ai'),('https://example.org','https://example.org');");
    cleanSQLite({file:login,type:'logins'}); assert.equal(rows(login,'SELECT count(*) AS n FROM logins')[0].n, 1);
    const history = path.join(f.base,'History');
    createDB(history, "CREATE TABLE urls(id INTEGER,url TEXT); CREATE TABLE visits(url INTEGER); CREATE TABLE keyword_search_terms(url_id INTEGER); INSERT INTO urls VALUES(1,'https://claude.ai/chat/TEST'),(2,'https://example.org'); INSERT INTO visits VALUES(1),(2); INSERT INTO keyword_search_terms VALUES(1),(2);");
    cleanSQLite({file:history,type:'history'});
    for (const table of ['urls','visits','keyword_search_terms']) assert.equal(rows(history,`SELECT count(*) AS n FROM ${table}`)[0].n, 1);
    const vscode = path.join(f.base,'state.vscdb');
    createDB(vscode, "CREATE TABLE ItemTable(key TEXT,value TEXT); INSERT INTO ItemTable VALUES('secret://anthropic.claude-code','TEST'),('other.extension','KEEP');");
    cleanSQLite({file:vscode,type:'vscode'}); assert.deepEqual(rows(vscode,'SELECT key FROM ItemTable').map(x=>x.key), ['other.extension']);
  } finally { f.remove(); }
});

test('Firefox history keeps bookmarks and unrelated visits', () => {
  const f = fixture();
  try {
    const file = path.join(f.base, 'places.sqlite');
    createDB(file, "CREATE TABLE moz_places(id INTEGER,url TEXT); CREATE TABLE moz_historyvisits(place_id INTEGER); CREATE TABLE moz_bookmarks(fk INTEGER); INSERT INTO moz_places VALUES(1,'https://claude.ai'),(2,'https://example.org'),(3,'https://claude.ai/bookmarked'); INSERT INTO moz_historyvisits VALUES(1),(2),(3); INSERT INTO moz_bookmarks VALUES(3);");
    cleanSQLite({file,type:'firefox-history'});
    assert.deepEqual(rows(file,'SELECT id FROM moz_places ORDER BY id').map(x=>x.id), [2,3]);
    assert.deepEqual(rows(file,'SELECT place_id FROM moz_historyvisits').map(x=>x.place_id), [2]);
  } finally { f.remove(); }
});

test('LevelDB removes target origins and their session map without touching other origins', async () => {
  const f = fixture();
  try {
    const file = path.join(f.base,'Session Storage'); const db = new ClassicLevel(file, {valueEncoding:'utf8'});
    await db.open();
    await db.batch([
      {type:'put',key:'namespace-test-https://claude.ai',value:'7'},
      {type:'put',key:'map-7-token',value:'TEST'},
      {type:'put',key:'namespace-test-https://example.org',value:'8'},
      {type:'put',key:'map-8-token',value:'KEEP'},
      {type:'put',key:'_https://claude.ai.evil.test\0token',value:'KEEP'}
    ]); await db.close();
    assert.equal(await cleanLevel({file,type:'session'}), 2);
    const check = new ClassicLevel(file); await check.open();
    try { assert.deepEqual((await check.keys().all()).sort(), ['_https://claude.ai.evil.test\0token','map-8-token','namespace-test-https://example.org'].sort()); }
    finally { await check.close(); }
  } finally { f.remove(); }
});

test('linked directories, nested links, hardlinks and out-of-scope paths are rejected', async () => {
  const f = fixture();
  try {
    const root = path.join(f.context.home,'.claude'); fs.mkdirSync(root);
    const outside = path.join(f.base,'unrelated'); write(path.join(outside,'keep.txt'),'KEEP');
    fs.symlinkSync(outside, path.join(root,'projects'), process.platform==='win32'?'junction':'dir');
    const plan = makePlan(f.context); assert.ok(plan.issues.some(x=>x.code==='LINKED_PATH_REJECTED'));
    assert.ok(!plan.operations.some(x=>x.file===path.join(root,'projects')));
    const nested = path.join(root,'sessions'); fs.mkdirSync(nested); fs.symlinkSync(outside,path.join(nested,'link'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>assertSafe(nested,[root],true),/LINKED_PATH_REJECTED/);
    const hard = path.join(root,'history.jsonl'); fs.linkSync(path.join(outside,'keep.txt'),hard);
    assert.throws(()=>assertSafe(hard,[root]),/HARDLINK_REJECTED/);
    assert.throws(()=>assertSafe(outside,[root]),/OUTSIDE_APPROVED_SCOPE/);
    assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'KEEP');
  } finally { f.remove(); }
});

test('unexpected database schema reports failure without deleting unrelated content', async () => {
  const f = fixture();
  try {
    const file = path.join(f.context.local,'Google','Chrome','User Data','Default','Network','Cookies');
    createDB(file, "CREATE TABLE future_cookie_schema(value TEXT); INSERT INTO future_cookie_schema VALUES('KEEP');");
    const report = await applyPlan(makePlan(f.context));
    assert.equal(report.errors.length, 1); assert.equal(report.errors[0].code, 'UNRECOGNIZED_DATABASE_SCHEMA');
    assert.equal(rows(file,'SELECT value FROM future_cookie_schema')[0].value, 'KEEP');
  } finally { f.remove(); }
});

test('apply checks nested links before deleting any earlier planned file', async () => {
  const f = fixture();
  try {
    const history = path.join(f.context.home,'.claude','history.jsonl'); write(history,'KEEP');
    const sessions = path.join(f.context.home,'.claude','sessions'); fs.mkdirSync(sessions);
    const outside = path.join(f.base,'unrelated'); write(path.join(outside,'keep.txt'),'KEEP');
    fs.symlinkSync(outside,path.join(sessions,'linked'),process.platform==='win32'?'junction':'dir');
    const plan = makePlan(f.context);
    assert.equal(plan.issues.length,0); // Preview does not walk cache/session trees.
    await assert.rejects(applyPlan(plan),/LINKED_PATH_REJECTED/);
    assert.equal(fs.readFileSync(history,'utf8'),'KEEP');
    assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'KEEP');
  } finally { f.remove(); }
});

test('rescan does not schedule deleted history and repeat cleanup is harmless', async () => {
  const f = fixture();
  try {
    const file = path.join(f.context.home,'.claude','history.jsonl'); write(file);
    assert.equal((await applyPlan(makePlan(f.context))).errors.length, 0);
    const again = makePlan(f.context); assert.equal(again.operations.length, 0);
    assert.deepEqual((await applyPlan(again)).errors, []);
  } finally { f.remove(); }
});

test('Windows CLI refuses deletion without explicit confirmation', {skip:process.platform !== 'win32'}, () => {
  const f = fixture();
  try {
    const file = path.join(f.context.home,'.claude','history.jsonl'); write(file,'KEEP');
    const result = cp.spawnSync(process.execPath,[path.join(__dirname,'../lib/claude-cleanup.cjs'),'--apply'], {
      encoding:'utf8',windowsHide:true,env:{...process.env,USERPROFILE:f.context.home,LOCALAPPDATA:f.context.local,APPDATA:f.context.roaming}
    });
    assert.equal(result.status,1); assert.match(result.stderr,/EXPLICIT_DELETE_CONFIRMATION_REQUIRED/);
    assert.equal(fs.readFileSync(file,'utf8'),'KEEP');
  } finally { f.remove(); }
});
