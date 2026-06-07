// GPAGO 자동 분석 — 서비스 워커 (수동 캡처 모드)
// 페이지를 자동으로 조작하지 않음. 사용자가 직접 페이지에서 행동(정렬·페이지 변경·검색)을
// 한 번 한 후 캡처된 데이터를 GPAGO로 전달함.

const GPAGO_URL = 'https://gpago.vercel.app/';
const CAPTURE_MAX_AGE_MS = 10 * 60 * 1000; // 10분
const WAIT_TIMEOUT_MS = 90 * 1000; // 사용자가 페이지를 조작할 시간 (1.5분)

// ─── Manifest V3 Service Worker Keep-Alive ─────────────────────────
// 30초 idle 후 service worker 자동 종료 방지 — 진행 중인 요청이 있을 때만 keep-alive 동작
// (chrome.runtime.getPlatformInfo 같은 무해한 API 호출로 깨어있게 함)
const _gpagoActiveReqs = new Set();
let _gpagoKeepAliveInterval = null;
function _gpagoStartKeepAlive(reqId) {
  _gpagoActiveReqs.add(reqId);
  if (_gpagoKeepAliveInterval) return;
  _gpagoKeepAliveInterval = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}
  }, 20000); // 20초마다 핑 (30초 idle 전에)
}
function _gpagoStopKeepAlive(reqId) {
  _gpagoActiveReqs.delete(reqId);
  if (_gpagoActiveReqs.size === 0 && _gpagoKeepAliveInterval) {
    clearInterval(_gpagoKeepAliveInterval);
    _gpagoKeepAliveInterval = null;
  }
}

// 탭 로드 완료 대기 (status === 'complete')
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { chrome.tabs.onUpdated.removeListener(listener); } catch(_) {} resolve(ok); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    chrome.tabs.onUpdated.addListener(listener);
    // 이미 complete 상태일 수도 있으므로 즉시 확인
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(true); }).catch(() => {});
    setTimeout(() => finish(false), timeoutMs);
  });
}

// minimized popup 으로 검색 페이지 열어 JS 실행 후 캡처된 shoppingResult 에서 찜 추출
async function fetchZzimViaSearchPopup(productTitle, mallProductId) {
  if (!productTitle || !mallProductId) return null;
  let q = String(productTitle).split(':')[0]
    .replace(/[()\[\]{}\-,.:;!?]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(/\s+/).slice(0, 5).join(' ');
  if (!q) return null;
  const reqId = 'zr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const url = 'https://search.shopping.naver.com/search/all?where=all&frm=NVSCTAB&query='
    + encodeURIComponent(q) + '&pagingIndex=1&pagingSize=80&_gpago_zzim_req=' + reqId;
  const storageKey = '_gpagoZzimResult_' + reqId;
  console.log('[GPAGO bg] 🪟 찜 popup 열기 — query:', q, 'productId:', mallProductId);
  // v1.7.9+ : 페이지 fully load 후 chrome.scripting 으로 DOM 에서 직접 "찜 N" 텍스트 추출
  //   (content-naver.js 가 모든 캡처 시점에 작동 안 함 — DOM 읽기가 가장 확실)
  let win = null;
  try {
    win = await chrome.windows.create({
      url, type: 'popup',
      focused: false,
      left: 0, top: 0,
      width: 800, height: 500,
    });
  } catch (e1) {
    console.log('[GPAGO bg] 🪟 popup 생성 실패:', e1?.message || e1);
    return null;
  }
  const tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  if (!tabId) {
    try { await chrome.windows.remove(win.id); } catch (_) {}
    return null;
  }
  // 페이지 로드 + 동적 컨텐츠 (찜 카운트) 렌더 대기
  await waitForTabLoad(tabId, 10000);
  // v1.7.10+ : 고정 대기(3.5초) 대신 polling — 찜이 빨리 렌더링되면 즉시 추출, 최대 8초까지
  const domExtractFunc = (productId) => {
    const sels = [
      'a[href*="' + productId + '"]',
      '[data-shp-contents-dtl*="' + productId + '"]',
      '[data-product-no="' + productId + '"]',
    ];
    const candidates = [];
    for (const s of sels) {
      try { document.querySelectorAll(s).forEach(el => candidates.push(el)); } catch (_) {}
    }
    const debug = { candidateCount: candidates.length, found: null, sampleText: '' };
    for (const c of candidates) {
      let card = c;
      for (let i = 0; i < 12; i++) {
        if (!card || !card.textContent) break;
        const text = card.textContent;
        const cleanText = text.replace(/찜하기/g, '');
        const m = cleanText.match(/찜\s*([\d,]+)/);
        if (m) {
          debug.found = Number(m[1].replace(/,/g, ''));
          debug.sampleText = text.slice(0, 200).replace(/\s+/g, ' ');
          return debug;
        }
        card = card.parentElement;
      }
    }
    const allText = document.body ? document.body.innerText : '';
    if (allText) {
      const idIdx = allText.indexOf(productId);
      if (idIdx >= 0) {
        const win = allText.slice(Math.max(0, idIdx - 500), idIdx + 500);
        const cleanWin = win.replace(/찜하기/g, '');
        const m = cleanWin.match(/찜\s*([\d,]+)/);
        if (m) {
          debug.found = Number(m[1].replace(/,/g, ''));
          debug.sampleText = '(fallback) ' + win.slice(0, 200).replace(/\s+/g, ' ');
          return debug;
        }
      }
    }
    return debug;
  };
  let zzim = null;
  const pollStart = Date.now();
  const POLL_INTERVAL = 700;
  const POLL_MAX = 8000;
  try {
    while (Date.now() - pollStart < POLL_MAX) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: domExtractFunc,
        args: [String(mallProductId)],
      });
      const r = results && results[0] ? results[0].result : null;
      if (r && r.found != null) {
        console.log('[GPAGO bg] 🪟 DOM 추출 (' + (Date.now() - pollStart) + 'ms): 후보=' + r.candidateCount + ', 찜=' + r.found);
        if (r.sampleText) console.log('  · 샘플:', r.sampleText);
        zzim = r.found;
        break;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    if (zzim == null) {
      console.log('[GPAGO bg] 🪟 polling 시간 초과 (' + (Date.now() - pollStart) + 'ms) — 찜 못 찾음');
    }
  } catch (e) {
    console.warn('[GPAGO bg] 🪟 scripting 실패:', e?.message || e);
  }
  // popup 닫기
  try { await chrome.windows.remove(win.id); } catch (_) {}
  try { await chrome.storage.local.remove(storageKey); } catch (_) {}
  if (zzim != null) {
    console.log('[GPAGO bg] 🎯 DOM 에서 찜 찾음! 찜:', zzim);
    return Number(zzim);
  }
  return null;
}

// GPAGO 탭에서 N 입력값 읽기
async function readGpagoNKeyword(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.getElementById('kw-naver')?.value || ''
    });
    return (results?.[0]?.result || '').trim();
  } catch (_) {
    return '';
  }
}

