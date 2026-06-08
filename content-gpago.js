// GPAGO 사이트에서 실행 — chrome.storage의 pendingShoppingJson을 페이지로 전달
// 여러 트리거 시점에서 체크하여 새로고침 없이도 즉시 반영되도록 함

let _processing = false;
let _contextInvalidated = false;

// 확장 컨텍스트가 살아있는지 안전하게 확인
function isExtensionAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

function isContextInvalidatedError(e) {
  const txt = String(e?.message || e?.toString() || '');
  return /context invalidated|Receiving end does not exist|message port closed|Extension context/i.test(txt);
}

async function processIfPending() {
  if (_processing) return;
  if (_contextInvalidated) return;
  if (!isExtensionAlive()) { _contextInvalidated = true; return; }

  _processing = true;
  try {
    const { pendingShoppingJson, pendingShoppingTabs, pendingAt } = await chrome.storage.local.get(['pendingShoppingJson', 'pendingShoppingTabs', 'pendingAt']);
    if (!pendingShoppingJson) return;

    // 5분 지난 데이터는 무시
    if (pendingAt && Date.now() - pendingAt > 5 * 60 * 1000) {
      try { await chrome.storage.local.remove(['pendingShoppingJson', 'pendingShoppingTabs', 'pendingAt']); } catch (_) {}
      return;
    }

    // 일회성: 전달 후 즉시 삭제
    try { await chrome.storage.local.remove(['pendingShoppingJson', 'pendingShoppingTabs', 'pendingAt']); } catch (_) {}

    // 페이지 컨텍스트로 메시지 전달 (탭별 데이터도 함께)
    window.postMessage({
      type: 'GPAGO_AUTO_ANALYZE',
      source: 'gpago-extension',
      data: pendingShoppingJson,
      tabs: pendingShoppingTabs || null
    }, window.location.origin);
    console.log('[GPAGO ext] payload forwarded to page (tabs:', pendingShoppingTabs ? Object.keys(pendingShoppingTabs).join(',') : 'none', ')');
  } catch (e) {
    // 확장 컨텍스트 무효화 에러는 조용히 무시 (chrome://extensions의 오류 목록에 안 뜨도록)
    if (isContextInvalidatedError(e)) {
      _contextInvalidated = true;
      // console.log/warn 둘 다 안 함 — Chrome이 chrome://extensions 오류 페이지에 띄울 수 있음
    } else {
      // 예기치 못한 다른 에러만 표시
      console.log('[GPAGO ext] processIfPending unexpected:', e?.message || e);
    }
  } finally {
    _processing = false;
  }
}

// GPAGO 페이지에서 트리거 요청을 받으면 background로 전달 (Ctrl+Q와 동일 흐름)
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (!e.data || e.data.source !== 'gpago-page') return;
  if (e.data.type !== 'GPAGO_REQUEST_TRIGGER') return;
  if (_contextInvalidated || !isExtensionAlive()) return;
  // 페이지에게 확장이 살아있다고 ACK
  window.postMessage({ source: 'gpago-extension', type: 'TRIGGER_ACK' }, window.location.origin);
  // background에 트리거 요청 (keyword는 옵션, background가 직접 N input 읽음)
  // v1.7.18+ : deep>0 이면 N 페이지 순차 캡처 (rtrank 400위 등)
  try {
    chrome.runtime.sendMessage({
      type: 'GPAGO_TRIGGER_FROM_GPAGO',
      keyword: e.data.keyword || '',
      deep: Number(e.data.deep || 0) || 0
    });
  } catch (_) {}
});

