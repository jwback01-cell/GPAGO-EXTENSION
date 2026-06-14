// 네이버 스마트스토어/브랜드스토어 상품 페이지에서 실행
// 페이지가 평소대로 로드되면 DOM/JSON에서 상품 정보를 추출해 background 로 전송
// (fetch 방식과 달리 진짜 페이지 방문이라 네이버 봇 차단 회피)

(function() {
  if (window.__gpago_smartstore_content_loaded__) return;
  window.__gpago_smartstore_content_loaded__ = true;

  // v1.6.6+ : inject-smartstore.js 는 manifest 의 world: MAIN content script 로 직접 주입됨
  // (예전 동적 주입 방식보다 빠르고 페이지 fetch 후킹을 더 안정적으로 설치)

  // inject 로부터 page state 가져오기
  function fetchPageStateData() {
    return new Promise((resolve) => {
      const reqId = 'gp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      let done = false;
      const handler = (e) => {
        if (e.source !== window) return;
        if (!e.data || e.data.source !== 'gpago-smartstore-inject-resp') return;
        if (e.data.reqId !== reqId) return;
        if (done) return;
        done = true;
        window.removeEventListener('message', handler);
        resolve(e.data.data || null);
      };
      window.addEventListener('message', handler);
      try {
        window.postMessage({ source: 'gpago-smartstore-content-req', type: 'GET_PAGE_STATE', reqId }, location.origin);
      } catch (_) {}
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener('message', handler);
        resolve(null);
      }, 600);
    });
  }

  function extractData() {
    const result = {
      title: null, image: null, description: null,
      reviewCount: null, rating: null, wishCount: null,
      registDate: null, tags: [], category: null, price: null,
      deliveryFee: null, // 택배비 (0=무료, 숫자=유료, null=미확인)
      options: null, // 옵션 값 목록 (변경 추적용)
    };

    // 1) OG / 메타 태그
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) result.title = ogTitle.content;
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) result.image = ogImage.content;
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) result.description = ogDesc.content;
    // 가격 메타 (가장 신뢰도 높음) — product:price:amount / og:price:amount
    const ogPrice = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"], meta[name="price"]');
    if (ogPrice && ogPrice.content) { const v = Number(String(ogPrice.content).replace(/[^\d.]/g, '')); if (v > 0) result.price = result.price == null ? v : result.price; }

    // 2) JSON-LD
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of ldScripts) {
      try {
        const obj = JSON.parse(s.textContent || '');
        const items = Array.isArray(obj) ? obj : [obj];
        for (const o of items) {
          const t = o['@type'];
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
            result.title = result.title || o.name || null;
            if (o.image) {
              const img = Array.isArray(o.image) ? o.image[0] : o.image;
              result.image = result.image || img;
            }
            result.description = result.description || o.description || null;
            if (o.aggregateRating) {
              const ar = o.aggregateRating;
              if (ar.ratingValue != null) result.rating = result.rating ?? Number(ar.ratingValue);
              // ratingCount(별점만 매긴 사람 수) 는 실제 리뷰 수와 다를 수 있어서 fallback 제거
              // reviewCount 가 있을 때만 사용
              if (ar.reviewCount != null) result.reviewCount = result.reviewCount ?? Number(ar.reviewCount);
            }
            if (o.offers) {
              const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
              if (offer && offer.price != null) result.price = result.price ?? Number(offer.price);
            }
            if (o.category && !result.category) {
              result.category = Array.isArray(o.category) ? o.category.join(' > ') : o.category;
            }
          }
          if (t === 'BreadcrumbList' || (Array.isArray(t) && t.includes('BreadcrumbList'))) {
            if (Array.isArray(o.itemListElement)) {
              const cats = o.itemListElement.map(el => el.name || (el.item && el.item.name) || '').filter(Boolean);
              if (cats.length && !result.category) result.category = cats.join(' > ');
            }
          }
        }
      } catch(_) {}
    }

    // 3) __PRELOADED_STATE__ / __NEXT_DATA__
    const scripts = Array.from(document.querySelectorAll('script'));
    let state = null;
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text) continue;
      if (text.includes('__PRELOADED_STATE__')) {
        const m = text.match(/__PRELOADED_STATE__\s*=\s*({[\s\S]+?})\s*;\s*(?:window|$|<\/script)/);
        if (m) { try { state = JSON.parse(m[1]); break; } catch(_) {} }
      } else if (text.includes('__INITIAL_STATE__')) {
        const m = text.match(/__INITIAL_STATE__\s*=\s*({[\s\S]+?})\s*;\s*(?:window|$|<\/script)/);
        if (m) { try { state = JSON.parse(m[1]); break; } catch(_) {} }
      }
    }
    // __NEXT_DATA__
    if (!state) {
      const nextDataEl = document.querySelector('script#__NEXT_DATA__');
      if (nextDataEl) {
        try { state = JSON.parse(nextDataEl.textContent); } catch(_) {}
      }
    }

    // state 깊이 탐색
    function findProductIn(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 6) return null;
      const looksLikeProduct = (
        (obj.name || obj.productName) &&
        (obj.reviewCount != null || obj.totalReviewCount != null ||
         obj.averageReviewScore != null || obj.reviewAverageScore != null ||
         obj.wishListCount != null || obj.zzimCount != null ||
         obj.regDate || obj.registDate)
      );
      if (looksLikeProduct) return obj;
      for (const k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        const v = obj[k];
        if (v && typeof v === 'object') {
          const found = findProductIn(v, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    if (state) {
      const product = findProductIn(state, 0);
      if (product) {
        result.title       = result.title || product.name || product.productName || null;
        result.image       = result.image || product.representativeImage || product.representImage || product.image || product.thumbnailImage || null;
        result.reviewCount = result.reviewCount ?? product.reviewCount ?? product.totalReviewCount ?? null;
        result.rating      = result.rating ?? product.averageReviewScore ?? product.reviewAverageScore ?? null;
        result.wishCount   = result.wishCount ?? product.wishListCount ?? product.zzimCount ?? product.likeCount ?? null;
        result.registDate  = result.registDate || product.regDate || product.registDate || product.regDateStr || null;
        result.price       = result.price ?? product.salePrice ?? product.dispSalePrice ?? product.price ?? null;
        const tagList = product.tags || product.searchTags || product.productTags || product.userSearchTags || [];
        if (Array.isArray(tagList) && tagList.length) {
          result.tags = tagList.map(t => (typeof t === 'string' ? t : (t && (t.text || t.tagName || t.name)) || '')).filter(Boolean);
        }
        const cats = product.fullCategoryName || product.categoryFullName || product.wholeCategoryName;
        if (cats && !result.category) result.category = cats;
        // 택배비 — 기본 배송비(숫자)를 우선. (CONDITIONAL_FREE=일정금액 이상 무료 → 실제로는 기본배송비 있음)
        if (result.deliveryFee == null) {
          const di = product.productDeliveryInfo || product.deliveryInfo || product.delivery || {};
          const cand = product.deliveryFee != null ? product.deliveryFee
            : (di.baseFee != null ? di.baseFee
            : (di.deliveryFee != null ? di.deliveryFee
            : (di.baseDeliveryFee != null ? di.baseDeliveryFee : null)));
          const ft = String(di.deliveryFeeType || di.feeType || product.deliveryFeeType || '');
          if (cand != null && !isNaN(Number(cand))) result.deliveryFee = Number(cand); // 숫자 우선 (3000 등)
          else if (/^FREE$/i.test(ft) || ft === '무료') result.deliveryFee = 0; // 순수 무료만 0 (CONDITIONAL_FREE 제외)
        }
        // 옵션 값 목록 (컬러/사이즈/추가옵션 등) — 변경 추적용
        if (result.options == null) {
          try {
            const po = product.productOptions || product.optionInfo || {};
            const combos = product.optionCombinations || product.optionCombinationList
              || po.optionCombinations || po.combinations || po.optionCombinationList || [];
            const set = [];
            if (Array.isArray(combos)) {
              for (const c of combos) {
                if (!c || typeof c !== 'object') continue;
                const parts = [c.optionName1, c.optionName2, c.optionName3, c.optionName4, c.name, c.value, c.text]
                  .filter(v => typeof v === 'string' && v.trim());
                if (parts.length) set.push(parts.join(' / ').trim());
              }
            }
            const stds = product.optionStandards || po.optionStandards || product.standardOptions || [];
            if (Array.isArray(stds)) for (const s of stds) { if (s && typeof s === 'object') { const n = s.optionName || s.name || s.value; if (typeof n === 'string' && n.trim()) set.push(n.trim()); } }
            if (set.length) result.options = Array.from(new Set(set)).slice(0, 300);
          } catch (_) {}
        }
      }
    }

    return result;
  }

  // v1.6.9+ 종료 조건:
  //   - 찜수(wishCount) 는 Naver 가 구매자에게 비공개 (셀러 대시보드 전용) → 추출 포기
  //   - 태그는 "상세정보 펼쳐보기" 클릭 후 추출 가능
  //   - reviewCount/rating/registDate 는 페이지 초기 렌더에서 잡힘
  function isFullyMeaningful(r) {
    let cnt = 0;
    if (r.reviewCount != null) cnt++;
    if (r.rating != null) cnt++;
    if (r.registDate) cnt++;
    if (Array.isArray(r.tags) && r.tags.length) cnt++;
    if (cnt < 2) return false;
    // 태그가 있으면 펼쳐보기 처리도 완료 → 즉시 종료
    if (Array.isArray(r.tags) && r.tags.length) return true;
    // 태그 없어도 4회(=8초) 기다린 후 cnt 충분하면 종료
    return attempts >= 4 && cnt >= 3;
  }
  // 최소한이라도 있으면 timeout 시 전송할 만함
  function hasAnyData(r) {
    return !!(
      r.title || r.image ||
      r.reviewCount != null || r.rating != null || r.wishCount != null ||
      r.registDate || (Array.isArray(r.tags) && r.tags.length)
    );
  }

  // DOM 에서 리뷰/평점/찜 등 정확한 값 추출
  // 페이지 내 여러 곳에 숫자가 있을 수 있어 우선순위 기반으로 신뢰성 ↑
  function getReviewCountFromDom() {
    // 1) 리뷰 탭/링크의 텍스트 (예: "리뷰 2", "리뷰(2)", "상품후기 2")
    const candidates = [];
    const els = document.querySelectorAll('a, button, span, em, strong');
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 30) continue;
      // "리뷰 N" 또는 "리뷰(N)" 또는 "상품후기 N" 또는 "총 리뷰 N"
      const m = t.match(/^(?:리뷰|상품후기|구매후기|후기|총\s*리뷰)\s*\(?\s*(\d{1,6}(?:,\d{3})*)\s*\)?\s*개?\s*$/) ||
                t.match(/^(?:리뷰|상품후기)\s+(\d{1,6}(?:,\d{3})*)/);
      if (m) {
        const n = Number(m[1].replace(/,/g, ''));
        if (n >= 0 && n < 1000000) candidates.push(n);
      }
    }
    if (candidates.length) {
      // 가장 작은 값 (ratingCount/interaction 같은 큰 수 제외, 실제 리뷰 수 우선)
      return Math.min(...candidates);
    }
    return null;
  }

  function fillFromDom(r) {
    try {
      // v1.7.12+ : 평점이 0 이면 리뷰가 없는 상품 → reviewCount = 0 추론
      //   (JSON-LD aggregateRating.ratingValue=0 인데 reviewCount는 누락된 경우 대응)
      if (r.reviewCount == null && r.rating === 0) {
        r.reviewCount = 0;
      }
      // v1.7.11+ 리뷰 수 — JSON-LD/PRELOADED 가 권위있는 소스. 없을 때만 DOM 사용
      //   (이전엔 DOM 우선이었는데 "함께 보는 상품" 의 리뷰 수가 잡혀 부정확한 케이스 발견)
      if (r.reviewCount == null) {
        const domReview = getReviewCountFromDom();
        if (domReview != null) r.reviewCount = domReview;
      }
      const text = document.body ? document.body.innerText : '';
      if (!text) return;
      // 본문 텍스트 폴백 — 여전히 null 일 때만 실행 (함께보는상품 영향 가능 → 마지막 수단)
      if (r.reviewCount == null) {
        const m = text.match(/리뷰\s*\(?\s*(\d+(?:,\d+)*)/);
        if (m) r.reviewCount = Number(m[1].replace(/,/g, ''));
      }
      if (r.rating == null) {
        const m = text.match(/평균\s*(\d+(?:\.\d+)?)\s*점/) ||
                  text.match(/별점\s*(\d+(?:\.\d+)?)/) ||
                  text.match(/(\d\.\d{1,2})\s*점/);
        if (m) {
          const v = Number(m[1]);
          if (v >= 0 && v <= 5) r.rating = v;
        }
      }
      if (r.wishCount == null) {
        // 다양한 패턴 시도 (네이버 페이지 표기 변형 대응)
        const m = text.match(/찜\s*[(:：]?\s*(\d+(?:,\d+)*)/) ||
                  text.match(/관심상품[\s\S]{0,20}?(\d+(?:,\d+)*)/) ||
                  text.match(/북마크\s*[(:：]?\s*(\d+(?:,\d+)*)/) ||
                  text.match(/찜하기\s+(\d+(?:,\d+)*)/);
        if (m) r.wishCount = Number(m[1].replace(/,/g, ''));
      }
      if (r.registDate == null) {
        // 다양한 등록일 패턴 (한/영 모두)
        const m = text.match(/등록일\s*[:：]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/) ||
                  text.match(/상품등록일\s*[:：]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/) ||
                  text.match(/등록\s*[:：]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/) ||
                  text.match(/(\d{4}\.\d{2}\.\d{2})\s*등록/);
        if (m) r.registDate = m[1].replace(/[.\/]/g, '-');
      }
      // 택배비 (state 에서 못 잡았을 때 DOM 텍스트로) — '배송비 N원'(기본배송비) 우선,
      //   조건부 '50,000원 이상 무료배송' 문구를 무료로 오인하지 않도록 숫자를 먼저 매칭
      if (r.deliveryFee == null && text) {
        const m = text.match(/배송비\s*[:：]?\s*([\d,]+)\s*원/);
        if (m) r.deliveryFee = Number(m[1].replace(/,/g, ''));
        else if (/배송비\s*무료|무료\s*배송/.test(text)) r.deliveryFee = 0;
      }
      // v1.7.13+ 최종 검증 : 평점이 0 이면 리뷰가 없는 상품 → 잘못 잡힌 리뷰 수 교정 (override)
      //   (Naver 는 0점 리뷰를 허용 안 함 → rating=0 이면 리뷰 수는 반드시 0)
      if (r.rating === 0) {
        if (r.reviewCount !== 0) {
          console.log('[GPAGO smartstore] 평점 0 → 리뷰 수 0 으로 교정 (이전 값:', r.reviewCount, ')');
        }
        r.reviewCount = 0;
      }
    } catch (_) {}
  }

  // 네이버 내부 API 직접 호출 (page origin 이라 차단 안 됨)
  async function fillFromNaverApi(r, productId) {
    if (!productId) return;
    // 1) 상품 상세 정보 (찜, 등록일 등)
    try {
      const apiUrl = '/i/v1/products/' + productId;
      const res = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const ct = String(res.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('json') !== -1) {
          const data = await res.json();
          if (data && typeof data === 'object') {
            const p = data.product || data;
            if (r.wishCount == null && p.zzimCount != null) r.wishCount = Number(p.zzimCount);
            if (r.wishCount == null && p.wishListCount != null) r.wishCount = Number(p.wishListCount);
            if (r.registDate == null) {
              const d = p.regDate || p.registDate || p.registrationDate;
              if (d) r.registDate = String(d).slice(0, 10).replace(/[.\/]/g, '-');
            }
            if ((!r.tags || !r.tags.length) && Array.isArray(p.searchTags || p.productTags || p.tags)) {
              const arr = p.searchTags || p.productTags || p.tags;
              const tags = arr.map(t => (typeof t === 'string' ? t : (t && (t.text || t.name || t.tagName)))).filter(Boolean);
              if (tags.length) r.tags = tags.slice(0, 12);
            }
          }
        }
      }
    } catch (_) {}
  }

  // page world 의 state 결과를 data 에 머지 (inject 가 값 채웠으면 우선)
  function mergePageState(data, pageData) {
    if (!pageData) return;
    if (data.reviewCount == null && pageData.reviewCount != null) data.reviewCount = pageData.reviewCount;
    if (data.rating == null && pageData.rating != null) data.rating = pageData.rating;
    if (data.wishCount == null && pageData.wishCount != null) data.wishCount = pageData.wishCount;
    if (!data.registDate && pageData.registDate) data.registDate = pageData.registDate;
    if (!data.category && pageData.category) data.category = pageData.category;
    if ((!data.tags || !data.tags.length) && Array.isArray(pageData.tags) && pageData.tags.length) {
      data.tags = pageData.tags;
    }
    if (!data.title && pageData.title) data.title = pageData.title;
    if (!data.image && pageData.image) data.image = pageData.image;
    if (data.price == null && pageData.price != null) data.price = pageData.price;
  }

  // v1.6.6+ : 네트워크 후킹으로 페이지가 API 응답을 받는 즉시 캡처되므로 폴링 시간 대폭 단축
  // 2초마다 재시도, 최대 ~24초 (12회). 의미있는 데이터(2+ 필드) 발견 즉시 전송.
  let attempts = 0;
  const MAX_ATTEMPTS = 8;  // v1.7.15+ : 12 → 8 (속도 우선, 1.2초마다 폴링)
  let sent = false;

  // 페이지 스크롤 — 일부 lazy-loaded 컴포넌트(찜수, 등록일) 가 viewport 진입 시 로드되는 경우 대응
  let scrolled = false;
  function triggerLazyLoad() {
    if (scrolled) return;
    scrolled = true;
    try {
      window.scrollTo({ top: document.body.scrollHeight * 0.5, behavior: 'instant' });
      setTimeout(() => window.scrollTo({ top: 0, behavior: 'instant' }), 1000);
    } catch (_) {}
  }

  // v1.6.9+ : "상세정보 펼쳐보기" 버튼 자동 클릭 (태그 섹션이 그 안에 숨겨져 있음)
  let expanded = false;
  function expandDetailSection() {
    if (expanded) return;
    try {
      const candidates = document.querySelectorAll('button, a, [role="button"]');
      for (const b of candidates) {
        const t = (b.textContent || '').trim();
        if (!t || t.length > 40) continue;
        // "상세정보 펼쳐보기", "상품정보 펼쳐보기", "상세보기" 등 다양한 표기
        if (/^(상세정보|상품정보|상세\s*설명|상세보기)\s*펼쳐/.test(t) || /^더보기$/.test(t)) {
          try { b.click(); expanded = true; console.log('[GPAGO smartstore] 펼쳐보기 클릭:', t); break; } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // v1.6.9+ : 펼쳐진 후 "관련 태그" 섹션에서 # 태그 추출
  function extractTagsFromDom(r) {
    if (r.tags && r.tags.length) return;
    try {
      const tags = [];
      // 방법 1 — "관련 태그" 또는 "상품 태그" 헤더 다음의 # 링크들
      const headers = document.querySelectorAll('h1, h2, h3, h4, strong, em, span, div');
      for (const h of headers) {
        const t = (h.textContent || '').trim();
        if (t.length > 20 || t.length < 3) continue;
        if (!/^(관련\s*태그|상품\s*태그|태그)$/.test(t)) continue;
        // 헤더의 부모 / 형제에서 # 으로 시작하는 텍스트 수집
        const scope = h.parentElement || h;
        const els = scope.querySelectorAll('a, span, em');
        for (const e of els) {
          const tt = (e.textContent || '').trim();
          if (/^#[\w가-힣ㄱ-ㅎ\-]{1,20}$/.test(tt)) {
            const tag = tt.slice(1);
            if (tags.indexOf(tag) < 0) tags.push(tag);
          }
        }
        if (tags.length) break;
      }
      // 방법 2 — 페이지 어디든 #한글/영문 짧은 텍스트 찾기 (폴백)
      if (!tags.length) {
        const links = document.querySelectorAll('a');
        for (const a of links) {
          const tt = (a.textContent || '').trim();
          if (/^#[\w가-힣ㄱ-ㅎ\-]{1,20}$/.test(tt)) {
            const tag = tt.slice(1);
            if (tags.indexOf(tag) < 0) tags.push(tag);
          }
        }
      }
      if (tags.length) r.tags = tags.slice(0, 15);
    } catch (_) {}
  }
  // productId 를 URL 에서 추출
  function getProductIdFromUrl() {
    const m = location.pathname.match(/\/products\/(\d+)/);
    return m ? m[1] : '';
  }

  // v1.7.51+ : 셀하(sellha) 등 외부 확장이 페이지에 주입한 패널에서 최근 판매량 읽기 (설치돼 있을 때만)
  //   "배송건수(7일) 9건 / 예상매출(7일) 89,100원" 같은 텍스트를 파싱 → 최근 실판매 근사
  function _collectAllText() {
    let txt = document.body ? (document.body.innerText || '') : '';
    try {
      const walk = (root, depth) => {
        if (depth > 4) return;
        const els = root.querySelectorAll('*');
        for (let i = 0; i < els.length; i++) {
          const sr = els[i].shadowRoot;
          if (sr) { try { txt += '\n' + (sr.textContent || ''); walk(sr, depth + 1); } catch (_) {} }
        }
      };
      walk(document, 0);
    } catch (_) {}
    return txt;
  }
  function getSellhaData() {
    try {
      const t = _collectAllText();
      if (!t || (!t.includes('배송건수') && !t.includes('예상매출'))) return null;
      const num = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
      const out = {};
      const d7 = num(/배송건수\s*\(?\s*7일\s*\)?\s*[:：]?\s*([\d,]+)\s*건/);
      const r7 = num(/예상\s*매출\s*\(?\s*7일\s*\)?\s*[:：]?\s*([\d,]+)\s*원/);
      const r30 = num(/예상\s*매출\s*\(?\s*(?:30일|월)\s*\)?\s*[:：]?\s*([\d,]+)\s*원/);
      if (d7 != null) out.deliver7d = d7;
      if (r7 != null) out.revenue7d = r7;
      if (r30 != null) out.revenue30d = r30;
      out.at = Date.now();
      return (out.deliver7d != null || out.revenue7d != null) ? out : null;
    } catch (_) { return null; }
  }

  // v1.7.53+ : 최근 리뷰 수(7일/30일)를 네이버 리뷰 API 로 직접 집계 → 셀하 없이도 헤드리스로 최근 판매 추정.
  //   (page origin 이라 쿠키/Referer 자동 — product-summary 와 동일 베이스)
  let _recentReviews = null, _recentReviewsDone = false;
  async function fetchRecentReviewCounts(productId) {
    if (!productId) return null;
    const now = Date.now(), D7 = now - 7 * 864e5, D30 = now - 30 * 864e5;
    let c7 = 0, c30 = 0, total = null, scanned = 0;
    const parseDate = (rv) => {
      const ds = rv && (rv.createDate || rv.writeDate || rv.registerDate || rv.createdDate || rv.regDate || rv.reviewCreateDate || rv.created);
      const t = ds ? new Date(ds).getTime() : NaN; return isNaN(t) ? null : t;
    };
    const getList = (data) => (data && (data.contents || data.reviewContents || data.list || data.reviews)) || (Array.isArray(data) ? data : []);
    for (let page = 1; page <= 4; page++) {
      let data = null;
      const qs = new URLSearchParams({ page: String(page), pageSize: '50', reviewSearchSortType: 'REVIEW_CREATE_DATE_DESC' });
      const candidates = [
        { url: 'https://smartstore.naver.com/i/v1/contents/reviews/query-pages?' + qs.toString() + '&productNo=' + productId, opt: { method: 'GET' } },
        { url: 'https://smartstore.naver.com/i/v1/contents/reviews/query-pages?' + qs.toString() + '&originProductNo=' + productId, opt: { method: 'GET' } },
        { url: 'https://smartstore.naver.com/i/v1/contents/reviews/query-pages', opt: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page, pageSize: 50, reviewSearchSortType: 'REVIEW_CREATE_DATE_DESC', productNo: Number(productId), originProductNo: Number(productId) }) } },
      ];
      for (const ep of candidates) {
        try {
          const r = await fetch(ep.url, Object.assign({ credentials: 'include', headers: Object.assign({ Accept: 'application/json' }, ep.opt.headers || {}) }, ep.opt));
          if (!r.ok) continue;
          const ct = String(r.headers.get('content-type') || '').toLowerCase();
          if (ct.indexOf('json') < 0) continue;
          const j = await r.json();
          if (j && getList(j).length) { data = j; break; }
          if (j && data == null) data = j;
        } catch (_) {}
      }
      if (!data) break;
      const list = getList(data);
      if (total == null) total = (data.totalElements != null ? Number(data.totalElements) : (data.totalCount != null ? Number(data.totalCount) : null));
      if (!list.length) break;
      let allOld = true;
      for (const rv of list) { const t = parseDate(rv); if (t == null) continue; scanned++; if (t >= D7) c7++; if (t >= D30) { c30++; allOld = false; } }
      if (allOld) break; // 이 페이지가 전부 30일 이전 → 더 볼 필요 없음
    }
    if (!scanned) return null;
    return { reviews7d: c7, reviews30d: c30, total: total };
  }
  // 스크립트 시작 즉시 백그라운드로 최근 리뷰 집계 시작 (page origin)
  (async () => {
    try { _recentReviews = await fetchRecentReviewCounts(getProductIdFromUrl()); } catch (_) {}
    _recentReviewsDone = true;
  })();

  async function tryExtractAndSend() {
    if (sent) return;
    attempts++;
    const data = extractData();
    fillFromDom(data);
    // page world 의 __PRELOADED_STATE__ 등에서도 가져옴 (isolated world 의 한계 우회)
    try {
      const pageData = await fetchPageStateData();
      mergePageState(data, pageData);
    } catch (_) {}
    // 네이버 내부 API 직접 호출로 누락 필드 보강 (page origin 차단 안 됨)
    if (!data.registDate || !(data.tags && data.tags.length)) {
      try { await fillFromNaverApi(data, getProductIdFromUrl()); } catch (_) {}
    }
    // v1.6.9+ : 2번째 시도부터 "상세정보 펼쳐보기" 클릭 → 태그 섹션 렌더링
    if (attempts >= 2 && !expanded) expandDetailSection();
    // 펼쳐보기 후엔 태그가 DOM에 나타남 → 추출
    if (expanded) extractTagsFromDom(data);
    // 3번째 시도부터 스크롤 트리거 (lazy-load 컴포넌트 강제 로드)
    if (attempts >= 3 && !scrolled) triggerLazyLoad();
    // v1.7.16+ FINAL : 모든 데이터 소스 합쳐진 후 최종 검증
    //   평점이 0 (또는 사실상 0) 이면 리뷰가 없는 상품 → reviewCount 0 으로 교정
    //   문자열 "0", 숫자 0, 0.0 등 모두 처리
    if (data.rating != null) {
      const ratingNum = Number(data.rating);
      if (!isNaN(ratingNum) && ratingNum < 0.5 && data.reviewCount !== 0) {
        console.log('[GPAGO smartstore] FINAL: 평점=' + data.rating + ' (수치 ' + ratingNum + ') < 0.5 → 리뷰 수 0 교정 (이전:', data.reviewCount, ')');
        data.reviewCount = 0;
      }
    }
    // v1.7.51+ : 셀하(외부 확장) 최근 판매량 패널 읽기 (설치돼 있을 때만)
    const sh = getSellhaData();
    if (sh) {
      data.sellha = sh;
      // v1.7.52+ : 사용자가 이 상품 페이지를 (셀하 켠 채) 볼 때마다 productId 별로 캐시 →
      //   GPAGO 경쟁사 갱신 때 백그라운드 창에서 셀하가 안 떠도 이 캐시를 사용
      try {
        const pid = getProductIdFromUrl();
        if (pid && chrome.runtime && chrome.runtime.id) {
          chrome.storage.local.set({ ['gpago_sellha_' + pid]: Object.assign({ productId: pid }, sh) });
        }
      } catch (_) {}
    }
    const fullyOk = isFullyMeaningful(data);
    const anyOk = hasAnyData(data);
    // 셀하가 페이지에 로딩 중(헤더만 보이고 수치는 아직)일 수 있어, 감지되면 6회까지 한 번 더 대기.
    //   (셀하 미설치 사용자는 sellhaLoading=false → 추가 대기 없음 — 속도 영향 없음)
    let sellhaLoading = false;
    try {
      sellhaLoading = !data.sellha && (
        /sellha|셀하|배송건수|예상\s*매출/i.test((document.body && document.body.innerText) || '') ||
        !!document.querySelector('[class*="sellha" i],[id*="sellha" i]')
      );
    } catch (_) {}
    // v1.7.53+ : 최근 리뷰 집계(헤드리스 판매량) 포함 — 셀하 없이도 동작
    if (_recentReviews) data.recentReviews = _recentReviews;
    const recentLoading = !_recentReviewsDone && attempts < 5;
    if ((fullyOk && !(sellhaLoading && attempts < 6) && !recentLoading) || attempts >= MAX_ATTEMPTS) {
      sent = true;
      try {
        chrome.runtime.sendMessage({
          type: 'GPAGO_SMARTSTORE_TAB_RESULT',
          ok: anyOk,
          data,
          attempts,
          pageUrl: location.href,
        });
      } catch (_) {}
      return;
    }
    setTimeout(tryExtractAndSend, 1200);  // v1.7.15+ : 1500 → 1200ms (속도 우선)
  }

  // v1.7.12+ : 초기 대기 1500 → 600ms (속도 개선)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryExtractAndSend, 600));
  } else {
    setTimeout(tryExtractAndSend, 600);
  }
  // 안전망 — load 이벤트 후 한 번 더 시도
  window.addEventListener('load', () => setTimeout(tryExtractAndSend, 1500));

  // v1.7.52+ : 셀하 값 캐시 전용 폴러 — 추출/전송 흐름과 무관하게, 셀하 패널이 뜨면
  //   productId 별로 chrome.storage 에 저장. 사용자가 평소 상품 페이지를 보기만 해도
  //   GPAGO 경쟁사 갱신이 이 캐시를 사용한다. (최대 ~45초간 폴링, 잡으면 종료)
  (function sellhaCachePoll() {
    let n = 0;
    const iv = setInterval(() => {
      n++;
      try {
        const sh = getSellhaData();
        if (sh) {
          const pid = getProductIdFromUrl();
          if (pid && chrome.runtime && chrome.runtime.id) {
            chrome.storage.local.set({ ['gpago_sellha_' + pid]: Object.assign({ productId: pid }, sh) });
          }
          clearInterval(iv);
        }
      } catch (_) { clearInterval(iv); }
      if (n >= 30) clearInterval(iv); // 1.5s × 30 = 45s
    }, 1500);
  })();
})();