// GPAGO 탭에서 트리거 — N 입력값으로 새 네이버 탭 열고 캡처
// v1.7.41+ : background 에서 Naver search HTML 직접 fetch + __NEXT_DATA__ 파싱
async function tryDirectFetchSearch(keyword, productSet) {
  const url = 'https://search.shopping.naver.com/search/all?'
    + new URLSearchParams({ query: keyword, pagingSize: '80', productSet }).toString();
  // v1.7.35+ : 4초 타임아웃 — Naver 가 느릴 때 즉시 popup 폴백
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const SKIP = new Set(['_owner','stateNode','return','child','sibling','alternate']);
    const out = [];
    function collect(o, d, seen) {
      if (!o || typeof o !== 'object' || d > 12 || seen.has(o)) return;
      seen.add(o);
      if (o.shoppingResult && Array.isArray(o.shoppingResult.products) && o.shoppingResult.products.length) {
        out.push({ obj: o.shoppingResult, pri: 1000 + o.shoppingResult.products.length });
      }
      if (Array.isArray(o.products) && o.products.length) {
        const first = o.products[0];
        if (first && typeof first === 'object' && (first.productTitle || first.productName || first.id || first.nvMid || first.mallProductId)) {
          out.push({ obj: o, pri: o.products.length });
        }
      }
      if (Array.isArray(o)) { for (let i = 0; i < o.length && i < 300; i++) collect(o[i], d + 1, seen); return; }
      for (const k in o) { if (SKIP.has(k)) continue; if (o[k] && typeof o[k] === 'object') collect(o[k], d + 1, seen); }
    }
    collect(data, 0, new WeakSet());
    out.sort((a, b) => b.pri - a.pri);
    // v1.7.42+ : 옵션 필터된 검색은 결과가 적을 수 있어 임계값 낮춤 (40→10)
    if (!out[0] || !Array.isArray(out[0].obj.products) || out[0].obj.products.length < 10) return null;
    const sr = out[0].obj;
    return {
      query: keyword,
      products: sr.products.map(_slimProduct),
      terms: sr.terms,
      nluTerms: sr.nluTerms,
      searchParam: { productSet },
      total: sr.totalCount || sr.total,
    };
  } catch (_) { return null; }
  finally { clearTimeout(timeoutId); }
}

