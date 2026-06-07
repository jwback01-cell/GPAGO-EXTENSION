// 스마트스토어센터(sell.smartstore.naver.com) — MAIN world inject 주입 + 캡처 수신/저장 + 배너
(function () {
  // 1) inject 주입
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject-bizadvisor.js');
    s.async = false;
    (document.documentElement || document.head).appendChild(s);
    s.onload = () => s.remove();
  } catch (e) {
    console.warn('[GPAGO biz content] inject 실패:', e);
  }

  // 2) inject 가 보낸 캡처 → storage 누적 (최근 30개, 큰 응답은 슬림화)
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'gpago-biz-inject') return;
    if (e.data.type !== 'BIZ_CAPTURED') return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      const url = e.data.url || '';
      const data = e.data.data;
      let entry = { url: url, at: Date.now(), truncated: false, data: data };
      try {
        const str = JSON.stringify(data);
        if (str.length > 1500000) {
          entry.truncated = true;
          entry.data = {
            __truncated: true,
            length: str.length,
            topKeys: Array.isArray(data) ? ('array(' + data.length + ')') : Object.keys(data || {}).slice(0, 50),
            sample: str.slice(0, 12000),
          };
        }
      } catch (_) {}
      const store = await chrome.storage.local.get('bizadvisorCaptures');
      const arr = store.bizadvisorCaptures || [];
      // 같은 URL 은 최신으로 교체
      const idx = arr.findIndex(x => x.url === url);
      if (idx >= 0) arr.splice(idx, 1);
      arr.unshift(entry);
      if (arr.length > 15) arr.length = 15;
      await chrome.storage.local.set({ bizadvisorCaptures: arr });
      console.log('[GPAGO biz] captured:', url, entry.truncated ? '(truncated)' : '');
    } catch (_) {}
  });

  // 3) background 메시지 — 배너 표시/숨김
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'BIZ_SHOW_BANNER') showBanner(msg.message || 'GPAGO 데이터 수집 중...');
    if (msg && msg.type === 'BIZ_HIDE_BANNER') hideBanner();
  });

  function showBanner(message) {
    hideBanner();
    const div = document.createElement('div');
    div.id = '__gpago_biz_banner__';
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#00C853,#00A846);color:#fff;padding:12px 20px;font-size:13px;font-weight:bold;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;gap:12px;line-height:1.4;';
    div.innerHTML = '<span>' + message + '</span><button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,.25);border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;">닫기</button>';
    (document.body || document.documentElement).appendChild(div);
  }
  function hideBanner() {
    const o = document.getElementById('__gpago_biz_banner__');
    if (o) o.remove();
  }

  console.log('[GPAGO biz content] ready on', location.href.slice(0, 80));
})();
