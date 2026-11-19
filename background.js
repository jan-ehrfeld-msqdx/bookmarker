const ALARM = 'periodic-sync';
const HOST = 'com.bookmarker.writer';
const DEFAULTS = { intervalMinutes: 15, folder: '' };
const BOOKMARKS_FILE = 'bookmarks.json';
const HISTORY_FILE = 'history.json';
const TABS_FILE = 'tabs.json';

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

async function scheduleAlarm() {
  const { intervalMinutes } = await getSettings();
  await chrome.alarms.create(ALARM, {
    periodInMinutes: Math.max(1, Number(intervalMinutes) || DEFAULTS.intervalMinutes),
  });
}

// ---------- file writing (via native messaging host) ----------

async function writeJson(folder, name, data) {
  const res = await chrome.runtime.sendNativeMessage(HOST, { folder, name, data });
  if (!res?.ok) throw new Error(res?.error || 'Native host returned no response');
}

// ---------- bookmarks ----------

async function exportBookmarks(folder) {
  const tree = await chrome.bookmarks.getTree();
  await writeJson(folder, BOOKMARKS_FILE, { exportedAt: new Date().toISOString(), tree });
}

// ---------- history ----------

// Chrome drops old history (~90 days), so visits are accumulated in extension storage
// and the full accumulated set is written to the file on each sync.
async function exportHistory(folder) {
  const { historyStore } = await chrome.storage.local.get('historyStore');
  const store = historyStore || { lastSync: 0, visits: [] };
  const syncStart = Date.now();

  // Small overlap so visits recorded right at the boundary are not missed; duplicates are filtered below.
  const startTime = Math.max(0, store.lastSync - 60_000);
  const items = await chrome.history.search({ text: '', startTime, maxResults: 1_000_000 });

  const seen = new Set(store.visits.map((v) => `${v.url}|${v.visitTime}`));
  for (const item of items) {
    const visits = await chrome.history.getVisits({ url: item.url });
    for (const v of visits) {
      if (v.visitTime < startTime) continue;
      const key = `${item.url}|${v.visitTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      store.visits.push({
        url: item.url,
        title: item.title || '',
        visitTime: v.visitTime,
        visitTimeISO: new Date(v.visitTime).toISOString(),
        transition: v.transition,
      });
    }
  }
  store.visits.sort((a, b) => a.visitTime - b.visitTime);
  store.lastSync = syncStart;

  await writeJson(folder, HISTORY_FILE, {
    exportedAt: new Date().toISOString(),
    count: store.visits.length,
    visits: store.visits,
  });
  // Persist only after the file was written successfully.
  await chrome.storage.local.set({ historyStore: store });
}

// ---------- open tabs (incl. Vivaldi workspaces) ----------

function parseVivExtData(tab) {
  if (!tab.vivExtData) return null;
  try { return JSON.parse(tab.vivExtData); } catch { return null; }
}

async function exportTabs(folder) {
  // Workspace names live in Vivaldi's profile, not in any extension API, so the host reads them.
  let workspaces = [];
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, { op: 'vivaldi-workspaces' });
    if (res?.ok) workspaces = res.workspaces;
  } catch { /* not Vivaldi or host cannot read it */ }
  const workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));

  const groups = chrome.tabGroups ? await chrome.tabGroups.query({}) : [];
  const windows = await chrome.windows.getAll({ populate: true });

  const out = windows.map((win) => ({
    windowId: win.id,
    type: win.type,
    focused: win.focused,
    tabs: win.tabs.map((t) => {
      const viv = parseVivExtData(t);
      const workspaceId = viv?.workspaceId ?? null;
      return {
        index: t.index,
        url: t.url || t.pendingUrl || '',
        title: t.title || '',
        pinned: t.pinned,
        active: t.active,
        groupId: t.groupId ?? -1,
        workspaceId,
        workspace: workspaceId === null ? null : workspaceNames.get(workspaceId) ?? null,
        vivExtData: viv,
      };
    }),
  }));

  await writeJson(folder, TABS_FILE, {
    exportedAt: new Date().toISOString(),
    workspaces,
    tabGroups: groups.map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed, windowId: g.windowId })),
    windows: out,
  });
}

// ---------- restore support ----------

// Runs after any in-flight sync so the stored visits are not overwritten by it.
async function mergeHistory(visits) {
  while (running) await running.catch(() => {});
  const { historyStore } = await chrome.storage.local.get('historyStore');
  const store = historyStore || { lastSync: 0, visits: [] };
  const seen = new Set(store.visits.map((v) => `${v.url}|${v.visitTime}`));
  let added = 0;
  for (const v of visits) {
    if (!v?.url || typeof v.visitTime !== 'number') continue;
    const key = `${v.url}|${v.visitTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    store.visits.push({
      url: v.url,
      title: v.title || '',
      visitTime: v.visitTime,
      visitTimeISO: new Date(v.visitTime).toISOString(),
      transition: v.transition,
    });
    added++;
  }
  store.visits.sort((a, b) => a.visitTime - b.visitTime);
  await chrome.storage.local.set({ historyStore: store });
  return { ok: true, added, total: store.visits.length };
}

// ---------- sync orchestration ----------

const PARTS = [['bookmarks', exportBookmarks], ['history', exportHistory], ['tabs', exportTabs]];
let running = null;

function syncAll(reason, only) {
  if (running) return running;
  running = (async () => {
    const { folder } = await getSettings();
    const status = { time: new Date().toISOString(), reason, ok: true, errors: [] };
    if (!folder) {
      status.ok = false;
      status.errors.push('No target folder configured. Set one on the options page.');
      await chrome.storage.local.set({ lastStatus: status });
      return status;
    }
    for (const [name, fn] of PARTS) {
      if (only && !only.includes(name)) continue;
      try {
        await fn(folder);
      } catch (e) {
        status.ok = false;
        status.errors.push(`${name}: ${e.message || e}`);
      }
    }
    await chrome.storage.local.set({ lastStatus: status });
    return status;
  })().finally(() => { running = null; });
  return running;
}

// Changes trigger a debounced export (re-creating an alarm resets it); alarms are used because the service worker may be suspended.
const BOOKMARK_ALARM = 'bookmark-debounce';
const TAB_ALARM = 'tab-debounce';
const onBookmarkChange = () => chrome.alarms.create(BOOKMARK_ALARM, { delayInMinutes: 0.5 });
const onTabChange = () => chrome.alarms.create(TAB_ALARM, { delayInMinutes: 0.5 });
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onImportEnded']) {
  chrome.bookmarks[ev].addListener(onBookmarkChange);
}
for (const ev of ['onCreated', 'onRemoved', 'onMoved', 'onAttached', 'onDetached']) {
  chrome.tabs[ev].addListener(onTabChange);
}
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.pinned !== undefined || info.groupId !== undefined) onTabChange();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) syncAll('periodic');
  else if (alarm.name === BOOKMARK_ALARM) syncAll('bookmark-change', ['bookmarks']);
  else if (alarm.name === TAB_ALARM) syncAll('tab-change', ['tabs']);
});

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleAlarm();
  await syncAll('installed');
});
chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await syncAll('startup');
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sync-now') {
    syncAll('manual').then(sendResponse);
    return true;
  }
  if (msg?.type === 'merge-history') {
    mergeHistory(msg.visits).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === 'settings-changed') {
    scheduleAlarm().then(() => sendResponse({}));
    return true;
  }
});