async function runGpagoFromGpagoTab(gpagoTab, deep) {
  const deepPages = Math.max(1, Math.min(13, Number(deep) || 1));  // 1~13페이지 (80~1040개)
  const keyword = await readGpagoNKeyword(gpagoTab.id);
  if (!keyword) {
    await alertOnTab(gpagoTab.id, 'GPAGO 자동 분석',
      'GPAGO의 N 입력란에 키워드를 먼저 입력해주세요.');
    return;
  }
  console.log('[GPAGO bg] GPAGO N 입력값:', keyword, '| deep 페이지:', deepPages);

  // v1.7.41+ : popup 열기 전 direct fetch 시도 (deep=1 일반 분석에만 적용)
  // v1.7.35+ : 두 productSet 병렬 fetch, allSettled — 한쪽이 실패해도 다른 쪽으로 전송
  if (deepPages <= 1) {
    const t0 = Date.now();
    const settled = await Promise.allSettled([
      tryDirectFetchSearch(keyword, 'npay'),
      tryDirectFetchSearch(keyword, 'total'),
    ]);
    const npay  = settled[0].status === 'fulfilled' ? settled[0].value : null;
    const total = settled[1].status === 'fulfilled' ? settled[1].value : null;
    if (npay || total) {
      console.log('[GPAGO bg] ⚡ direct fetch 성공 (' + (Date.now() - t0) + 'ms): 네이버페이=' + (npay?.products?.length || 0) + ', 전체=' + (total?.products?.length || 0));
      const tabsMap = {};
      if (npay)  tabsMap['네이버페이'] = { data: npay };
      if (total) tabsMap['전체']      = { data: total };
      await sendToGpagoMultiTab(total || npay, tabsMap);
      return;
    }
    console.log('[GPAGO bg] ⚡ direct fetch 실패 (' + (Date.now() - t0) + 'ms) → popup 폴백');
  }

  // 이전 캡처 청소 (다른 키워드 데이터가 섞이지 않도록)
  await chrome.storage.local.remove(['gpagoListenMode', 'naverCapturesByTab', 'lastNaverCapture']);

  // 작은 팝업 윈도우로 네이버 쇼핑 열기 (focused:true — JS 쓰로틀링 회피 + 빠른 로딩)
  // 팝업은 잠시 떴다가 캡처 완료 후 자동 닫힘 → 사용자는 GPAGO 화면으로 돌아옴
  // pagingSize=80 → 80개씩 보기로 더 많은 상품 캡처
  const naverUrl = 'https://search.shopping.naver.com/search/all?'
    + new URLSearchParams({ query: keyword, pagingSize: '80', pagingIndex: '1' }).toString();
  const naverWindow = await chrome.windows.create({
    url: naverUrl,
    type: 'popup',
    width: 900,
    height: 650,
    focused: true  // 포커스 받아야 쓰로틀링 없이 빠르게 로드됨
  });
  const naverTab = naverWindow.tabs[0];
  const naverWindowId = naverWindow.id;
  console.log('[GPAGO bg] 팝업 윈도우 생성 — windowId:', naverWindowId, 'tabId:', naverTab.id);
  // GPAGO 탭 ID를 기억 (필요 시 복귀용)
  const gpagoTabIdToReturn = gpagoTab.id;
  const gpagoWindowIdToReturn = gpagoTab.windowId;

  // 탭이 완전히 로드될 때까지 대기 (최대 8초)
  await waitForTabLoad(naverTab.id, 8000);
  // 페이지 JS가 자리 잡고 초기 XHR(전체)이 캡처될 시간
  await new Promise(r => setTimeout(r, 800));

  // listen 모드 설정 + TRIGGER_ONCE 전송
  await chrome.storage.local.set({
    gpagoListenMode: { tabId: naverTab.id, url: naverUrl, requestedAt: Date.now() }
  });
  // content-naver가 아직 준비 안 됐을 수 있으므로 재시도
  let triggerSent = false;
  for (let i = 0; i < 3; i++) {
    try {
      await chrome.tabs.sendMessage(naverTab.id, { type: 'GPAGO_TRIGGER_ONCE' });
      triggerSent = true;
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  if (!triggerSent) console.warn('[GPAGO bg] TRIGGER_ONCE 전송 실패 (3회 시도)');

  // 캡처 대기 (네이버페이 0.9초 + 전체 0.9초 + 마진 + strict-search 자동 클릭 후 reload 여유)
  let quickCaptured = await waitForCapture(naverUrl, 9000);

  // v1.7.42+ : 보안 확인(캡차) 대응 ──────────────────────────────────────
  //   9초 안에 캡처가 안 되면 보안 확인 페이지일 가능성이 높다.
  //   (기존: 즉시 alert → 사용자가 GPAGO 를 새로고침하고 재검색해야 했음)
  //   이제는 팝업을 앞으로 띄우고 안내 배너를 표시한 뒤, 사용자가 보안 확인을
  //   완료해 결과 페이지가 로드되면 자동으로 캡처해 그대로 이어서 분석한다.
  if (!quickCaptured) {
    quickCaptured = await waitForCaptureAfterSecurity(naverTab.id, naverWindowId, naverUrl);
  }

  if (quickCaptured) {
    await new Promise(r => setTimeout(r, 1000));
    const { naverCapturesByTab: page1Tabs } = await chrome.storage.local.get('naverCapturesByTab');
    const accumulatedTabs = {};
    for (const [k, v] of Object.entries(page1Tabs || {})) {
      if (v && v.data) accumulatedTabs[k] = { ...v, data: { ...v.data, products: [...(v.data.products || [])] } };
    }
    const summary1 = Object.entries(page1Tabs || {}).map(([k, v]) => `${k}(${v?.data?.products?.length || 0})`).join(', ');
    console.log('[GPAGO bg] 1페이지 캡처:', summary1 || '(없음)');

    // v1.7.29+ : deep 모드 — popup 안에서 Naver API 직접 호출 시도 + HTML fallback
    for (let page = 2; page <= deepPages; page++) {
      const pageUrl = 'https://search.shopping.naver.com/search/all?'
        + new URLSearchParams({ query: keyword, pagingSize: '80', pagingIndex: String(page), productSet: 'total', sort: 'rel' }).toString();
      let pageResult = null;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: naverTab.id },
          func: async (url, kw, pageNum) => {
            // 0) API 엔드포인트 후보들 — popup context 라 Naver 쿠키 + referer 자동 포함
            const apiCandidates = [
              `https://search.shopping.naver.com/api/search/all?` + new URLSearchParams({
                query: kw, origQuery: kw, pagingIndex: String(pageNum), pagingSize: '80',
                productSet: 'total', sort: 'rel', viewType: 'list', iq: '', eq: '', xq: ''
              }).toString(),
              `https://search.shopping.naver.com/api/search/products?` + new URLSearchParams({
                query: kw, pagingIndex: String(pageNum), pagingSize: '80', sort: 'rel'
              }).toString(),
            ];
            for (const apiUrl of apiCandidates) {
              try {
                const r = await fetch(apiUrl, { credentials: 'include', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
                if (!r.ok) continue;
                const ct = String(r.headers.get('content-type') || '').toLowerCase();
                if (ct.indexOf('json') < 0) continue;
                const data = await r.json();
                // 깊이탐색 — products 배열 찾기
                const SKIP = new Set(['_owner','stateNode','return','child','sibling','alternate']);
                function collect(o, d, seen, out) {
                  if (!o || typeof o !== 'object' || d > 12 || seen.has(o)) return;
                  seen.add(o);
                  if (o.shoppingResult && Array.isArray(o.shoppingResult.products) && o.shoppingResult.products.length) {
                    out.push({ obj: o.shoppingResult, pri: 1000 + o.shoppingResult.products.length });
                  }
                  if (Array.isArray(o.products) && o.products.length) {
                    const first = o.products[0];
                    if (first && typeof first === 'object' && (first.productTitle || first.productName || first.id || first.nvMid || first.mallProductId)) {
                      out.push({ obj: o, pri: o.products.length });
                    }
                  }
                  if (Array.isArray(o)) { for (let i = 0; i < o.length && i < 300; i++) collect(o[i], d + 1, seen, out); return; }
                  for (const k in o) { if (SKIP.has(k)) continue; if (o[k] && typeof o[k] === 'object') collect(o[k], d + 1, seen, out); }
                }
                const out = [];
                collect(data, 0, new WeakSet(), out);
                out.sort((a, b) => b.pri - a.pri);
                if (out[0] && Array.isArray(out[0].obj.products) && out[0].obj.products.length >= 40) {
                  return { products: out[0].obj.products, source: 'API:' + apiUrl.split('?')[0].split('/').slice(-2).join('/') };
                }
              } catch (_) {}
            }
            // 1) HTML fallback — fetch the page HTML
            try {
              const res = await fetch(url, { credentials: 'include', headers: { 'Accept': 'text/html' } });
              if (!res.ok) return { error: 'http ' + res.status, finalUrl: res.url };
              const html = await res.text();
              const SKIP = new Set(['_owner','stateNode','return','child','sibling','alternate','firstEffect','lastEffect']);
              // 깊이탐색 — 모든 products 배열 후보 수집 후 가장 큰 것 선택
              //   (작은 광고/추천 배열이 먼저 매칭되어 80개 대신 3개만 가져오던 문제 수정)
              function collectProducts(o, d, seen, results) {
                if (!o || typeof o !== 'object' || d > 14 || seen.has(o)) return;
                seen.add(o);
                if (o.shoppingResult && Array.isArray(o.shoppingResult.products) && o.shoppingResult.products.length) {
                  results.push({ obj: o.shoppingResult, len: o.shoppingResult.products.length, priority: 1000 + o.shoppingResult.products.length });
                }
                if (Array.isArray(o.products) && o.products.length > 0) {
                  const first = o.products[0];
                  if (first && typeof first === 'object' && (first.productTitle || first.productName || first.id || first.nvMid || first.mallProductId)) {
                    results.push({ obj: o, len: o.products.length, priority: o.products.length });
                  }
                }
                if (Array.isArray(o)) {
                  for (let i = 0; i < o.length && i < 300; i++) collectProducts(o[i], d + 1, seen, results);
                  return;
                }
                for (const k in o) {
                  if (SKIP.has(k)) continue;
                  if (o[k] && typeof o[k] === 'object') collectProducts(o[k], d + 1, seen, results);
                }
              }
              function findProducts(rootData) {
                const results = [];
                collectProducts(rootData, 0, new WeakSet(), results);
                if (!results.length) return null;
                results.sort((a, b) => b.priority - a.priority);
                return results[0].obj;
              }
              // A) __NEXT_DATA__ 시도
              let data = null;
              const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
              if (nextDataMatch) {
                try { data = JSON.parse(nextDataMatch[1]); } catch (_) {}
              }
              if (data) {
                const f = findProducts(data);
                if (f) return { products: f.products || [], total: f.totalCount || f.total, source: 'NEXT_DATA' };
              }
              // B) __next_f.push payload 스캔
              const nextFRegex = /self\.__next_f\.push\(\[\d+,\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"[^"]*")?\s*\]\)/g;
              let nm;
              while ((nm = nextFRegex.exec(html)) !== null) {
                let payload;
                try { payload = JSON.parse('"' + nm[1] + '"'); } catch (_) { continue; }
                if (!payload.includes('"products"') && !payload.includes('shoppingResult')) continue;
                // payload 안의 { ... } 블록들 시도
                let start = 0;
                while (start < payload.length) {
                  const startIdx = payload.indexOf('{', start);
                  if (startIdx < 0) break;
                  // 균형있는 JSON 추출
                  let depth = 0, inStr = false, esc = false, end = -1;
                  for (let i = startIdx; i < payload.length; i++) {
                    const c = payload[i];
                    if (esc) { esc = false; continue; }
                    if (c === '\\') { esc = true; continue; }
                    if (c === '"') { inStr = !inStr; continue; }
                    if (inStr) continue;
                    if (c === '{') depth++;
                    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
                  }
                  if (end < 0) break;
                  const jsonStr = payload.slice(startIdx, end);
                  if (jsonStr.length > 200 && (jsonStr.includes('"products"') || jsonStr.includes('shoppingResult'))) {
                    try {
                      const obj = JSON.parse(jsonStr);
                      const f = findProducts(obj);
                      if (f) return { products: f.products || [], total: f.totalCount || f.total, source: '__next_f' };
                    } catch (_) {}
                  }
                  start = end;
                }
              }
              // 진단 정보 반환
              return {
                error: 'no products found',
                htmlLen: html.length,
                hasNextData: !!nextDataMatch,
                topKeys: data ? Object.keys(data).slice(0, 10) : null,
                hasNextF: html.includes('__next_f'),
                finalUrl: res.url,
              };
            } catch (e) { return { error: String(e?.message || e) }; }
          },
          args: [pageUrl, keyword, page],
        });
        pageResult = results && results[0] ? results[0].result : null;
      } catch (e) { console.warn('[GPAGO bg] page', page, 'executeScript 실패:', e); break; }
      if (!pageResult || pageResult.error || !Array.isArray(pageResult.products)) {
        console.warn('[GPAGO bg] page', page, 'fetch 실패:', pageResult?.error || 'unknown', '/ 진단:', pageResult);
        break;
      }
      // 슬림화 후 '전체' 탭에 누적
      const slim = pageResult.products.map(_slimProduct);
      if (!accumulatedTabs['전체']) {
        accumulatedTabs['전체'] = { data: { query: keyword, products: [] }, url: pageUrl, capturedAt: Date.now() };
      }
      accumulatedTabs['전체'].data.products.push(...slim);
      console.log('[GPAGO bg]', page + '페이지 (' + pageResult.source + '): +' + pageResult.products.length + ', 누적 ' + accumulatedTabs['전체'].data.products.length);
    }

    // 팝업 윈도우 자동 닫기
    try { await chrome.windows.remove(naverWindowId); } catch (_) {}
    // GPAGO 탭 포커스
    try {
      await chrome.tabs.update(gpagoTabIdToReturn, { active: true });
      await chrome.windows.update(gpagoWindowIdToReturn, { focused: true });
    } catch (_) {}
    // 누적된 데이터 전달 (primary 도 누적된 것 사용)
    const accumulatedPrimary = (accumulatedTabs['전체']?.data) || (accumulatedTabs['네이버페이']?.data) || quickCaptured;
    await sendToGpagoMultiTab(accumulatedPrimary, accumulatedTabs);
    await chrome.storage.local.remove(['lastNaverCapture', 'naverCapturesByTab', 'gpagoListenMode']);
    return;
  }

  // 캡처 실패 (보안 확인 대기 90초까지도 결과 캡처 안 됨) — 사용자가 직접 처리하도록 안내
  try { await chrome.windows.update(naverWindowId, { focused: true }); } catch (_) {}
  await chrome.storage.local.remove('gpagoListenMode');
  await alertOnTab(naverTab.id, 'GPAGO 자동 분석',
    '검색 결과 캡처에 실패했습니다. 보안 확인을 완료했는데도 이 메시지가 보이면, 팝업 창에서 정렬·페이징을 한 번 바꾸거나 GPAGO 에서 다시 검색해 주세요.');
}

// v1.7.43+ : 스마트스토어센터(비즈어드바이저) 판매성과/키워드 데이터 자동 수집
//   셀러센터를 팝업으로 열고, 사용자가 판매분석>판매성과(검색채널) 화면을 보는 동안
//   페이지가 호출하는 API 응답을 content-bizadvisor 가 캡처 → storage 에 누적 → 여기서 회수해 GPAGO 로 전달
async function collectBizadvisor(gpagoTab) {
  try { await chrome.storage.local.remove('bizadvisorCaptures'); } catch (_) {}
  const url = 'https://sell.smartstore.naver.com/#/bizadvisor/sales';
  let win;
  try {
    win = await chrome.windows.create({ url, type: 'popup', width: 1180, height: 800, focused: true });
  } catch (e) {
    try { await chrome.tabs.sendMessage(gpagoTab.id, { type: 'GPAGO_BIZADVISOR_RESULT', ok: false, error: '팝업 생성 실패: ' + (e && e.message || e) }); } catch (_) {}
    return;
  }
  const tab = win.tabs && win.tabs[0];
  if (!tab) return;
  await waitForTabLoad(tab.id, 20000);
  await new Promise(r => setTimeout(r, 2000));
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'BIZ_SHOW_BANNER',
      message: '🟢 GPAGO 수집 중 — 좌측 [데이터분석 ▸ 판매분석 ▸ 판매성과]로 이동해 키워드/검색채널 데이터를 화면에 띄워주세요. 실제 데이터가 잡히면 이 창은 자동으로 닫힙니다. (다 보셨으면 창을 닫아도 됩니다)'
    });
  } catch (_) {}

  // 최대 180초 동안 폴링 — 토큰(createToken)이 아닌 "실제 데이터" 응답이 잡히고 안정되면 종료
  const isToken = (u) => /createtoken|delegate|\/token/i.test(String(u || ''));
  const start = Date.now();
  let captures = [];
  let lastDataCount = 0;
  let dataStableSince = 0;
  while (Date.now() - start < 180000) {
    try { await chrome.windows.get(win.id); } catch (_) { break; } // 팝업 닫히면 종료
    try {
      const s = await chrome.storage.local.get('bizadvisorCaptures');
      captures = s.bizadvisorCaptures || [];
    } catch (_) {}
    const dataCount = captures.filter(c => !isToken(c.url)).length;
    if (dataCount !== lastDataCount) { lastDataCount = dataCount; dataStableSince = Date.now(); }
    // 실데이터가 1개 이상이고 8초간 추가 데이터가 없으면 종료
    if (dataCount > 0 && dataStableSince && (Date.now() - dataStableSince > 8000)) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  try { await chrome.tabs.sendMessage(tab.id, { type: 'BIZ_HIDE_BANNER' }); } catch (_) {}
  try { await chrome.tabs.sendMessage(gpagoTab.id, { type: 'GPAGO_BIZADVISOR_RESULT', ok: true, captures: captures }); } catch (_) {}
  try { await chrome.tabs.update(gpagoTab.id, { active: true }); await chrome.windows.update(gpagoTab.windowId, { focused: true }); } catch (_) {}
  try { await chrome.windows.remove(win.id); } catch (_) {}
  console.log('[GPAGO bg] 비즈어드바이저 수집 완료 —', captures.length, '개 응답');
}

