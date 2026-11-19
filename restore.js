const $ = (id) => document.getElementById(id);

async function readJsonFile(input) {
  const file = input.files[0];
  if (!file) throw new Error('Choose a file first.');
  return JSON.parse(await file.text());
}

function log(id, text) {
  $(id).textContent = text;
}

async function guarded(statusId, fn) {
  try {
    log(statusId, 'Working…');
    log(statusId, await fn());
  } catch (e) {
    log(statusId, `Failed: ${e.message || e}`);
  }
}

// ---------- bookmarks ----------

// Restored bookmarks go into a new dated folder, so existing bookmarks are never touched.
async function restoreBookmarks() {
  const data = await readJsonFile($('bm-file'));
  const roots = data?.tree?.[0]?.children;
  if (!Array.isArray(roots)) throw new Error('Not a bookmarks.json file written by this extension.');

  const [liveRoot] = await chrome.bookmarks.getTree();
  const liveRoots = liveRoot.children;
  const target = liveRoots.find((c) => c.folderType === 'other') ?? liveRoots.find((c) => c.id === '2') ?? liveRoots[0];

  let created = 0;
  const addChildren = async (parentId, nodes) => {
    for (const node of nodes) {
      if (node.url) {
        await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
        created++;
      } else if (node.children) {
        const folder = await chrome.bookmarks.create({ parentId, title: node.title || '(untitled)' });
        await addChildren(folder.id, node.children);
      }
    }
  };

  const label = `Restored ${(data.exportedAt || new Date().toISOString()).slice(0, 10)}`;
  const top = await chrome.bookmarks.create({ parentId: target.id, title: label });
  for (const root of roots) {
    if (!root.children?.length) continue;
    const sub = await chrome.bookmarks.create({ parentId: top.id, title: root.title || '(untitled)' });
    await addChildren(sub.id, root.children);
  }
  return `Restored ${created} bookmarks into "${label}" (${target.title}).`;
}

// ---------- history ----------

// The browser API cannot add visits with their original timestamps, so history is merged into the
// extension's accumulated store; the next sync then writes it back to history.json.
async function restoreHistory() {
  const data = await readJsonFile($('hist-file'));
  if (!Array.isArray(data?.visits)) throw new Error('Not a history.json file written by this extension.');
  const res = await chrome.runtime.sendMessage({ type: 'merge-history', visits: data.visits });
  if (!res?.ok) throw new Error(res?.error || 'Merge failed');
  return `Merged ${res.added} new visits (${res.total} total in the accumulated history). Written to history.json on the next sync.`;
}

// ---------- tabs ----------

const SKIP_URL = /^(chrome|vivaldi|brave|edge|about|chrome-extension|devtools|view-source):/i;
let loadedTabs = null;

$('tabs-file').addEventListener('change', async () => {
  const select = $('tabs-workspace');
  select.length = 1;
  loadedTabs = null;
  try {
    loadedTabs = await readJsonFile($('tabs-file'));
    const names = new Set();
    for (const win of loadedTabs.windows || []) for (const t of win.tabs) if (t.workspace) names.add(t.workspace);
    for (const name of [...names].sort()) select.add(new Option(name, name));
    select.disabled = names.size === 0;
  } catch (e) {
    log('tabs-status', `Failed: ${e.message}`);
  }
});

async function restoreTabs() {
  const data = loadedTabs ?? (await readJsonFile($('tabs-file')));
  if (!Array.isArray(data?.windows)) throw new Error('Not a tabs.json file written by this extension.');
  const workspace = $('tabs-workspace').value;
  const groupInfo = new Map((data.tabGroups || []).map((g) => [g.id, g]));

  const plan = data.windows
    .map((win) => win.tabs
      .filter((t) => t.url && !SKIP_URL.test(t.url) && (!workspace || t.workspace === workspace))
      .sort((a, b) => a.index - b.index))
    .filter((tabs) => tabs.length);
  const total = plan.reduce((n, tabs) => n + tabs.length, 0);
  if (!total) return 'No restorable tabs found.';
  if (!confirm(`Open ${total} tabs in ${plan.length} new window(s)?`)) return 'Cancelled.';

  let opened = 0;
  let failed = 0;
  for (const tabs of plan) {
    const win = await chrome.windows.create({ focused: false });
    const [blank] = win.tabs;
    const created = []; // { tab: planned tab, id }
    for (const t of tabs) {
      try {
        const c = await chrome.tabs.create({ windowId: win.id, url: t.url, pinned: t.pinned, active: false });
        created.push({ t, id: c.id });
        opened++;
      } catch {
        failed++;
      }
    }
    if (blank?.id !== undefined && created.length) await chrome.tabs.remove(blank.id).catch(() => {});

    if (chrome.tabGroups) {
      const byGroup = new Map();
      for (const { t, id } of created) {
        if (t.groupId >= 0 && !t.pinned) byGroup.set(t.groupId, [...(byGroup.get(t.groupId) || []), id]);
      }
      for (const [gid, ids] of byGroup) {
        try {
          const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: win.id } });
          const info = groupInfo.get(gid);
          if (info) await chrome.tabGroups.update(groupId, { title: info.title, color: info.color, collapsed: info.collapsed });
        } catch { /* browser without tab groups */ }
      }
    }
  }
  const note = workspace ? '' : ' Vivaldi workspaces cannot be assigned through the extension API, so tabs open as plain tabs.';
  return `Opened ${opened} tabs${failed ? `, ${failed} failed` : ''}.${note}`;
}

$('bm-restore').addEventListener('click', () => guarded('bm-status', restoreBookmarks));
$('hist-restore').addEventListener('click', () => guarded('hist-status', restoreHistory));
$('tabs-restore').addEventListener('click', () => guarded('tabs-status', restoreTabs));
