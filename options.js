const $ = (id) => document.getElementById(id);

function render(status) {
  $('status').textContent = status
    ? `Last sync: ${status.time} (${status.reason})\n` + (status.ok ? 'OK' : 'Errors:\n' + status.errors.join('\n'))
    : 'No sync yet.';
}

async function load() {
  const { settings, lastStatus } = await chrome.storage.local.get(['settings', 'lastStatus']);
  $('interval').value = settings?.intervalMinutes ?? 15;
  $('folder').value = settings?.folder ?? '';
  render(lastStatus);
}

$('save').addEventListener('click', async () => {
  const intervalMinutes = Math.max(1, Number($('interval').value) || 15);
  const folder = $('folder').value.trim();
  await chrome.storage.local.set({ settings: { intervalMinutes, folder } });
  await chrome.runtime.sendMessage({ type: 'settings-changed' });
  $('status').textContent = folder ? 'Saved.' : 'Saved, but no folder set yet.';
});

$('sync').addEventListener('click', async () => {
  $('status').textContent = 'Syncing…';
  render(await chrome.runtime.sendMessage({ type: 'sync-now' }));
});

load();