// 메인 핸들러 — 아이콘 클릭/단축키 모두 이 함수를 호출
async function runGpagoAnalysis(tab) {
  console.log('[GPAGO bg] 실행됨 — tab.url:', tab?.url?.slice(0, 120));
  try {
    if (!tab || !tab.url) {
      await alertOnTab(tab?.id, 'GPAGO 자동 분석', '활성 탭을 찾을 수 없습니다.');
      return;
    }

    // GPAGO 탭에서 Ctrl+Q → N 입력값으로 새 네이버 탭 열고 캡처
    if (tab.url.includes(GPAGO_URL.replace(/https?:\/\//, '').replace(/\/$/, ''))) {
      console.log('[GPAGO bg] GPAGO 탭에서 실행됨 → N 입력값으로 새 네이버 탭 생성');
      await runGpagoFromGpagoTab(tab);
      return;
    }

    if (!tab.url.includes('search.shopping.naver.com')) {
      console.log('[GPAGO bg] 네이버 쇼핑/GPAGO 페이지가 아님');
      await alertOnTab(tab?.id, 'GPAGO 자동 분석',
        '네이버 쇼핑 검색 페이지 또는 GPAGO 사이트(N에 키워드 입력)에서 사용하세요.');
      return;
    }

    // 0) 시작 시 무조건 이전 listen 모드 + 이전 다중 탭 캡처 청소
    //    (이전 키워드의 데이터가 새 검색에 섞이는 것 방지)
    await chrome.storage.local.remove(['gpagoListenMode', 'naverCapturesByTab']);

    // 1) 기존 캡처 우선 사용 (단, 키워드 같을 때만 — sameSearchKeyword 검사)
    const { lastNaverCapture } = await chrome.storage.local.get('lastNaverCapture');
    console.log('[GPAGO bg] lastNaverCapture:', lastNaverCapture ? {
      capturedAt: lastNaverCapture.capturedAt,
      ageMs: Date.now() - lastNaverCapture.capturedAt,
      url: lastNaverCapture.url?.slice(0, 100),
      products: lastNaverCapture.data?.products?.length
    } : 'NONE');

    const isFresh = lastNaverCapture &&
                    lastNaverCapture.capturedAt &&
                    (Date.now() - lastNaverCapture.capturedAt) < CAPTURE_MAX_AGE_MS &&
                    sameSearchKeyword(lastNaverCapture.url, tab.url);
    console.log('[GPAGO bg] isFresh:', isFresh);

    if (isFresh && lastNaverCapture.data) {
      console.log('[GPAGO bg] path 1 — 즉시 GPAGO로 전송');
      await sendToGpago(lastNaverCapture.data);
      await chrome.storage.local.remove(['lastNaverCapture', 'gpagoListenMode']);
      return;
    }
    console.log('[GPAGO bg] path 2 — 대기 모드 진입');

    // 2) 대기 모드 + 자동 트리거
    await chrome.storage.local.set({
      gpagoListenMode: { tabId: tab.id, url: tab.url, requestedAt: Date.now() }
    });
    try { await chrome.tabs.sendMessage(tab.id, { type: 'GPAGO_RETRY_STATIC' }); } catch (_) {}
    try { await chrome.tabs.sendMessage(tab.id, { type: 'GPAGO_TRIGGER_ONCE' }); } catch (_) {}

    // 다중 탭 캡처 — 네이버페이(0.9초) + 전체(0.9초) = 약 1.8초 + 마진
    const quickCaptured = await waitForCapture(tab.url, 3500);
    if (quickCaptured) {
      // 두 번째 탭 캡처가 들어올 시간
      await new Promise(r => setTimeout(r, 1000));
      const { naverCapturesByTab } = await chrome.storage.local.get('naverCapturesByTab');
      const summary = Object.entries(naverCapturesByTab || {}).map(([k, v]) => `${k}(${v?.data?.products?.length || 0})`).join(', ');
      console.log('[GPAGO bg] 수집된 탭:', summary || '(없음)');
      await sendToGpagoMultiTab(quickCaptured, naverCapturesByTab || {});
      await chrome.storage.local.remove(['lastNaverCapture', 'naverCapturesByTab', 'gpagoListenMode']);
      return;
    }

    // 3) 배너로 사용자에게 직접 조작 요청
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'GPAGO_SHOW_BANNER',
        message: '👆 자동 트리거 실패 — 페이지에서 직접 정렬·페이지 크기·페이징 중 하나를 한 번 바꿔주세요.'
      });
    } catch (_) {}

    const captured = await waitForCapture(tab.url, WAIT_TIMEOUT_MS);
    try { await chrome.tabs.sendMessage(tab.id, { type: 'GPAGO_HIDE_BANNER' }); } catch (_) {}

    if (captured) {
      await new Promise(r => setTimeout(r, 1500));
      const { naverCapturesByTab } = await chrome.storage.local.get('naverCapturesByTab');
      await sendToGpagoMultiTab(captured, naverCapturesByTab || {});
      await chrome.storage.local.remove(['lastNaverCapture', 'naverCapturesByTab', 'gpagoListenMode']);
      return;
    }

    // 4) 시간 초과
    await chrome.storage.local.remove('gpagoListenMode');
    await alertOnTab(tab.id, 'GPAGO 자동 분석',
      '시간 내 페이지 조작이 감지되지 않았습니다.\n\n' +
      '페이지에서 80개씩 보기 / 정렬 변경 / 페이징 등 한 번 조작 후 다시 실행해 주세요.');
  } catch (e) {
    console.error('[GPAGO bg]', e);
    await alertOnTab(tab?.id, 'GPAGO 자동 분석', '오류: ' + (e?.message || String(e)));
  }
}

