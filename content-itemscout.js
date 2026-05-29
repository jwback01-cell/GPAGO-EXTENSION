// itemscout.io 페이지에서 inject 스크립트 주입 + 누적 키워드 데이터를 chrome.storage에 저장
(function () {
  // ─── inject 스크립트 주입 (페이지 컨텍스트에서 XHR/fetch 가로채기) ───
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject-itemscout.js');
    s.async = false;
    (document.documentElement || document.head).appendChild(s);
    s.onload = () => s.remove();
  } catch (e) {
    console.warn('[GPAGO itemscout content] inject 실패:', e);
  }

  // ─── inject 에서 알림 수신 → page eval 로 누적 키워드 가져와서 storage 저장 ───
  // chrome.scripting.executeScript 로 MAIN world 변수에 접근하는 게 더 안전하지만
  // content script 에서는 background 를 통해 처리해야 함. 여기서는 inject 가 직접 page 에 들고 있고
  // 메시지로 알려준 메타데이터(누적 키워드 수)를 storage 에 기록만 함.
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'gpago-itemscout-inject') return;
    if (e.data.type !== 'CAPTURED') return;
    try {
      if (!chrome.runtime?.id) return;
      // 메타데이터만 저장 (실제 키워드 데이터는 background 가 요청 시 executeScript 로 가져옴)
      await chrome.storage.local.set({
        itemscoutMeta: {
          pageUrl: e.data.pageUrl || location.href,
          totalKw: e.data.totalKw || 0,
          lastCapturedAt: e.data.capturedAt
        }
      });
    } catch (_) {}
  });

  // ─── background 가 자동 스크롤 요청 시 페이지 끝까지 스크롤 ───
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'GPAGO_ITEMSCOUT_AUTO_SCROLL') {
      (async () => {
        let lastHeight = 0;
        let sameCount = 0;
        const maxIter = 30;     // 최대 30회 스크롤 (안전장치)
        const stepDelay = 350;  // 스크롤 사이 대기 (속도 개선: 600 → 350ms)
        for (let i = 0; i < maxIter; i++) {
          try {
            window.scrollTo(0, document.documentElement.scrollHeight);
            // 내부 스크롤 컨테이너 발견 시 그것도 스크롤
            document.querySelectorAll('[class*="scroll"], [class*="overflow-auto"], [class*="overflow-y-auto"]').forEach(el => {
              try { el.scrollTop = el.scrollHeight; } catch(_) {}
            });
          } catch(_) {}
          await new Promise(r => setTimeout(r, stepDelay));
          const h = document.documentElement.scrollHeight;
          if (h === lastHeight) sameCount++;
          else { sameCount = 0; lastHeight = h; }
          if (sameCount >= 2) break; // 2회 연속 같으면 끝까지 도달
        }
        // 마지막 스크롤 후 짧은 대기 (속도 개선: 500 → 200ms)
        await new Promise(r => setTimeout(r, 200));
        try { sendResponse({ ok: true, finalHeight: document.documentElement.scrollHeight }); } catch(_) {}
      })();
      return true;
    }
  });

  // ─── background 가 GPAGO 요청 시 페이지의 키워드 스냅샷을 보내달라고 요청 ───
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'GPAGO_GET_ITEMSCOUT_SNAPSHOT') {
      const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      let responded = false;
      const respond = (data) => {
        if (responded) return;
        responded = true;
        try { sendResponse(data); } catch (_) {}
      };
      const handler = (e) => {
        if (e.source !== window) return;
        if (!e.data || e.data.source !== 'gpago-itemscout-snapshot-resp') return;
        if (e.data.reqId !== reqId) return;
        window.removeEventListener('message', handler);
        respond({ ok: true, snapshot: e.data.snapshot });
      };
      window.addEventListener('message', handler);
      // page 에 요청 (inject 가 듣고 있어야 함)
      try {
        window.postMessage({ source: 'gpago-itemscout-content-req', type: 'GET_SNAPSHOT', reqId }, location.origin);
      } catch (e) {
        respond({ ok: false, error: 'postMessage 실패: ' + (e?.message || e) });
        return true;
      }
      // 타임아웃 — 3초 (inject 가 응답 안 하면)
      setTimeout(() => {
        window.removeEventListener('message', handler);
        respond({ ok: false, error: 'page snapshot timeout — itemscout 페이지에서 inject 가 응답하지 않음. Ctrl+F5 로 itemscout 페이지를 새로고침해보세요.' });
      }, 3000);
      return true; // async response 허용
    }
  });
})();
