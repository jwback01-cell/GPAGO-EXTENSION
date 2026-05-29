// itemscout.io 페이지의 XHR / fetch 응답을 가로채서 키워드 목록 데이터 캡처
(function () {
  if (window.__gpago_itemscout_injected__) return;
  window.__gpago_itemscout_injected__ = true;
  window.__itemscoutCaptures__ = [];
  window.__itemscoutKeywords__ = new Map(); // keywordId 기준 중복 제거 누적
  window.__itemscoutCategoryLookup__ = new Map(); // id → name (subcategories 응답에서 누적)
  window.__itemscoutCategoryParent__ = new Map(); // id → parent_id (가능하면 채움)
  window.__itemscoutCategoryPath__ = null; // 현재 카테고리 경로

  // 응답에서 가장 큰 객체 배열의 위치/길이를 찾음 (필드명을 모를 때 행 수로 추정)
  function findLargestObjectArray(data, path = '', best = { path: null, len: 0, sample: null, ref: null }) {
    if (!data) return best;
    if (Array.isArray(data) && data.length > best.len && typeof data[0] === 'object') {
      best = { path, len: data.length, sample: data[0], ref: data };
    }
    if (typeof data === 'object' && !Array.isArray(data)) {
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (Array.isArray(v) || (v && typeof v === 'object')) {
          best = findLargestObjectArray(v, path ? path + '.' + k : k, best);
        }
      }
    }
    return best;
  }

  // 응답이 키워드 목록인지 추정: 객체 배열이 20개 이상이면 키워드 후보
  function detectKeywordList(data) {
    const found = findLargestObjectArray(data);
    return found.len >= 20;
  }

  function previewObject(obj, maxKeys = 15) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    let i = 0;
    for (const k of Object.keys(obj)) {
      if (i++ >= maxKeys) { out['...'] = '(more)'; break; }
      const v = obj[k];
      if (v == null) out[k] = null;
      else if (Array.isArray(v)) out[k] = `[배열 ${v.length}]`;
      else if (typeof v === 'object') out[k] = '{객체}';
      else out[k] = String(v).slice(0, 30);
    }
    return out;
  }

  // itemscout 키워드 데이터를 누적 (keywordId 중복 제거)
  function accumulateKeywords(data, url) {
    const found = findLargestObjectArray(data);
    if (found.len < 3) return 0;
    const sample = found.sample;
    // 키워드 응답인지 확인 — sample 에 keyword + searchCount + rank 가 있어야 함
    if (!sample || typeof sample !== 'object') return 0;
    const hasKw = ('keyword' in sample) || ('kwd' in sample) || ('keywordName' in sample);
    const hasSearch = ('searchCount' in sample) || ('totalQc' in sample) || ('totalQcCnt' in sample);
    if (!hasKw || !hasSearch) return 0;
    let added = 0;
    found.ref.forEach(row => {
      if (!row || typeof row !== 'object') return;
      const kwId = row.keywordId || row.id || (row.keyword + '|' + (row.categoryId || ''));
      if (kwId == null) return;
      window.__itemscoutKeywords__.set(String(kwId), row);
      added++;
    });
    return added;
  }

  // 응답 데이터 안에서 카테고리 id↔name + parent 정보 누적
  // URL 패턴 (예: /4/subcategories) → 응답의 모든 자식 id 의 parent = 4
  function accumulateCategoryInfo(data, url) {
    // URL 에서 parent_id 추출
    let parentFromUrl = null;
    const m = String(url || '').match(/\/(\d+)\/subcategories/);
    if (m) parentFromUrl = m[1];

    // 메인 배열(data.data 또는 data.items) — URL 기반 parent 적용
    const mainArr = data && (
      (Array.isArray(data.data) && data.data) ||
      (Array.isArray(data.items) && data.items) ||
      (Array.isArray(data.list) && data.list) ||
      (Array.isArray(data) && data)
    );
    if (mainArr) {
      mainArr.forEach(item => {
        if (!item || typeof item !== 'object') return;
        const id = item.id ?? item.category_id ?? item.categoryId;
        if (id == null) return;
        const name = item.name ?? item.categoryName;
        if (name) window.__itemscoutCategoryLookup__.set(String(id), String(name));
        // 부모 우선순위: 응답의 parent 필드 > URL 기반
        const parentField = item.parent_id ?? item.parentId ?? item.parent_category_id ?? item.parentCategoryId;
        const parent = parentField != null ? String(parentField) : (parentFromUrl || null);
        if (parent != null && parent !== String(id)) {
          // 이미 더 신뢰성 있는 parent 가 있으면 덮어쓰지 않음
          if (!window.__itemscoutCategoryParent__.has(String(id))) {
            window.__itemscoutCategoryParent__.set(String(id), parent);
          }
        }
      });
    }
    // 그 외 nested 데이터에서도 id↔name 보너스 추출 (없는 것만)
    function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== 'object') return;
      const id = node.id ?? node.category_id ?? node.categoryId;
      const name = node.name ?? node.categoryName;
      if (id != null && name && !window.__itemscoutCategoryLookup__.has(String(id))) {
        window.__itemscoutCategoryLookup__.set(String(id), String(name));
      }
      Object.values(node).forEach(v => {
        if (Array.isArray(v) || (v && typeof v === 'object')) walk(v);
      });
    }
    try { walk(data); } catch (_) {}
  }

  function saveCapture(url, data, source) {
    try {
      const found = findLargestObjectArray(data);
      const isKw = found.len >= 20;
      // 카테고리 정보 자동 누적 (subcategories / categories_map / 등 모든 응답)
      if (/subcategor|categor/i.test(url)) accumulateCategoryInfo(data, url);
      // ranking_up_down_keywords 는 카테고리 상승/하락 위젯이라 메인 표와 다름 → 누적 제외
      // 메인 표는 SSR 이라 XHR 로 안 오므로 DOM 스크래핑으로 처리
      let kwAdded = 0;
      const capture = {
        url, capturedAt: Date.now(), isKeywordList: isKw, source,
        size: JSON.stringify(data).length,
        arrayPath: found.path,
        arrayLen: found.len,
        sample: found.sample,
        kwAdded
      };
      window.__itemscoutCaptures__.push({ ...capture, data });
      // 최대 20개만 유지
      if (window.__itemscoutCaptures__.length > 20) window.__itemscoutCaptures__.shift();
      // content script로 전달 (누적된 전체 키워드 + 메타)
      window.postMessage({
        source: 'gpago-itemscout-inject',
        type: 'CAPTURED',
        url, isKeywordList: isKw, capturedAt: capture.capturedAt,
        kwAdded, totalKw: window.__itemscoutKeywords__.size,
        pageUrl: location.href
      }, window.location.origin);
      console.log(`[GPAGO itemscout ${source}] ${isKw?'✓ keyword('+found.len+'행)':'·'} +${kwAdded}kw (누적 ${window.__itemscoutKeywords__.size}) ${url.slice(0,80)}`);
    } catch(_) {}
  }

  // ───── DOM 스크래핑 — 화면의 메인 키워드 표를 직접 읽기 ─────
  function parseNumber(s) {
    if (s == null) return null;
    const t = String(s).replace(/[,\s]/g, '');
    if (!t || t === '-') return null;
    const n = Number(t);
    return isNaN(n) ? null : n;
  }
  function isLikelyKeywordRow(cells) {
    if (cells.length < 3) return false;
    // 첫 셀이 즐겨찾기 아이콘 (별), 두 번째가 순위(숫자), 세 번째가 키워드(텍스트 ≥2자)
    // 또는 첫 셀이 순위, 두 번째가 키워드
    const hasRank = cells.some(c => /^\d{1,4}$/.test(String(c).trim()));
    const hasKwLike = cells.some(c => {
      const t = String(c).trim();
      return t.length >= 2 && t.length <= 30 && /[가-힣a-zA-Z0-9]/.test(t) && !/^\d{1,4}$/.test(t);
    });
    const hasNumber = cells.some(c => /\d/.test(String(c)) && parseNumber(c) != null);
    return hasRank && hasKwLike && hasNumber;
  }
  // 키워드 텍스트 정제 — 허용 문자(한글/영문/숫자/일부 기호)만 통과시키는 화이트리스트 방식
  function cleanKeyword(s) {
    if (!s) return '';
    let t = String(s);
    // 허용: 한글, 영문, 숫자, 공백, 일부 기호 (._-+()% 등). 나머지(아이콘, 심볼 등)는 모두 제거
    t = t.replace(/[^\s가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9_\-\.\+\(\)&%]/g, '');
    // 끝의 단독 B 뱃지 제거 (itemscout 의 브랜드/판매처 뱃지)
    t = t.replace(/\s+B\s*$/g, '');
    t = t.replace(/(?<=[가-힣0-9a-z])B\s*$/i, '');
    // 공백 정리
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // 셀에서 표시 가능한 텍스트만 추출 (button, svg 등 내부 텍스트 제외)
  function extractCellText(td) {
    // 1) 셀 내부에 a 태그가 있으면 그 텍스트 우선 (보통 키워드 링크)
    const a = td.querySelector('a');
    if (a) {
      const aText = a.textContent.replace(/\s+/g, ' ').trim();
      if (aText.length >= 2 && /[가-힣A-Za-z0-9]/.test(aText)) return aText;
    }
    // 2) clone 해서 button, svg, [role="button"], [aria-hidden="true"] 같은 요소 제거
    const clone = td.cloneNode(true);
    clone.querySelectorAll('button, svg, [role="button"], [aria-hidden="true"], .badge, [class*="badge"]').forEach(el => el.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function scrapeMainKeywordTable() {
    const candidates = [];
    const tables = document.querySelectorAll('table, [role="table"], [role="grid"]');
    for (const t of tables) {
      const rows = t.querySelectorAll('tbody tr, [role="row"]');
      if (rows.length < 10) continue;
      const parsed = [];
      rows.forEach(r => {
        const tds = r.querySelectorAll('td, [role="cell"], [role="gridcell"]');
        if (tds.length < 3) return;
        const cells = Array.from(tds).map(extractCellText);
        if (isLikelyKeywordRow(cells)) parsed.push(cells);
      });
      if (parsed.length >= 10) candidates.push({ count: parsed.length, rows: parsed, source: 'table' });
    }
    candidates.sort((a, b) => b.count - a.count);
    if (!candidates.length) return [];
    const best = candidates[0];
    const out = [];
    best.rows.forEach(cells => {
      const filtered = cells.filter(c => c.length > 0 && c !== '★' && c !== '☆');
      let rank = null, keyword = '', category = '', searchCount = null;
      for (const c of filtered) {
        if (rank == null && /^\d{1,4}$/.test(c)) { rank = Number(c); continue; }
        if (!keyword) {
          const cleaned = cleanKeyword(c);
          if (cleaned.length >= 2 && /[가-힣a-zA-Z]/.test(cleaned) && !/^\d/.test(cleaned)) {
            keyword = cleaned;
            continue;
          }
        }
        // 대표 카테고리 — 슬래시 유무 무관하게 한글 텍스트면 인식 (예: 거실용커튼, 블루투스이어폰/이어셋)
        // 키워드 분류 컬럼(쇼핑성/정보성)은 제외
        if (!category && c.length < 30 && c !== keyword && c !== '쇼핑성' && c !== '정보성') {
          if (/[가-힣]/.test(c) || c.includes('/') || c === '-') { category = c; continue; }
        }
        if (searchCount == null) {
          const n = parseNumber(c);
          if (n != null && n > 0) searchCount = n;
        }
      }
      if (keyword) {
        out.push({ rank, keyword, category, searchCount });
      }
    });
    return out;
  }
  window.__gpago_scrapeItemscoutDom = scrapeMainKeywordTable;

  // ──── 카테고리 경로 도출 ────
  // 1) lookup + parent 체인으로 path 구성 (있으면)
  // 2) DOM에서 breadcrumb 시도
  // 3) document.title 시도
  // 4) fallback: leaf 이름만
  function buildCategoryPathFromTree(catId) {
    if (catId == null) return null;
    const lookup = window.__itemscoutCategoryLookup__;
    const parents = window.__itemscoutCategoryParent__;
    const path = [];
    let cur = String(catId);
    let safety = 10;
    const seen = new Set();
    while (cur && safety-- > 0 && !seen.has(cur)) {
      seen.add(cur);
      const name = lookup.get(cur);
      if (!name) break;
      path.unshift(name);
      const p = parents.get(cur);
      if (!p || p === '0' || p === 'null') break;
      cur = p;
    }
    return path.length ? path.join(' > ') : null;
  }
  function scrapeBreadcrumbFromDom() {
    if (!document.body) return null;
    // 1. breadcrumb 요소
    const sels = [
      '[class*="breadcrumb"]', '[class*="bread-crumb"]', '[class*="breadCrumb"]',
      'nav ol', '[aria-label*="breadcrumb"]', '[role="navigation"] ol'
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = el.textContent.replace(/\s+/g, ' ').trim().replace(/›/g, '>');
      if ((t.match(/>/g) || []).length >= 2 && t.length < 200 && /[가-힣]/.test(t)) {
        return t.replace(/\s*>\s*/g, ' > ');
      }
    }
    // 2. 페이지 내 모든 텍스트 노드 중 "X > Y > Z" 패턴 (3단계 이상)
    const candidates = [];
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const raw = (n.nodeValue || '').replace(/\s+/g, ' ').trim().replace(/›/g, '>');
        if (raw.length < 5 || raw.length > 200) continue;
        // ">" 2개 이상 + 한글 포함 + 카테고리스러운 패턴
        if ((raw.match(/>/g) || []).length >= 2 && /[가-힣]/.test(raw)) {
          // 어색한 패턴 제외 (HTML 태그 같은 것)
          if (/<\w+/.test(raw)) continue;
          candidates.push(raw.replace(/\s*>\s*/g, ' > '));
        }
      }
    } catch (_) {}
    if (candidates.length) {
      // 한글 단어 수가 많은 것 선호 (카테고리 트리스러운 것)
      candidates.sort((a, b) => {
        const ka = (a.match(/[가-힣]+/g) || []).length;
        const kb = (b.match(/[가-힣]+/g) || []).length;
        if (kb !== ka) return kb - ka;
        return a.length - b.length;
      });
      return candidates[0];
    }
    return null;
  }
  function getCategoryName(catId) {
    if (catId == null) return null;
    return window.__itemscoutCategoryLookup__.get(String(catId)) || null;
  }

  // 페이지에서 DOM 스크래핑 결과(우선) + XHR 캡처 fallback
  window.__gpago_getItemscoutSnapshot = function() {
    let rows = [];
    let source = 'dom';
    try { rows = scrapeMainKeywordTable(); } catch (_) {}
    if (!rows.length) {
      rows = Array.from(window.__itemscoutKeywords__.values());
      source = 'xhr';
    }
    const categoryId = (location.pathname.match(/category\/(\d+)/) || [])[1] || null;
    // 카테고리 경로 우선순위: tree / breadcrumb 중 segment 더 많은 쪽 (lookup 이 일부 노드 누락 시 truncation 방지)
    const treePath = buildCategoryPathFromTree(categoryId);
    const domPath = scrapeBreadcrumbFromDom();
    const treeLen = treePath ? treePath.split(' > ').length : 0;
    const domLen  = domPath  ? domPath.split(' > ').length  : 0;
    let categoryPath = null;
    let pathSource = '';
    if (domLen > treeLen && domPath) {
      categoryPath = domPath;
      pathSource = 'dom';
    } else if (treePath) {
      categoryPath = treePath;
      pathSource = 'tree';
    } else if (domPath) {
      categoryPath = domPath;
      pathSource = 'dom';
    }
    if (!categoryPath) {
      categoryPath = getCategoryName(categoryId);
      pathSource = categoryPath ? 'leaf' : pathSource;
    }
    return {
      pageUrl: location.href,
      categoryId,
      categoryPath,
      pathSource,
      capturedAt: Date.now(),
      source,
      rows
    };
  };

  // content script 에서 스냅샷 요청 시 응답
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'gpago-itemscout-content-req') return;
    if (e.data.type !== 'GET_SNAPSHOT') return;
    try {
      const snapshot = window.__gpago_getItemscoutSnapshot();
      window.postMessage({
        source: 'gpago-itemscout-snapshot-resp',
        reqId: e.data.reqId,
        snapshot
      }, location.origin);
    } catch (err) {
      console.warn('[GPAGO itemscout] snapshot 응답 실패:', err);
    }
  });

  // fetch 가로채기
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const p = origFetch.apply(this, args);
    const reqUrl = (args[0] && args[0].url) || args[0];
    p.then(res => {
      try {
        const cloned = res.clone();
        const ct = cloned.headers.get('content-type') || '';
        if (!ct.includes('json')) return;
        cloned.json().then(data => saveCapture(String(reqUrl), data, 'fetch')).catch(()=>{});
      } catch(_) {}
    }).catch(()=>{});
    return p;
  };

  // XHR 가로채기
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    const origOpen = xhr.open;
    xhr.open = function(method, url) {
      _url = url;
      return origOpen.apply(this, arguments);
    };
    xhr.addEventListener('load', function() {
      try {
        const ct = xhr.getResponseHeader && xhr.getResponseHeader('content-type');
        if (ct && !ct.includes('json')) return;
        const text = xhr.responseText;
        if (!text || text.length < 20) return;
        if (text[0] !== '{' && text[0] !== '[') return;
        const data = JSON.parse(text);
        saveCapture(String(_url), data, 'xhr');
      } catch(_) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // 페이지 우측 상단 진단 박스 — 클릭하면 펼쳐서 캡처 응답들의 URL·행수·필드명 표시
  let _diagExpanded = false;
  function updateDiagBox() {
    let el = document.getElementById('gpago-itemscout-diag');
    if (!el) {
      if (!document.body) return;
      el = document.createElement('div');
      el.id = 'gpago-itemscout-diag';
      el.style.cssText = 'position:fixed;top:90px;right:10px;z-index:2147483647;background:#fff;color:#222;padding:10px 14px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:11px;font-weight:bold;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;max-width:560px;max-height:78vh;overflow:auto;border:2px solid #2196F3;';
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('.gpago-action')) return;
        _diagExpanded = !_diagExpanded;
        renderDiag();
      });
      document.body.appendChild(el);
    }
    renderDiag();
  }
  function renderDiag() {
    const el = document.getElementById('gpago-itemscout-diag');
    if (!el) return;
    const captures = window.__itemscoutCaptures__;
    const total = captures.length;
    const kw = captures.filter(c => c.isKeywordList).length;
    // DOM 스크래핑 시도 (실시간)
    let domRows = [];
    try { domRows = scrapeMainKeywordTable(); } catch(_) {}
    const domCount = domRows.length;
    const domPreview = domCount
      ? `<div style="font-size:10px;font-weight:normal;color:#444;margin-top:4px;border-top:1px solid #eee;padding-top:4px;">
          <b style="color:#2196F3;">DOM 표 ${domCount}개</b> (실제 가져올 데이터)<br>
          1번: <b>${domRows[0]?.keyword || '-'}</b> (${domRows[0]?.searchCount ?? '?'})<br>
          2번: <b>${domRows[1]?.keyword || '-'}</b><br>
          끝: <b>${domRows[domRows.length-1]?.keyword || '-'}</b>
        </div>` : '<div style="color:#FF6B6B;font-size:10px;font-weight:normal;margin-top:4px;">⚠ DOM 표 못 찾음 — 페이지 로드 후 잠시 기다리세요</div>';
    // 카테고리 경로 미리보기
    let catPath = null, pathSource = '';
    try {
      const snap = window.__gpago_getItemscoutSnapshot();
      catPath = snap.categoryPath;
      pathSource = snap.pathSource;
    } catch(_) {}
    const catInfo = catPath
      ? `<div style="font-size:10px;font-weight:normal;color:#444;margin-top:4px;border-top:1px solid #eee;padding-top:4px;">
          폴더명: <b style="color:#0AA060">${catPath}</b><br><span style="color:#bbb;font-size:9px;">(${pathSource} 소스)</span>
        </div>`
      : '<div style="color:#FF6B6B;font-size:10px;font-weight:normal;margin-top:4px;border-top:1px solid #eee;padding-top:4px;">⚠ 카테고리명 도출 실패 — itemscout/{id} 로 폴더 생성</div>';
    const header = `<div style="color:#0AA060;font-size:13px;">🟢 DOM 키워드 <span style="font-size:16px;color:#2196F3;">${domCount}</span>개 · XHR ${captures.length}회</div>
      ${domPreview}
      ${catInfo}
      <div style="font-size:9px;font-weight:normal;color:#888;margin-top:4px;">박스 클릭 → ${_diagExpanded?'접기':'펼치기 (캡처 응답 상세)'}</div>`;
    if (!_diagExpanded) { el.innerHTML = header; return; }
    // 펼친 상태 — 각 응답을 표 형태로
    const rows = captures.slice().reverse().map((c, i) => {
      const idx = captures.length - i;
      const urlShort = c.url.split('?')[0].split('/').slice(-2).join('/').slice(0, 60);
      const keys = c.sample ? Object.keys(c.sample).slice(0, 10).join(', ') : '-';
      const bg = c.isKeywordList ? 'background:#FFF8E1;' : '';
      return `<tr style="${bg}">
        <td style="padding:3px 5px;border-bottom:1px solid #eee;color:#666;font-weight:normal;">#${idx}</td>
        <td style="padding:3px 5px;border-bottom:1px solid #eee;color:#1976D2;font-weight:normal;">${urlShort}</td>
        <td style="padding:3px 5px;border-bottom:1px solid #eee;text-align:right;color:${c.isKeywordList?'#E91E63':'#999'};">${c.arrayLen}행</td>
        <td style="padding:3px 5px;border-bottom:1px solid #eee;font-family:monospace;font-weight:normal;color:#444;">${c.arrayPath || '(root)'}</td>
        <td style="padding:3px 5px;border-bottom:1px solid #eee;font-family:monospace;font-weight:normal;color:#0AA060;font-size:10px;">${keys}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `${header}
      <div style="margin-top:8px;font-weight:normal;font-size:10px;color:#555;">
        <b>노란색 행</b>이 키워드 후보 (20개 이상 데이터). 그중 어떤 URL이 itemscout 화면의 키워드 표인지 알려주세요.
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:6px;">
        <thead><tr style="background:#f5f5f5;">
          <th style="padding:4px;text-align:left;">#</th>
          <th style="padding:4px;text-align:left;">URL</th>
          <th style="padding:4px;text-align:right;">행수</th>
          <th style="padding:4px;text-align:left;">위치</th>
          <th style="padding:4px;text-align:left;">샘플 필드명</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button class="gpago-action" style="margin-top:8px;background:#2196F3;color:white;border:none;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:bold;cursor:pointer;" onclick="event.stopPropagation();console.log('[GPAGO] 모든 캡처:', window.__itemscoutCaptures__)">F12 콘솔에 전체 데이터 출력</button>`;
  }
  setInterval(updateDiagBox, 1500);
})();
