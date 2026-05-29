// 네이버 쇼핑 페이지의 MAIN world에서 실행 — 완전 수동(passive) 캡처 전용
// 페이지를 자동으로 조작하지 않음:
//   - URL 변경 안 함
//   - 클릭 시뮬레이션 안 함
//   - 추가 fetch 호출 안 함
// 오직 페이지가 자체적으로 발생시키는 fetch/XHR 응답을 관찰만 함 (anti-bot 탐지 회피)
(function () {
  if (window.__gpago_inject_done__) return;
  window.__gpago_inject_done__ = true;

  const SKIP_FIBER_KEYS = new Set(['_owner','stateNode','return','child','sibling','alternate','firstEffect','lastEffect','nextEffect','dependencies','contextDependencies','_reactInternals','_reactInternalFiber']);

  function findShoppingResult(obj, depth, visited) {
    if (!obj || typeof obj !== 'object') return null;
    if (depth > 14) return null;
    if (visited.has(obj)) return null;
    visited.add(obj);
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length && i < 100; i++) {
        const r = findShoppingResult(obj[i], depth + 1, visited);
        if (r) return r;
      }
      return null;
    }
    if (obj.shoppingResult && Array.isArray(obj.shoppingResult.products) && obj.shoppingResult.products.length > 0) {
      return obj.shoppingResult;
    }
    if (Array.isArray(obj.products) && obj.products.length > 0 && typeof obj.query === 'string') {
      return obj;
    }
    try {
      const keys = Object.keys(obj);
      for (const key of keys) {
        if (SKIP_FIBER_KEYS.has(key)) continue;
        const r = findShoppingResult(obj[key], depth + 1, visited);
        if (r) return r;
      }
    } catch (_) {}
    return null;
  }

  function extractBalancedJson(text, start) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function scanStringForShoppingResult(text) {
    let idx = 0;
    let tries = 0;
    while (idx < text.length && tries < 50) {
      const startIdx = text.indexOf('{', idx);
      if (startIdx < 0) break;
      const jsonStr = extractBalancedJson(text, startIdx);
      if (jsonStr && jsonStr.length > 200 &&
          (jsonStr.includes('"products"') || jsonStr.includes('shoppingResult'))) {
        try {
          const obj = JSON.parse(jsonStr);
          const found = findShoppingResult(obj, 0, new WeakSet());
          if (found) return found;
        } catch (_) {}
        idx = startIdx + jsonStr.length;
      } else if (jsonStr) {
        idx = startIdx + jsonStr.length;
      } else {
        idx = startIdx + 1;
      }
      tries++;
    }
    return null;
  }

  function tryAllScriptTags() {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text || text.length < 100) continue;
      if (!text.includes('"products"') && !text.includes('shoppingResult') && !text.includes('__next_f')) continue;

      try {
        const json = JSON.parse(text);
        const found = findShoppingResult(json, 0, new WeakSet());
        if (found) return found;
      } catch (_) {}

      if (text.includes('__next_f')) {
        const pushRegex = /self\.__next_f\.push\(\[\d+,\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"[^"]*")?\s*\]\)/g;
        let m;
        while ((m = pushRegex.exec(text)) !== null) {
          let payload;
          try { payload = JSON.parse('"' + m[1] + '"'); } catch (_) { continue; }
          if (!payload.includes('"products"') && !payload.includes('shoppingResult')) continue;
          const found = scanStringForShoppingResult(payload);
          if (found) return found;
        }
      }

      const found = scanStringForShoppingResult(text);
      if (found) return found;
    }
    return null;
  }

  function tryNextFGlobal() {
    if (!self.__next_f || !Array.isArray(self.__next_f)) return null;
    for (const entry of self.__next_f) {
      if (!Array.isArray(entry)) continue;
      for (const part of entry) {
        if (typeof part !== 'string') continue;
        if (!part.includes('"products"') && !part.includes('shoppingResult')) continue;
        const found = scanStringForShoppingResult(part);
        if (found) return found;
      }
    }
    return null;
  }

  function tryWindowGlobals() {
    const namedCandidates = [
      '__NEXT_DATA__','__INITIAL_STATE__','__REACT_QUERY_STATE__','__APOLLO_STATE__',
      '__PRELOADED_STATE__','__INITIAL_PROPS__','__STORE_INITIAL_STATE__',
      '__PRELOADED_DATA__','__DATA__','appData','pageData','__INITIAL__'
    ];
    for (const name of namedCandidates) {
      try {
        const v = window[name];
        if (!v) continue;
        const found = findShoppingResult(v, 0, new WeakSet());
        if (found) return found;
      } catch (_) {}
    }
    return null;
  }

  function tryReactFiber() {
    const selectors = [
      'a[href*="/product/"]', 'a[href*="/catalog/"]',
      '[class*="product"]', '[class*="basicList"]', '[class*="adProduct"]'
    ];
    for (const sel of selectors) {
      let els;
      try { els = document.querySelectorAll(sel); } catch(_) { continue; }
      for (let i = 0; i < Math.min(els.length, 3); i++) {
        const el = els[i];
        const fiberKey = Object.keys(el).find(k =>
          k.startsWith('__reactFiber$') ||
          k.startsWith('__reactInternalInstance$')
        );
        if (!fiberKey) continue;
        let fiber = el[fiberKey];
        let depth = 0;
        const visited = new WeakSet();
        while (fiber && depth < 60) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (props) {
            const found = findShoppingResult(props, 0, visited);
            if (found) return found;
          }
          fiber = fiber.return;
          depth++;
        }
      }
    }
    return null;
  }

  // triggerOnce가 탭 클릭 직전 설정 — 그 직후 캡처되는 데이터의 정확한 라벨
  window.__gpago_expected_tab__ = null;

  // 캡처 데이터 → 탭 종류 라벨 (productSet 값 기준, 광범위 매칭)
  function detectTabLabelFromData(found) {
    try {
      const ps = String(found?.searchParam?.productSet || found?.productSetFilter?.name || '').toLowerCase();
      if (ps.includes('npay') || ps.includes('naverpay')) return '네이버페이';
      if (ps.includes('overseas') || ps.includes('store')) return '네이버페이';
      if (ps.includes('model') || ps.includes('compare') || ps.includes('group')) return '가격비교';
      if (ps.includes('checkout') || ps.includes('total') || ps === '') return '전체';
    } catch (_) {}
    return '전체';
  }

  function capture(rawData, source) {
    try {
      const found = findShoppingResult(rawData, 0, new WeakSet());
      if (!found) return false;
      const tabLabel = window.__gpago_expected_tab__ || detectTabLabelFromData(found);
      const productSetRaw = String(found?.searchParam?.productSet || found?.productSetFilter?.name || '');
      const newCount = (found.products?.length) || 0;
      window.__gpago_captures__ = window.__gpago_captures__ || {};
      const existing = window.__gpago_captures__[tabLabel];
      const existingCount = existing?.products?.length || 0;
      // 같은 탭에 이미 캡처가 있고, 새 캡처가 더 작으면 무시 (큰 게 우선)
      if (existing && existingCount >= newCount) {
        console.log('[GPAGO] 더 작은 캡처 무시 — tab:', tabLabel, '| existing:', existingCount, '| new:', newCount);
        return false;
      }
      window.__gpago_last_data__ = found;
      window.__gpago_captures__[tabLabel] = found;
      window.__gpago_content_alive__ = false;
      window.postMessage({
        source: 'gpago-inject',
        type: 'GPAGO_CAPTURED',
        data: found,
        tab: tabLabel,
        from: source
      }, window.location.origin);
      console.log('[GPAGO] captured — tab:', tabLabel, '| productSet:', productSetRaw || '(none)', '| products:', newCount, '| source:', source);
      setTimeout(() => {
        if (!window.__gpago_content_alive__ && !window.__gpago_dead_banner_shown__) {
          window.__gpago_dead_banner_shown__ = true;
          showRefreshBanner();
        }
      }, 600);
      return true;
    } catch (_) {
      return false;
    }
  }

  // content-naver 사망 시 페이지 새로고침 안내 배너
  function showRefreshBanner() {
    if (document.getElementById('__gpago_refresh_banner__')) return;
    const div = document.createElement('div');
    div.id = '__gpago_refresh_banner__';
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#FF6B6B,#FF8E53);color:white;padding:14px 24px;font-size:13px;font-weight:bold;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;gap:12px;line-height:1.4;';
    div.innerHTML = '<span>⚠️ 확장 프로그램이 재로드되어 캡처를 저장할 수 없습니다. <b>F5로 페이지를 새로고침</b>해 주세요.</span>' +
      '<button id="__gpago_refresh_btn__" style="background:white;border:none;color:#FF6B6B;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;">새로고침</button>' +
      '<button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,.2);border:none;color:white;padding:4px 10px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;">닫기</button>';
    (document.body || document.documentElement).appendChild(div);
    setTimeout(() => {
      const btn = document.getElementById('__gpago_refresh_btn__');
      if (btn) btn.addEventListener('click', () => location.reload());
    }, 50);
  }

  function shouldInspectUrl(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    const exts = ['.css','.js','.png','.jpg','.jpeg','.gif','.webp','.svg','.woff','.woff2','.ttf','.ico','.mp4','.mp3'];
    for (const e of exts) {
      if (u.endsWith(e)) return false;
      if (u.includes(e + '?')) return false;
    }
    if (u.includes('nlog.naver.com')) return false;
    if (u.includes('ssl.pstatic.net')) return false;
    if (u.includes('//gfp')) return false;
    return true;
  }

  // ── fetch 래핑 (관찰만 — 추가 요청 안 함, 페이지 동작 변경 안 함) ──
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const p = origFetch.apply(this, args);
    if (shouldInspectUrl(url)) {
      p.then(res => {
        try {
          res.clone().text().then(text => {
            if (!text || text.length > 10_000_000) return;
            const c0 = text.trimStart()[0];
            if (c0 !== '{' && c0 !== '[') return;
            try {
              const data = JSON.parse(text);
              capture(data, 'fetch:' + url.slice(0, 80));
            } catch (_) {}
          }).catch(() => {});
        } catch (_) {}
      }).catch(() => {});
    }
    return p;
  };
  // fetch.toString을 원본처럼 위장 (anti-bot 우회 일부)
  try {
    window.fetch.toString = () => 'function fetch() { [native code] }';
  } catch (_) {}

  // ── XHR 래핑 (관찰만) ──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gpago_url__ = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (shouldInspectUrl(xhr.__gpago_url__)) {
      xhr.addEventListener('load', function () {
        try {
          const text = xhr.responseText;
          if (!text || text.length > 10_000_000) return;
          const c0 = text.trimStart()[0];
          if (c0 !== '{' && c0 !== '[') return;
          const data = JSON.parse(text);
          capture(data, 'xhr:' + (xhr.__gpago_url__ || '').slice(0, 80));
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // ── 페이지 정적 데이터 탐색 (DOM 준비 시 + 여러 시점) — 모두 passive read ──
  function runStaticExtraction() {
    if (window.__gpago_last_data__) return;
    let found = tryNextFGlobal();
    if (found) { capture(found, 'static:__next_f'); return; }
    found = tryWindowGlobals();
    if (found) { capture(found, 'static:globals'); return; }
    found = tryAllScriptTags();
    if (found) { capture(found, 'static:scripts'); return; }
    found = tryReactFiber();
    if (found) { capture(found, 'static:fiber'); return; }
  }

  // ── 옵션 A: 사용자 click 시점에만 1회 자동 트리거 ──
  // (페이지 로드 시 자동 실행 안 함, 사용자가 확장 클릭한 경우에만 1번 실행)
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch (_) {}
    return true;
  }

  function isActiveOption(el) {
    let cur = el;
    for (let i = 0; i < 5 && cur; i++) {
      if (cur.getAttribute) {
        const aSel = cur.getAttribute('aria-selected');
        const aCur = cur.getAttribute('aria-current');
        if (aSel === 'true' || aCur === 'true' || aCur === 'page') return true;
      }
      const cls = (cur.className && typeof cur.className === 'string') ? cur.className : '';
      if (/\b(active|selected|current|on|isActive|isSelected)\b/.test(cls)) return true;
      if (/--active|--selected|--current|_active|_selected|_current|__active|__selected/i.test(cls)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function realClick(el) {
    if (!el) return;
    let target = el;
    for (let i = 0; i < 3 && target; i++) {
      const tag = target.tagName;
      if (tag === 'BUTTON' || tag === 'A' || target.getAttribute?.('role') === 'button' || target.onclick) break;
      target = target.parentElement;
    }
    target = target || el;
    try {
      const rect = target.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: rect.left + 5, clientY: rect.top + 5 };
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.dispatchEvent(new MouseEvent('click', opts));
    } catch (_) {}
    try { target.click(); } catch (_) {}
  }

  function findAllClickableByText(text) {
    const all = document.querySelectorAll('button, a, li, span, div[role="button"], div[role="option"], [class*="select"], [class*="option"]');
    const result = [];
    for (const el of all) {
      const txt = (el.textContent || '').trim();
      if (txt === text || txt === text + ' 보기' || txt === text + '보기') {
        result.push(el);
      }
    }
    return result;
  }

  function findActiveAndOthers(textList) {
    const items = [];
    for (const text of textList) {
      const els = findAllClickableByText(text);
      for (const el of els) {
        items.push({ text, el, active: isActiveOption(el) });
      }
    }
    const active = items.find(i => i.active);
    const activeText = active ? active.text : null;
    const others = items.filter(i => i.text !== activeText);
    return { active, others };
  }

  // 검색 결과 필터 탭만 정확히 찾기 (전역 네비 링크는 제외)
  function findSearchFilterTab(text) {
    const TAB_NAMES = ['전체', '가격비교', '네이버페이', '백화점/홈쇼핑', '쇼핑윈도', '해외직구'];
    const candidates = findAllClickableByText(text);
    for (const el of candidates) {
      // 부모 6단계 위까지 거슬러 올라가며 다른 탭 텍스트가 3개 이상 있는 컨테이너 찾기
      let container = el.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        const txt = container.textContent || '';
        let count = 0;
        for (const t of TAB_NAMES) {
          if (t !== text && txt.includes(t)) count++;
        }
        if (count >= 3) {
          // 추가 안전장치: <a>면 외부 도메인 링크는 제외
          if (el.tagName === 'A' && el.href) {
            const href = el.href.toLowerCase();
            if (href.includes('pay.naver.com') || href.includes('order.pay') || href.includes('//pay.')) {
              break;
            }
          }
          return el;
        }
        container = container.parentElement;
      }
    }
    return null;
  }

  // 사용자 click 시 1회만 호출됨 — 필요한 탭만 클릭 (이미 캡처된 탭은 스킵)
  // 페이지 초기 로드 시 자동 XHR이 발생하므로 (보통 전체 탭이 기본),
  // 그 캡처가 이미 있으면 추가 클릭 안 함 → 속도 개선
  let _triggerOnceUsed = false;
  async function triggerOnce() {
    if (_triggerOnceUsed) {
      console.log('[GPAGO] 자동 트리거 이미 사용됨 (페이지 로드 후 1회만)');
      return false;
    }
    _triggerOnceUsed = true;

    const captures = window.__gpago_captures__ = window.__gpago_captures__ || {};
    console.log('[GPAGO] triggerOnce 시작 — 기존 캡처:', Object.keys(captures).join(',') || '(없음)');

    // Step 1: 네이버페이 탭 (이미 캡처 없으면 클릭)
    if (!captures['네이버페이']) {
      const npayTabEl = findSearchFilterTab('네이버페이');
      if (npayTabEl && isVisible(npayTabEl)) {
        window.__gpago_expected_tab__ = '네이버페이';
        console.log('[GPAGO] 검색 탭 → 네이버페이');
        realClick(npayTabEl);
        await sleep(900);
      } else {
        console.log('[GPAGO] 네이버페이 탭 못 찾음 — 건너뜀');
      }
    } else {
      console.log('[GPAGO] 네이버페이 이미 캡처됨 — 스킵');
    }

    // Step 2: 전체 탭 (이미 캡처 없으면 클릭)
    if (!captures['전체']) {
      const allTabEl = findSearchFilterTab('전체');
      if (allTabEl && isVisible(allTabEl)) {
        window.__gpago_expected_tab__ = '전체';
        console.log('[GPAGO] 검색 탭 → 전체');
        realClick(allTabEl);
        await sleep(900);
      } else {
        console.log('[GPAGO] 전체 탭 못 찾음 — 건너뜀');
      }
    } else {
      console.log('[GPAGO] 전체 이미 캡처됨 — 스킵');
    }

    window.__gpago_expected_tab__ = null;
    console.log('[GPAGO] 트리거 완료 — 캡처 결과:', Object.entries(captures).map(([k,v]) => `${k}(${v.products?.length})`).join(', '));
    return true;
  }

  // content-naver에서 메시지 받기
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'gpago-content') return;
    if (e.data.type === 'GPAGO_RETRY_EXTRACTION') {
      // v1.7.23+ : multi-page 등 강제 재추출 — guard 해제 + 캐시 초기화
      try {
        window.__gpago_last_data__ = null;
        window.__gpago_captures__ = {};
        _triggerOnceUsed = false;
      } catch (_) {}
      runStaticExtraction();
    }
    if (e.data.type === 'GPAGO_TRIGGER_ONCE') {
      triggerOnce();
    }
    if (e.data.type === 'CAPTURE_ACK') {
      // content-naver 살아있음 — 새로고침 배너 안 띄움
      window.__gpago_content_alive__ = true;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      runStaticExtraction();
      setTimeout(runStaticExtraction, 1000);
      setTimeout(runStaticExtraction, 2500);
    });
  } else {
    runStaticExtraction();
    setTimeout(runStaticExtraction, 1000);
  }

  console.log('[GPAGO] inject ready — passive 캡처만 (자동 트리거 없음)');
})();