// (1) 아이콘 클릭 시
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[GPAGO bg] action.onClicked 발생');
  await runGpagoAnalysis(tab);
});

// (2) 단축키 (Ctrl+Q) — 활성 탭을 직접 가져와서 실행
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[GPAGO bg] commands.onCommand:', command);
  if (command !== 'run-gpago-analysis') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.warn('[GPAGO bg] 활성 탭을 찾지 못함');
      return;
    }
    await runGpagoAnalysis(tab);
  } catch (e) {
    console.error('[GPAGO bg] onCommand 오류:', e);
  }
});

// (GPAGO_AUTO_FORWARD 자동 전달 경로 제거됨 — Ctrl+Q 클릭 시에만 GPAGO로 전송)

// GPAGO 페이지의 N 입력란 Enter / 돋보기 클릭 → 확장이 Ctrl+Q와 동일하게 처리
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'GPAGO_TRIGGER_FROM_GPAGO' && sender?.tab) {
    const deep = Number(msg.deep || 0) || 0;  // v1.7.29+ : deep>0 이면 N 페이지 순차 캡처
    console.log('[GPAGO bg] GPAGO 페이지에서 트리거 요청 받음 — keyword:', msg.keyword, '| deep:', deep);
    // v1.7.42+ : 보안 확인 대기(최대 90초) 동안 service worker 가 죽지 않도록 keep-alive
    const _trigReqId = 'trig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    _gpagoStartKeepAlive(_trigReqId);
    Promise.resolve(runGpagoFromGpagoTab(sender.tab, deep))
      .finally(() => _gpagoStopKeepAlive(_trigReqId));
    return false;
  }
  // v1.7.43+ : 키워드 성과분석 — 스마트스토어센터 데이터 수집 요청
  if (msg && msg.type === 'GPAGO_REQUEST_BIZADVISOR' && sender?.tab) {
    const _bizReqId = 'biz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    _gpagoStartKeepAlive(_bizReqId);
    Promise.resolve(collectBizadvisor(sender.tab))
      .finally(() => _gpagoStopKeepAlive(_bizReqId));
    return false;
  }
  // ⚡ GPAGO 키워드 순위 카드 → 스마트스토어 빠른 모드 (v1.6.5+ 비활성화)
  // 진단 결과 (v1.6.4): Naver SmartStore HTML은 SSR shell — 찜/등록일/태그/리뷰 데이터가 전혀 없음
  // HTML 안에는 "regDate":"" (빈 문자열), reviewCountVisible (표시 플래그) 같은 미끼만 있음
  // → HTML fetch 는 179KB 다운로드하고 실패만 함 → 즉시 fallback 으로 넘김 (1~2초 절약)
  if (msg && msg.type === 'GPAGO_FETCH_SMARTSTORE_API' && sender?.tab) {
    (async () => {
      const senderTabId = sender.tab.id;
      const reqId = msg.reqId;
      // 즉시 실패 응답 → 페이지가 백그라운드 탭 폴백으로 빠르게 전환
      try {
        chrome.tabs.sendMessage(senderTabId, {
          type: 'GPAGO_SMARTSTORE_INFO_RESULT', reqId,
          ok: false, error: 'fast_mode_disabled_use_tab',
        });
      } catch (_) {}
    })();
    return false;
  }

  // GPAGO 키워드 순위 카드 → 스마트스토어 상품 정보 가져오기 (폴백: 백그라운드 탭 방식)
  // 새 방식 (v1.4.0+): 백그라운드 탭으로 실제 페이지 방문 → content-smartstore.js 가 DOM 추출 → 결과 전송 → 탭 닫음
  // 기존 fetch() 방식은 봇 감지로 차단 잘 됐음 — 실제 탭 방문은 일반 사용자 트래픽과 동일해 차단 회피
  if (msg && msg.type === 'GPAGO_FETCH_SMARTSTORE_INFO' && sender?.tab) {
    (async () => {
      const url = String(msg.url || '');
      const senderTabId = sender.tab.id;
      const reqId = msg.reqId;
      const searchHint = String(msg.searchHint || '');  // v1.7.10+ : 병렬 찜 검색 쿼리
      if (!url || (!url.includes('smartstore.naver.com') && !url.includes('brand.naver.com'))) {
        chrome.tabs.sendMessage(senderTabId, {
          type: 'GPAGO_SMARTSTORE_INFO_RESULT', reqId,
          ok: false, error: '스마트스토어/브랜드스토어 URL 만 지원'
        });
        return;
      }
      // ⭐ Service worker 가 30초 idle 후 종료되는 것 방지 — 진행 중 keep-alive
      _gpagoStartKeepAlive(reqId);
      console.log('[GPAGO bg] 백그라운드 탭으로 스마트스토어 fetch 시작 — reqId:', reqId, 'url:', url, '| searchHint:', searchHint);

      // v1.7.15+ : 찜수 검색 popup 비활성화 (사용자 요청 — 속도 우선)
      //   찜은 Naver 검색 결과 페이지에서만 보이고 popup 으로 ~10초 추가 소요
      //   캐시된 찜수는 그대로 유지, 새로 fetch 안 함
      const mUrl = url.match(/\/products\/(\d+)/);
      const mallProductId = mUrl ? mUrl[1] : null;
      const zzimPromise = Promise.resolve(null);

      let createdTabId = null;
      let createdWindowId = null;
      let resolved = false;
      const finish = (ok, data, error) => {
        if (resolved) return;
        resolved = true;
        chrome.runtime.onMessage.removeListener(listener);
        clearTimeout(timeoutId);
        _gpagoStopKeepAlive(reqId);
        // 윈도우 정리 (popup window 전체 닫기 → 그 안의 탭도 함께 닫힘)
        if (createdWindowId != null) {
          chrome.windows.remove(createdWindowId).catch(() => {});
          createdWindowId = null;
          createdTabId = null;
        } else if (createdTabId != null) {
          chrome.tabs.remove(createdTabId).catch(() => {});
          createdTabId = null;
        }
        console.log('[GPAGO bg] 스마트스토어 fetch 완료 — reqId:', reqId, 'ok:', ok, 'error:', error);
        try {
          chrome.tabs.sendMessage(senderTabId, {
            type: 'GPAGO_SMARTSTORE_INFO_RESULT', reqId,
            ok: !!ok, data: data || null, error: error || null,
          });
        } catch (e) {
          console.warn('[GPAGO bg] 응답 전송 실패:', e?.message || e);
        }
      };

      // content-smartstore.js 의 응답 리스너 — 생성한 탭에서 결과 오면 받음
      const listener = async (m, snd) => {
        if (!m || m.type !== 'GPAGO_SMARTSTORE_TAB_RESULT') return;
        if (!snd || !snd.tab || snd.tab.id !== createdTabId) return;
        console.log('[GPAGO bg] 스마트스토어 추출 — title:', (m.data?.title || '').slice(0, 40), '/ 리뷰', m.data?.reviewCount, '평점', m.data?.rating, '등록일', m.data?.registDate, '태그', (m.data?.tags || []).length);
        finish(m.ok, m.data, m.ok ? null : '데이터 추출 실패 (페이지 구조 변경 가능성)');
      };
      chrome.runtime.onMessage.addListener(listener);

      // 90초 timeout — 페이지 로드 + 데이터 비동기 로드 여유 (content-smartstore.js 의 MAX_ATTEMPTS 40 * 2s = 80s + 마진)
      const timeoutId = setTimeout(() => {
        finish(false, null, 'tab load timeout (90s)');
      }, 90000);

      // popup window 로 생성 — minimized 상태로 만들어 사용자에게 안 보이지만 throttle 없음
      // 일반 tab(active:false) 은 백그라운드 throttle 로 XHR/lazy-load 가 안 일어남 (찜수 등 추출 실패의 원인)
      // popup window + state:'minimized' 가 throttle 없이 페이지 정상 로드되는 유일한 방법.
      // (v1.6.8+) state:'minimized' 우선 시도 → 실패 시 안전 좌표 fallback → 생성 후 minimize 재시도
      try {
        let win = null;
        // 1차 시도: state:'minimized' 로 생성 (Chrome 정상 동작 시 throttle 없이 작동)
        try {
          win = await chrome.windows.create({
            url,
            type: 'popup',
            focused: false,
            state: 'minimized',
          });
        } catch (eState) {
          console.log('[GPAGO bg] popup(state:minimized) 실패 — 안전 좌표 폴백:', eState?.message || eState);
          // 2차 시도: 안전 좌표(0,0) + 작은 크기 → 생성 후 minimize 시도
          try {
            win = await chrome.windows.create({
              url,
              type: 'popup',
              focused: false,
              left: 0,
              top: 0,
              width: 400,
              height: 300,
            });
            // 생성 후 minimize (작업표시줄로) — 사용자가 보지 못함
            try { await chrome.windows.update(win.id, { state: 'minimized' }); } catch (_) {}
          } catch (e2) {
            console.log('[GPAGO bg] popup window 모두 실패, 백그라운드 탭 폴백 (throttle 가능성):', e2?.message || e2);
            const tab = await chrome.tabs.create({ url, active: false });
            createdTabId = tab.id;
            console.log('[GPAGO bg] 백그라운드 탭 생성됨 — tabId:', createdTabId);
          }
        }
        if (win) {
          if (win.tabs && win.tabs[0]) createdTabId = win.tabs[0].id;
          if (win.id != null) createdWindowId = win.id;
          console.log('[GPAGO bg] popup window 생성됨 (minimized) — tabId:', createdTabId, 'windowId:', createdWindowId);
        }
      } catch (e) {
        finish(false, null, 'window/tab create failed: ' + (e?.message || e));
      }
    })();
    return false;
  }
  // GPAGO 상품소싱 → "아이템스카우트 자동 분석" (카테고리 ID 또는 URL 입력)
  // → 새 팝업 윈도우로 itemscout 카테고리 페이지 열고 자동 스크롤 후 데이터 수집
  if (msg && msg.type === 'GPAGO_AUTO_FETCH_ITEMSCOUT' && sender?.tab) {
    (async () => {
      try {
        const gpagoTabId = sender.tab.id;
        const gpagoWindowId = sender.tab.windowId;
        // 카테고리 ID 추출 (URL 또는 숫자)
        let catId = String(msg.categoryIdOrUrl || '').trim();
        const m = catId.match(/category\/(\d+)/);
        if (m) catId = m[1];
        if (!/^\d+$/.test(catId)) {
          chrome.tabs.sendMessage(gpagoTabId, {
            type: 'GPAGO_ITEMSCOUT_RESULT', ok: false,
            error: '유효한 itemscout 카테고리 ID (숫자) 또는 URL 을 입력하세요.'
          });
          return;
        }
        const itemUrl = `https://itemscout.io/category/${catId}`;
        // 팝업 윈도우 생성 (포커스 받아야 페이지 JS 쓰로틀링 없이 빠르게 로드)
        const win = await chrome.windows.create({
          url: itemUrl, type: 'popup', width: 1100, height: 800, focused: true
        });
        const popupTabId = win.tabs[0].id;
        const popupWindowId = win.id;
        // 페이지 로드 대기 (최대 12초)
        await new Promise(resolve => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          const listener = (id, info) => { if (id === popupTabId && info.status === 'complete') { try { chrome.tabs.onUpdated.removeListener(listener); } catch(_) {} finish(); } };
          chrome.tabs.onUpdated.addListener(listener);
          chrome.tabs.get(popupTabId).then(t => { if (t.status === 'complete') finish(); }).catch(()=>{});
          setTimeout(finish, 12000);
        });
        // content script 가 자리 잡을 시간 (속도 개선: 1500 → 500ms)
        await new Promise(r => setTimeout(r, 500));
        // 자동 스크롤 트리거
        try {
          await chrome.tabs.sendMessage(popupTabId, { type: 'GPAGO_ITEMSCOUT_AUTO_SCROLL' });
        } catch (e) {
          console.warn('[GPAGO bg] itemscout 자동 스크롤 메시지 실패:', e);
        }
        // 스크롤 후 추가 안정화 대기 (속도 개선: 1000 → 300ms)
        await new Promise(r => setTimeout(r, 300));
        // 스냅샷 가져오기
        let snap;
        try {
          snap = await chrome.tabs.sendMessage(popupTabId, { type: 'GPAGO_GET_ITEMSCOUT_SNAPSHOT' });
        } catch (e) {
          chrome.tabs.sendMessage(gpagoTabId, {
            type: 'GPAGO_ITEMSCOUT_RESULT', ok: false,
            error: '팝업 페이지와 통신 실패: ' + (e?.message || e)
          });
          try { await chrome.windows.remove(popupWindowId); } catch(_) {}
          return;
        }
        // 팝업 닫고 GPAGO 탭으로 포커스 복귀
        try { await chrome.windows.remove(popupWindowId); } catch(_) {}
        try {
          await chrome.tabs.update(gpagoTabId, { active: true });
          await chrome.windows.update(gpagoWindowId, { focused: true });
        } catch(_) {}
        if (!snap || !snap.ok) {
          chrome.tabs.sendMessage(gpagoTabId, {
            type: 'GPAGO_ITEMSCOUT_RESULT', ok: false,
            error: snap?.error || '스냅샷 가져오기 실패'
          });
          return;
        }
        chrome.tabs.sendMessage(gpagoTabId, {
          type: 'GPAGO_ITEMSCOUT_RESULT', ok: true, snapshot: snap.snapshot
        });
      } catch (e) {
        try {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'GPAGO_ITEMSCOUT_RESULT', ok: false, error: String(e?.message || e)
          });
        } catch(_) {}
      }
    })();
    return false;
  }
  // GPAGO 상품소싱 → "아이템스카우트에서 가져오기" 버튼 클릭 시 (기존 — 열려있는 탭에서)
  if (msg && msg.type === 'GPAGO_GET_ITEMSCOUT' && sender?.tab) {
    (async () => {
      try {
        // itemscout.io 탭 찾기 (가장 최근 활성화된 탭 우선)
        const tabs = await chrome.tabs.query({ url: 'https://itemscout.io/*' });
        if (!tabs || tabs.length === 0) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'GPAGO_ITEMSCOUT_RESULT',
            ok: false,
            error: 'itemscout.io 탭이 열려있지 않습니다. itemscout.io/category/... 페이지를 먼저 열고 스크롤해서 키워드를 로드한 후 다시 시도하세요.'
          });
          return;
        }
        // 가장 최근 탭에 스냅샷 요청
        const tab = tabs[tabs.length - 1];
        let snap;
        try {
          snap = await chrome.tabs.sendMessage(tab.id, { type: 'GPAGO_GET_ITEMSCOUT_SNAPSHOT' });
        } catch (e) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'GPAGO_ITEMSCOUT_RESULT',
            ok: false,
            error: 'itemscout 탭과 통신 실패. 페이지를 새로고침하고 다시 시도하세요. (' + (e?.message || e) + ')'
          });
          return;
        }
        if (!snap || !snap.ok) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'GPAGO_ITEMSCOUT_RESULT',
            ok: false,
            error: snap?.error || '스냅샷 가져오기 실패'
          });
          return;
        }
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'GPAGO_ITEMSCOUT_RESULT',
          ok: true,
          snapshot: snap.snapshot
        });
      } catch (e) {
        try {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'GPAGO_ITEMSCOUT_RESULT', ok: false, error: String(e?.message || e)
          });
        } catch(_) {}
      }
    })();
    return false;
  }
});

