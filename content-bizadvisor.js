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
  // 요청 메타 저장 (직접 API 호출 인증 방식 파악용)
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'gpago-biz-inject' || e.data.type !== 'BIZ_REQ') return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      const entry = { url: e.data.url || '', method: e.data.method || 'GET', headers: e.data.headers || {}, body: e.data.body || null, at: Date.now() };
      const store = await chrome.storage.local.get('bizadvisorRequests');
      const arr = store.bizadvisorRequests || [];
      const idx = arr.findIndex(x => x.url === entry.url);
      if (idx >= 0) arr.splice(idx, 1);
      arr.unshift(entry);
      if (arr.length > 20) arr.length = 20;
      await chrome.storage.local.set({ bizadvisorRequests: arr });
      // v1.7.59+ : 키워드 리포트를 보면, 같은 프레임(same-origin)에서 상품 차원으로 능동 재조회 → 상품별 데이터 확보
      try { _gpagoFetchPerProduct(entry.url); } catch (_) {}
    } catch (_) {}
  });

  // 상품별(product dimension) 리포트 능동 조회 — bizadvisor 아이프레임 내 same-origin fetch (cookie/referer 정상 → JSON 반환)
  //   키워드 리포트 URL 형태가 불확실하므로, report 요청 여러 개를 상품 차원으로 시도해
  //   '상품ID + ref_keyword' 행이 나오는 응답을 채택한다.
  let _gpagoPerProductDone = false;
  const _ppTried = new Set();
  let _ppAttempts = 0;
  function _ppProdKey(row){
    if(!row||typeof row!=='object') return null;
    for(const k of ['mall_product_id','origin_product_no','product_no','mall_product_no','product_id','nv_mid','mid']) if(k in row && row[k]!=null) return k;
    for(const k in row){ if(/product/i.test(k)&&/(id|no)$/i.test(k)) return k; }
    return null;
  }
  function _ppProdName(row){
    if(!row||typeof row!=='object') return null;
    for(const k of ['mall_product_name','product_name','origin_product_name','product_title']) if(k in row && row[k]) return k;
    for(const k in row){ if(/product/i.test(k)&&/(name|title)/i.test(k)) return k; }
    return null;
  }
  async function _gpagoFetchPerProduct(reportUrl) {
    if (_gpagoPerProductDone) return;
    reportUrl = String(reportUrl || '');
    // 리포트 API 는 sell.smartstore.naver.com/biz_iframe/... 또는 bizadvisor.naver.com 에서 옴.
    //   same-origin(요청 origin === 현재 프레임 origin)일 때만 fetch (CORS 회피)
    let _u; try { _u = new URL(reportUrl); } catch (_) { return; }
    if (_u.origin !== location.origin) return;
    if (!/\/biz_iframe\/api\//i.test(reportUrl)) return; // 비즈어드바이저 리포트 API 요청
    // 상품×키워드 pivot (dimensions 에 product + ref_keyword 둘 다) 만 베이스로 사용
    if (!/[?&]dimensions=[^&]*ref_keyword/i.test(reportUrl)) return;
    if (!/[?&]dimensions=[^&]*product/i.test(reportUrl)) return; // 상품 차원 포함된 per-product pivot
    if (_ppTried.has(reportUrl) || _ppAttempts >= 2) return;
    _ppTried.add(reportUrl); _ppAttempts++;
    const setParam = (u, k, v) => { const re = new RegExp('([?&]' + k + '=)[^&]*', 'i'); return re.test(u) ? u.replace(re, '$1' + encodeURIComponent(v)) : (u + (u.indexOf('?') >= 0 ? '&' : '?') + k + '=' + encodeURIComponent(v)); };
    const getRows = (data) => Array.isArray(data) ? data : (data && (data.rows || data.data)) || null;
    const _selfCapture = (url, data) => { try { window.postMessage({ source: 'gpago-biz-inject', type: 'BIZ_CAPTURED', url: String(url), data: data }, location.origin); } catch (_) {} };
    async function fetchJson(url) {
      try {
        const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const ct = String(r.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('json') < 0) return null;
        return await r.json();
      } catch (_) { return null; }
    }
    const hasInflow = (rows) => Array.isArray(rows) && rows.length && rows.some(r => { for (const k in r) { if (/interaction|inflow|num_users|num_visit|^pv$|num_click/i.test(k) && r[k] != null) return true; } return false; });
    const diag = [];
    // 1) base 그대로 (결제 metric) — 상품×키워드 결제 확보
    const baseData = await fetchJson(reportUrl);
    const baseRows = getRows(baseData);
    diag.push({ what: 'base', rows: baseRows ? baseRows.length : null, keys: (baseRows && baseRows[0]) ? Object.keys(baseRows[0]) : null });
    if (Array.isArray(baseRows) && baseRows.length && _ppProdKey(baseRows[0]) && ('ref_keyword' in baseRows[0])) {
      _gpagoPerProductDone = true;
      _selfCapture('__gpago_perproduct__::base', baseData);
    }
    // 2) 유입 metric 변형으로 같은 pivot 한 번 더 (dimensions 그대로) — 상품×키워드 유입 확보
    const infMetrics = ['num_interaction', 'simple_num_users', 'attribution_num_interaction_by_payment_date', 'num_interaction_by_payment_date', 'attribution_num_interaction', 'simple_num_users_by_payment_date'];
    for (const m of infMetrics) {
      const data = await fetchJson(setParam(reportUrl, 'metrics', m));
      const rows = getRows(data);
      diag.push({ what: 'inflow:' + m, rows: rows ? rows.length : null, keys: (rows && rows[0]) ? Object.keys(rows[0]) : null });
      if (Array.isArray(rows) && rows.length && _ppProdKey(rows[0]) && ('ref_keyword' in rows[0]) && hasInflow(rows)) {
        _selfCapture('__gpago_ppinflow__::' + m, data);
        break;
      }
    }
    if (!_gpagoPerProductDone) { try { _selfCapture('__gpago_ppdiag__::base', { base: reportUrl.slice(0, 160), diag: diag }); } catch (_) {} }
  }

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
