// Content script (T-013): reports user interactions so the worker can screenshot the tab before the page reacts.
// Sends nothing unless a recording is running with screenshots enabled; reads no page content.
(() => {
  let enabled = false;
  let last = 0;
  const update = (settings, rec) => { enabled = !!settings?.screenshots && rec?.status === 'recording'; };
  let settings = null, rec = null;
  chrome.storage.local.get(['settings', 'recordingState']).then((r) => { settings = r.settings; rec = r.recordingState; update(settings, rec); }, () => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.settings) settings = ch.settings.newValue;
    if (ch.recordingState) rec = ch.recordingState.newValue;
    update(settings, rec);
  });
  const report = () => {
    if (!enabled || Date.now() - last < 600) return;
    last = Date.now();
    chrome.runtime.sendMessage({ type: 'interaction' }).catch(() => {});
  };
  addEventListener('pointerdown', report, true);
  addEventListener('keydown', report, true);
})();
