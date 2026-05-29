// 스마트스토어/브랜드스토어 페이지의 MAIN world(=page world)에서 실행
// content-smartstore.js (isolated world)는 window.__PRELOADED_STATE__ 같은 페이지 전역 변수에
// 접근할 수 없으므로, 이 inject script 가 page world 에서 데이터를 읽어 content 로 postMessage 함.
// (페이지를 조작하지 않음. 오직 읽기만)
//
// v1.6.6+ 변경: window.fetch / XMLHttpRequest 를 후킹하여 페이지가 호출하는 API 응답에서
// zzimCount / regDate / searchTags 를 자동 발견. Naver 가 어느 endpoint 를 쓰든 자동 캐치.

(function() {
  if (window.__gpago_smartstore_inject_done__) return;
  window.__gpago_smartstore_inject_done__ = true;

  // 페이지가 만든 API 응답에서 캡처한 상품 데이터
  window.__gpagoCapturedProduct = {
    reviewCount: null, rating: null, wishCount: null,
    registDate: null, tags: [], category: null, _apiUrls: [],
  };
  // ───────────────────────── 네트워크 모니터 (fetch + XHR) ─────────────────────────
  // 페이지가 호출하는 모든 JSON API 응답을 검사해서 상품 정보 키를 발견하면 캡처
  function scanResponseForProductFields(url, jsonText) {
    if (typeof jsonText !== 'string' || jsonText.length < 10) return;
    let obj;
    try { obj = JSON.parse(jsonText); } catch (_) { return; }
    if (!obj || typeof obj !== 'object') return;
    // 깊이탐색으로 상품 객체 찾기
    const seen = new Set();
    function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 8 || seen.has(o)) return;
      seen.add(o);
      const cap = window.__gpagoCapturedProduct;
      // 찜 — 다양한 키 이름 시도
      if (cap.wishCount == null) {
        const v = o.zzimCount ?? o.wishListCount ?? o.wishCount ?? o.likeCount ?? o.interestCount ?? o.favoriteCount;
        if (v != null && typeof v !== 'object' && !isNaN(Number(v))) cap.wishCount = Number(v);
      }
      // 등록일 — 다양한 키 이름 시도
      if (!cap.registDate) {
        const d2 = o.regDate || o.registDate || o.registrationDate || o.regDateStr || o.registeredAt || o.createDate || o.publishDate || o.firstRegistDate;
        if (d2 && typeof d2 === 'string' && /^\d{4}/.test(d2)) cap.registDate = d2.slice(0, 10).replace(/[.\/]/g, '-');
        else if (typeof d2 === 'number' && d2 > 1000000000000) {
          // Unix timestamp (ms)
          try { cap.registDate = new Date(d2).toISOString().slice(0, 10); } catch (_) {}
        }
      }
      // 태그 — 다양한 키 이름 시도
      if (!cap.tags || !cap.tags.length) {
        const arr = o.searchTags || o.productTags || o.userSearchTags || o.tagList || o.keywords
          || o.productKeywords || o.attributeKeywords || (Array.isArray(o.tags) ? o.tags : null);
        if (Array.isArray(arr) && arr.length) {
          const tags = arr.map(t => (typeof t === 'string' ? t : (t && (t.text || t.tagName || t.name || t.keyword)) || '')).filter(Boolean);
          if (tags.length) cap.tags = tags.slice(0, 12);
        }
      }
      // 리뷰 수 (보조)
      if (cap.reviewCount == null) {
        if (o.reviewCount != null && typeof o.reviewCount !== 'object') cap.reviewCount = Number(o.reviewCount);
        else if (o.totalReviewCount != null && typeof o.totalReviewCount !== 'object') cap.reviewCount = Number(o.totalReviewCount);
      }
      // 평점
      if (cap.rating == null) {
        if (o.averageReviewScore != null && typeof o.averageReviewScore !== 'object') cap.rating = Number(o.averageReviewScore);
        else if (o.reviewAverageScore != null && typeof o.reviewAverageScore !== 'object') cap.rating = Number(o.reviewAverageScore);
      }
      // 카테고리
      if (!cap.category) {
        const c = o.fullCategoryName || o.categoryFullName || o.wholeCategoryName;
        if (typeof c === 'string') cap.category = c;
      }
      // 재귀
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length && i < 200; i++) walk(o[i], d + 1);
      } else {
        for (const k in o) {
          if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
          const v = o[k];
          if (v && typeof v === 'object') walk(v, d + 1);
        }
      }
    }
    walk(obj, 0);
    // 발견 시 url 기록
    const cap = window.__gpagoCapturedProduct;
    if (cap.wishCount != null || cap.registDate || (cap.tags && cap.tags.length)) {
      if (cap._apiUrls.indexOf(url) < 0) cap._apiUrls.push(url);
    }
  }

  // fetch 후킹
  try {
    const origFetch = window.fetch;
    if (origFetch && !window.__gpago_fetch_hooked__) {
      window.__gpago_fetch_hooked__ = true;
      window.fetch = function() {
        const args = arguments;
        return origFetch.apply(this, args).then(function(res) {
          try {
            const url = (args[0] && (args[0].url || args[0])) || '';
            const urlStr = typeof url === 'string' ? url : String(url);
            // JSON 응답만 검사 (이미지/HTML 무시)
            const ct = String(res.headers.get && res.headers.get('content-type') || '').toLowerCase();
            if (ct.indexOf('json') !== -1 && (urlStr.indexOf('/i/') !== -1 || urlStr.indexOf('/api/') !== -1 || urlStr.indexOf('/products') !== -1 || urlStr.indexOf('smartstore') !== -1 || urlStr.indexOf('brand.naver') !== -1)) {
              res.clone().text().then(function(t) { scanResponseForProductFields(urlStr, t); }).catch(function(){});
            }
          } catch (_) {}
          return res;
        });
      };
    }
  } catch (_) {}

  // XMLHttpRequest 후킹
  try {
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR && OrigXHR.prototype && !OrigXHR.prototype.__gpagoHooked) {
      OrigXHR.prototype.__gpagoHooked = true;
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function(method, url) {
        this.__gpagoUrl = url;
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function() {
        const xhr = this;
        try {
          xhr.addEventListener('load', function() {
            try {
              const url = xhr.__gpagoUrl || '';
              if (xhr.status >= 200 && xhr.status < 300 && (url.indexOf('/i/') !== -1 || url.indexOf('/api/') !== -1 || url.indexOf('/products') !== -1)) {
                const ct = String(xhr.getResponseHeader('content-type') || '').toLowerCase();
                if (ct.indexOf('json') !== -1) {
                  scanResponseForProductFields(url, xhr.responseText || '');
                }
              }
            } catch (_) {}
          });
        } catch (_) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (_) {}

  // React/Next.js 등에서 전역으로 노출하는 state 객체들을 모두 시도
  function snapshotState() {
    const candidates = {};
    try { if (window.__PRELOADED_STATE__)     candidates.preloaded = window.__PRELOADED_STATE__; } catch(_) {}
    try { if (window.__INITIAL_STATE__)       candidates.initial   = window.__INITIAL_STATE__; } catch(_) {}
    try { if (window.__NEXT_DATA__)           candidates.next      = window.__NEXT_DATA__; } catch(_) {}
    try { if (window.__APP_INITIAL_STATE__)   candidates.appInit   = window.__APP_INITIAL_STATE__; } catch(_) {}
    return candidates;
  }

  // 객체 트리 깊이 탐색 — product 객체 찾기 (이름 + 리뷰/평점/찜 등이 함께 있는 객체)
  function findProductDeep(obj, depth, seen) {
    if (!obj || typeof obj !== 'object') return null;
    if (depth > 8) return null;
    if (seen.has(obj)) return null;
    seen.add(obj);
    const looksLikeProduct = (
      (obj.name || obj.productName) &&
      (obj.reviewCount != null || obj.totalReviewCount != null ||
       obj.averageReviewScore != null || obj.reviewAverageScore != null ||
       obj.rating != null ||
       obj.wishListCount != null || obj.zzimCount != null ||
       obj.regDate || obj.registDate)
    );
    if (looksLikeProduct) return obj;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length && i < 200; i++) {
        const r = findProductDeep(obj[i], depth + 1, seen);
        if (r) return r;
      }
      return null;
    }
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = obj[k];
      if (v && typeof v === 'object') {
        const r = findProductDeep(v, depth + 1, seen);
        if (r) return r;
      }
    }
    return null;
  }

  function extractFromPageState() {
    const states = snapshotState();
    const result = {
      title: null, image: null, description: null,
      reviewCount: null, rating: null, wishCount: null,
      registDate: null, tags: [], category: null, price: null,
      _stateKeys: Object.keys(states),
    };
    for (const sKey of Object.keys(states)) {
      const product = findProductDeep(states[sKey], 0, new Set());
      if (!product) continue;
      result._foundIn = sKey;
      result.title       = result.title || product.name || product.productName || null;
      result.image       = result.image || product.representativeImage || product.representImage || product.image || product.thumbnailImage || null;
      result.reviewCount = result.reviewCount ?? product.reviewCount ?? product.totalReviewCount ?? null;
      result.rating      = result.rating ?? product.averageReviewScore ?? product.reviewAverageScore ?? product.rating ?? null;
      result.wishCount   = result.wishCount ?? product.wishListCount ?? product.zzimCount ?? product.likeCount ?? product.interestCount ?? null;
      result.registDate  = result.registDate || product.regDate || product.registDate || product.regDateStr || product.registrationDate || null;
      result.price       = result.price ?? product.salePrice ?? product.dispSalePrice ?? product.price ?? null;
      const tagList = product.tags || product.searchTags || product.productTags || product.userSearchTags || product.tagList || [];
      if (Array.isArray(tagList) && tagList.length && !result.tags.length) {
        result.tags = tagList.map(t => (typeof t === 'string' ? t : (t && (t.text || t.tagName || t.name)) || '')).filter(Boolean);
      }
      const cats = product.fullCategoryName || product.categoryFullName || product.wholeCategoryName || product.category;
      if (cats && !result.category) {
        result.category = typeof cats === 'string' ? cats : (Array.isArray(cats) ? cats.join(' > ') : null);
      }
      break;
    }
    // 캡처된 네트워크 데이터를 머지 (state 에 없으면 네트워크 캡처값 사용)
    const cap = window.__gpagoCapturedProduct;
    if (cap) {
      if (result.wishCount == null && cap.wishCount != null) result.wishCount = cap.wishCount;
      if (!result.registDate && cap.registDate) result.registDate = cap.registDate;
      if ((!result.tags || !result.tags.length) && cap.tags && cap.tags.length) result.tags = cap.tags;
      if (result.reviewCount == null && cap.reviewCount != null) result.reviewCount = cap.reviewCount;
      if (result.rating == null && cap.rating != null) result.rating = cap.rating;
      if (!result.category && cap.category) result.category = cap.category;
    }
    return result;
  }

  // content-smartstore.js 의 요청에 응답
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'gpago-smartstore-content-req') return;
    if (e.data.type !== 'GET_PAGE_STATE') return;
    try {
      const data = extractFromPageState();
      window.postMessage({
        source: 'gpago-smartstore-inject-resp',
        reqId: e.data.reqId,
        data,
      }, location.origin);
    } catch (err) {
      window.postMessage({
        source: 'gpago-smartstore-inject-resp',
        reqId: e.data.reqId,
        data: null,
        error: String(err && err.message || err),
      }, location.origin);
    }
  });

  // 초기 한 번 ping — content script 가 inject 로드 확인용
  window.postMessage({ source: 'gpago-smartstore-inject-ready' }, location.origin);
})();