function sameSearchKeyword(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    return a.searchParams.get('query') === b.searchParams.get('query');
  } catch (_) {
    return false;
  }
}

function waitForCapture(currentTabUrl, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      if (Date.now() - start > timeoutMs) { resolve(null); return; }
      try {
        const { lastNaverCapture } = await chrome.storage.local.get('lastNaverCapture');
        if (lastNaverCapture &&
            lastNaverCapture.capturedAt > start - 1000 &&
            sameSearchKeyword(lastNaverCapture.url, currentTabUrl)) {
          resolve(lastNaverCapture.data);
          return;
        }
      } catch (_) {}
      setTimeout(tick, 200); // 폴링 간격 단축 (400ms → 200ms)
    };
    tick();
  });
}

// v1.7.42+ : 보안 확인(캡차) 통과 대기 — 9초 quick 캡처 실패 후 호출됨.
//   팝업을 포커스로 띄우고 안내 배너를 표시한 뒤, 사용자가 보안 확인을 완료해
//   결과 페이지가 로드되면 자동으로 캡처되는 것을 최대 WAIT_TIMEOUT_MS 동안 기다린다.
//   → 사용자가 GPAGO 를 새로고침하거나 재검색할 필요 없이 그대로 이어짐.
//   (blocking alert 대신 배너 사용 — alert 는 캡차 입력 자체를 막기 때문)
async function waitForCaptureAfterSecurity(naverTabId, naverWindowId, naverUrl) {
  console.log('[GPAGO bg] 보안 확인 추정 — 캡차 완료 대기 모드 진입 (최대', WAIT_TIMEOUT_MS / 1000, '초)');
  // 팝업을 앞으로 가져와 사용자가 보안 확인(캡차)을 바로 풀 수 있게
  try { await chrome.windows.update(naverWindowId, { focused: true }); } catch (_) {}
  // gpagoListenMode 유지 — 보안 확인 통과 후 content/inject 가 계속 캡처하도록
  // 안내 배너 표시 (content-naver 의 GPAGO_SHOW_BANNER 핸들러)
  try {
    await chrome.tabs.sendMessage(naverTabId, {
      type: 'GPAGO_SHOW_BANNER',
      message: '🔒 보안 확인을 완료해 주세요. 완료하면 자동으로 분석이 이어집니다 — 새로고침하지 마세요.'
    });
  } catch (_) {}

  const start = Date.now();
  let lastNudge = 0;
  let result = null;
  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    // 이 대기 시작 이후의 새 캡처만 인정 (보안 확인 통과 후 로드된 결과)
    try {
      const { lastNaverCapture } = await chrome.storage.local.get('lastNaverCapture');
      if (lastNaverCapture &&
          lastNaverCapture.capturedAt > start - 1000 &&
          sameSearchKeyword(lastNaverCapture.url, naverUrl)) {
        result = lastNaverCapture.data;
        console.log('[GPAGO bg] 보안 확인 완료 감지 — 캡처 도착, 분석 재개');
        break;
      }
    } catch (_) {}
    // 3초마다 passive 재추출 nudge (결과가 떠 있는데 캡처가 늦는 경우 대비 — 페이지 조작 없음)
    if (Date.now() - lastNudge > 3000) {
      lastNudge = Date.now();
      try { await chrome.tabs.sendMessage(naverTabId, { type: 'GPAGO_RETRY_STATIC' }); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 250));
  }

  // 배너 제거
  try { await chrome.tabs.sendMessage(naverTabId, { type: 'GPAGO_HIDE_BANNER' }); } catch (_) {}
  return result;
}

