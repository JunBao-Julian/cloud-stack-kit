// Inspect allowlisted source and tracked paths without printing matched credentials.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = JSON.parse(fs.readFileSync(path.join(root, 'package-files.json'), 'utf8'));
const failures = [];
if (!Array.isArray(files) || new Set(files).size !== files.length) throw Error('Invalid public file list');
const patterns = [
  ['private-key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['anthropic-token', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['user-profile-path', /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[A-Za-z0-9_.-]+[\\/]/],
];
for (const file of files) {
  if (typeof file !== 'string' || file.includes('\\') || path.isAbsolute(file) || file.split('/').some(p => !p || p === '..' || p === '.')) throw Error('Invalid public path');
  if (/(^|\/)(node_modules|\.git|\.secrets|dist|test-output|EdgeProfile|ClaudeCode)(\/|$)|(^|\/)(config\.json|credentials\.json|client\.json|known_hosts|panel-login\.txt|admin_key|tunnel_key)$/.test(file)) throw Error('Private path in public file list');
  const full = path.join(root, file);
  if (fs.lstatSync(full).isSymbolicLink() || !fs.statSync(full).isFile()) throw Error('Only regular files may be published');
  const content = fs.readFileSync(full, 'utf8');
  if (content.includes('\0')) failures.push(`${file}: binary content`);
  for (const [label, pattern] of patterns) if (pattern.test(content)) failures.push(`${file}: ${label}`);
}
const tracked = cp.spawnSync('git', ['-C', root, 'ls-files', '-z'], {encoding:'utf8', windowsHide:true});
if (tracked.status === 0) for (const file of tracked.stdout.split('\0').filter(Boolean)) {
  if (!files.includes(file)) failures.push(`${file}: tracked but not allowlisted`);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`PUBLIC_SOURCE_OK (${files.length} allowlisted files; scan is not a substitute for review)`);
