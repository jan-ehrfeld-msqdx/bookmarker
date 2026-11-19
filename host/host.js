// Native messaging host: receives { folder, name, data } from the extension and writes the JSON file.
const fs = require('fs');
const path = require('path');

const ALLOWED_NAMES = new Set(['bookmarks.json', 'history.json', 'tabs.json']);

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let expected = null;
    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (expected === null && total >= 4) expected = Buffer.concat(chunks).readUInt32LE(0);
      if (expected !== null && total >= 4 + expected) {
        const buf = Buffer.concat(chunks);
        resolve(JSON.parse(buf.subarray(4, 4 + expected).toString('utf8')));
        process.stdin.pause();
      }
    });
    process.stdin.on('end', () => { if (expected === null || total < 4 + expected) reject(new Error('Truncated message')); });
    process.stdin.on('error', reject);
  });
}

function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

function write({ folder, name, data }) {
  if (!ALLOWED_NAMES.has(name)) throw new Error(`File name not allowed: ${name}`);
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Folder must be an absolute path');
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

// Vivaldi keeps workspace id/name only in the profile's Preferences file.
function vivaldiWorkspaces() {
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Vivaldi', 'User Data', 'Default', 'Preferences');
  if (!base || !fs.existsSync(base)) return [];
  const prefs = JSON.parse(fs.readFileSync(base, 'utf8'));
  return (prefs.vivaldi?.workspaces?.list || []).map(({ id, name }) => ({ id, name }));
}

readMessage()
  .then((msg) => {
    if (msg.op === 'vivaldi-workspaces') return reply({ ok: true, workspaces: vivaldiWorkspaces() });
    reply({ ok: true, path: write(msg) });
  })
  .catch((e) => reply({ ok: false, error: e.message || String(e) }));