async function sendToGpago(data) {
  await chrome.storage.local.set({
    pendingShoppingJson: data,
    pendingAt: Date.now()
  });
  const existing = await chrome.tabs.query({ url: GPAGO_URL + '*' });
  if (existing.length > 0) {
    const t = existing[0];
    // url 인자 제거 — 기존 페이지를 navigation 시키지 않음 (storage.onChanged 가 자동 감지)
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: GPAGO_URL + '#gpago-auto-analyze', active: true });
  }
}

// v1.7.20+ : 상품 객체 슬림화 — chrome.storage.local 10MB 한도 회피
//   (400개 × 모든 필드 = 수MB. 필수 필드만 남겨 ~1MB 이하로 축소)
function _slimProduct(p) {
  if (!p || typeof p !== 'object') return p;
  return {
    id: p.id || p.productId || p.nvMid || p.mid,
    productTitle: p.productTitle || p.productName || p.title || '',
    productName: p.productName,
    mallName: p.mallName || p.mallNameWithoutLogistics || '',
    mallNameWithoutLogistics: p.mallNameWithoutLogistics,
    brandName: p.brand || p.brandName || '',
    price: Number(p.price || 0) || undefined,
    lowPrice: Number(p.lowPrice || 0) || undefined,
    imageUrl: p.imageUrl || p.image || '',
    reviewCount: p.reviewCount,
    rating: p.rating,
    scoreInfo: p.scoreInfo ? { scoreRating: p.scoreInfo.scoreRating, totalReviewCount: p.scoreInfo.totalReviewCount } : undefined,
    productType: p.productType,
    productSetType: p.productSetType,
    lowMallList: Array.isArray(p.lowMallList) ? p.lowMallList.slice(0, 3).map(m => ({ mall: m.mall, price: m.price })) : undefined,
    mallProductId: p.mallProductId,
    npayProductId: p.npayProductId,
    crUrl: p.crUrl || p.adcrUrl || p.dlUrl,
    category1Name: p.category1Name || p.category1,
    category2Name: p.category2Name || p.category2,
    category3Name: p.category3Name || p.category3,
    category4Name: p.category4Name || p.category4,
    // v1.7.37+ : 속성(characterValue) + 태그(manuTag) — 키워드 분석 결과 표시용
    characterValue: p.characterValue,
    manuTag: p.manuTag,
    // 그룹 감지 필드 (std*OptCount)
    ...(() => {
      const keys = Object.keys(p);
      const out = {};
      keys.forEach(k => { if (/^std.*OptCount$/i.test(k)) out[k] = p[k]; });
      return out;
    })(),
  };
}
function _slimPayload(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    query: data.query,
    terms: Array.isArray(data.terms) ? data.terms : undefined,
    nluTerms: Array.isArray(data.nluTerms) ? data.nluTerms : undefined,
    searchParam: data.searchParam ? { productSet: data.searchParam.productSet } : undefined,
    productSetFilter: data.productSetFilter ? { name: data.productSetFilter.name } : undefined,
    total: data.total,
    products: Array.isArray(data.products) ? data.products.map(_slimProduct) : [],
  };
}