// GPAGO "아이템스카우트 가져오기" 버튼 → background → itemscout 탭 → 결과 회신
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (!e.data || e.data.source !== 'gpago-page') return;
  if (_contextInvalidated || !isExtensionAlive()) return;
  if (e.data.type === 'GPAGO_REQUEST_ITEMSCOUT') {
    try { chrome.runtime.sendMessage({ type: 'GPAGO_GET_ITEMSCOUT' }); } catch (_) {}
  } else if (e.data.type === 'GPAGO_AUTO_FETCH_ITEMSCOUT') {
    try {
      chrome.runtime.sendMessage({
        type: 'GPAGO_AUTO_FETCH_ITEMSCOUT',
        categoryIdOrUrl: e.data.categoryIdOrUrl || ''
      });
    } catch (_) {}
  } else if (e.data.type === 'GPAGO_FETCH_SMARTSTORE_INFO') {
    // 키워드 순위 카드의 스마트스토어 정보 fetch (느린 폴백: 백그라운드 탭) — 확장 background 에서 처리
    try {
      chrome.runtime.sendMessage({
        type: 'GPAGO_FETCH_SMARTSTORE_INFO',
        url: e.data.url || '',
        reqId: e.data.reqId || '',
        searchHint: e.data.searchHint || ''  // v1.7.10+ : 키워드 hint (병렬 찜 검색용)
      });
    } catch (_) {}
  } else if (e.data.type === 'GPAGO_FETCH_SMARTSTORE_API') {
    // ⚡ 빠른 모드 — 백그라운드 스크립트에서 Naver 내부 API 직접 호출 (1~3초)
    try {
      chrome.runtime.sendMessage({
        type: 'GPAGO_FETCH_SMARTSTORE_API',
        url: e.data.url || '',
        reqId: e.data.reqId || ''
      });
    } catch (_) {}
  } else if (e.data.type === 'GPAGO_REQUEST_BIZADVISOR') {
    // 키워드 성과분석 — 스마트스토어센터 데이터 수집 요청 (v1.7.43+)
    try { chrome.runtime.sendMessage({ type: 'GPAGO_REQUEST_BIZADVISOR' }); } catch (_) {}
  } else if (e.data.type === 'GPAGO_GET_TERMS') {
    // 키워드 정확 텀즈(NLU) 조회 (v1.7.48+)
    try { chrome.runtime.sendMessage({ type: 'GPAGO_GET_TERMS', keyword: e.data.keyword || '', reqId: e.data.reqId || '' }); } catch (_) {}
  }
});

// background → 결과 수신 → 페이지로 전달
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'GPAGO_ITEMSCOUT_RESULT') {
    window.postMessage({
      source: 'gpago-extension',
      type: 'GPAGO_ITEMSCOUT_DATA',
      ok: !!msg.ok,
      error: msg.error || null,
      snapshot: msg.snapshot || null
    }, window.location.origin);
  } else if (msg.type === 'GPAGO_SMARTSTORE_INFO_RESULT') {
    window.postMessage({
      source: 'gpago-extension',
      type: 'GPAGO_SMARTSTORE_INFO_RESULT',
      reqId: msg.reqId || '',
      ok: !!msg.ok,
      error: msg.error || null,
      // 새 방식 (v1.4.0+): 백그라운드 탭에서 직접 추출한 정보 객체
      data: msg.data || null,
      // 기존 방식 호환성 (v1.3.x): fetch 한 HTML 문자열
      html: msg.html || null,
      htmlLen: msg.htmlLen || 0
    }, window.location.origin);
  } else if (msg.type === 'GPAGO_TERMS_RESULT') {
    // 키워드 정확 텀즈 결과 → 페이지로 전달 (v1.7.48+)
    window.postMessage({
      source: 'gpago-extension',
      type: 'GPAGO_TERMS_RESULT',
      reqId: msg.reqId || '',
      keyword: msg.keyword || '',
      terms: msg.terms || null,
      nluTerms: msg.nluTerms || null
    }, window.location.origin);
  } else if (msg.type === 'GPAGO_BIZADVISOR_RESULT') {
    // 스마트스토어센터 수집 결과 → 페이지로 전달 (v1.7.43+)
    window.postMessage({
      source: 'gpago-extension',
      type: 'GPAGO_BIZADVISOR_RESULT',
      ok: !!msg.ok,
      error: msg.error || null,
      captures: msg.captures || [],
      requests: msg.requests || []
    }, window.location.origin);
  }
});

// 페이지 로드 시점에 처리
processIfPending();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(processIfPending, 100);
  });
} else {
  setTimeout(processIfPending, 100);
}

// 추가 안전망: 0.5초, 1.5초 후에도 재시도 (페이지 스크립트가 늦게 메시지 리스너 등록할 수 있음)
setTimeout(processIfPending, 500);
setTimeout(processIfPending, 1500);

// storage 변경 감지 — background 가 새 pendingShoppingJson 을 set 하면 즉시 페이지로 전달
// (이전엔 chrome.tabs.reload 로 강제 새로고침 했지만 JS 상태 손실 문제로 제거됨)
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.pendingShoppingJson && changes.pendingShoppingJson.newValue) {
      // 새 데이터가 도착함 → 페이지로 즉시 전달
      setTimeout(processIfPending, 50);
    }
  });
} catch (_) {}