// 다중 탭 캡처를 GPAGO로 전달
async function sendToGpagoMultiTab(primaryData, capturesByTab) {
  const tabsMap = {};
  for (const [tab, cap] of Object.entries(capturesByTab)) {
    if (cap && cap.data) tabsMap[tab] = _slimPayload(cap.data);
  }
  primaryData = _slimPayload(primaryData);
  if (Object.keys(tabsMap).length === 0 && primaryData) {
    tabsMap['전체'] = primaryData;
  }
  // 항상 '네이버페이' 탭 데이터를 초기 표시로 사용 (없으면 전체, 그것도 없으면 primaryData)
  const finalPrimary = tabsMap['네이버페이'] || tabsMap['전체'] || primaryData;
  await chrome.storage.local.set({
    pendingShoppingJson: finalPrimary,
    pendingShoppingTabs: tabsMap,
    pendingAt: Date.now()
  });
  console.log('[GPAGO bg] 다중 탭 전달:', Object.keys(tabsMap).map(t => `${t}(${tabsMap[t].products?.length})`).join(', '), '| primary:', tabsMap['전체'] ? '전체' : '네이버페이');

  const existing = await chrome.tabs.query({ url: GPAGO_URL + '*' });
  if (existing.length > 0) {
    const t = existing[0];
    // 활성화 + 포커스 (reload 제거 — JS 상태 손실 방지)
    // content-gpago.js 가 storage.onChanged 로 자동 감지하므로 reload 불필요
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: GPAGO_URL + '#gpago-auto-analyze', active: true });
  }
}

async function alertOnTab(tabId, title, message) {
  console.warn('[GPAGO]', title, '-', message);
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (t, m) => { alert('[' + t + ']\n' + m); },
      args: [title, message]
    });
  } catch (_) {}
}
