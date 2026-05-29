// 네이버 쇼핑 페이지에서 document_start 시점에 실행 (수동 캡처 모드)
(function () {
  // ─── 1. MAIN world에 inject 스크립트 주입 ───
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject-naver.js');
    s.async = false;
    (document.documentElement || document.head).appendChild(s);
    s.onload = () => s.remove();
  } catch (e) {
    console.warn('[GPAGO content] inject failed:', e);
  }

  // v1.7.21+ : storage 10MB 초과 방지 — 상품 객체 슬림화 (필수 필드만 유지)
  function _slimProduct(p) {
    if (!p || typeof p !== 'object') return p;
    const out = {
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
    };
    // 그룹 감지 필드 (std*OptCount) 유지
    for (const k in p) { if (/^std.*OptCount$/i.test(k)) out[k] = p[k]; }
    return out;
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

  // ─── 2. inject에서 보낸 캡처 데이터 수신 → 탭별로 storage 저장 ───
  //    GPAGO로 전달하는 것은 오직 background.js의 onClicked 핸들러 (Ctrl+Q 시점)에서만 수행
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'gpago-inject') return;
    if (e.data.type !== 'GPAGO_CAPTURED') return;
    try {
      if (!chrome.runtime?.id) return;
      // v1.7.21+ : 슬림화 — 원본 raw 데이터 대신 필수 필드만 storage 에 저장 (10MB 한도 회피)
      //   e.data.data 는 frozen 일 수 있어 직접 수정 불가 → 로컬 변수로 사용
      const slimData = _slimPayload(e.data.data);
      // v1.7.7+ : 찜 룩업 전용 URL 마커 (_gpago_zzim_req=...) 이 있으면
      //   메인 캡처 로직 건드리지 않고 별도 키로만 저장 → background 가 polling 으로 가져감
      const zReq = (location.href.match(/[?&]_gpago_zzim_req=([a-zA-Z0-9_-]+)/) || [])[1];
      if (zReq) {
        await chrome.storage.local.set({
          ['_gpagoZzimResult_' + zReq]: { data: slimData, capturedAt: Date.now() }
        });
        window.postMessage({ source: 'gpago-content', type: 'CAPTURE_ACK' }, window.location.origin);
        return;
      }
      const tab = e.data.tab || '전체';
      const newCount = slimData?.products?.length || 0;
      const stored = await chrome.storage.local.get(['naverCapturesByTab']);
      const capturesByTab = stored.naverCapturesByTab || {};
      const existing = capturesByTab[tab];
      const existingCount = existing?.data?.products?.length || 0;

      // 같은 키워드인지 확인 — 다른 키워드면 무조건 교체
      let sameKeyword = false;
      if (existing && existing.url) {
        try {
          const a = new URL(existing.url);
          const b = new URL(location.href);
          sameKeyword = a.searchParams.get('query') === b.searchParams.get('query');
        } catch (_) {}
      }

      // 같은 키워드 + 더 작은 캡처 → 무시 (큰 게 우선)
      // 다른 키워드 → 무조건 교체 (이전 검색 데이터 덮어쓰기)
      if (existing && sameKeyword && existingCount >= newCount) {
        window.postMessage({ source: 'gpago-content', type: 'CAPTURE_ACK' }, window.location.origin);
        return;
      }

      capturesByTab[tab] = {
        data: slimData,
        url: location.href,
        capturedAt: Date.now()
      };
      const cap = {
        data: slimData,
        url: location.href,
        capturedAt: Date.now(),
        tab
      };
      await chrome.storage.local.set({
        lastNaverCapture: cap,
        naverCapturesByTab: capturesByTab
      });
      window.postMessage({ source: 'gpago-content', type: 'CAPTURE_ACK' }, window.location.origin);
    } catch (_) {}
  });

  // ─── 3. background → content script 메시지 처리 ───
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'GPAGO_RETRY_STATIC') {
      window.postMessage({ source: 'gpago-content', type: 'GPAGO_RETRY_EXTRACTION' }, window.location.origin);
    }
    if (msg && msg.type === 'GPAGO_TRIGGER_ONCE') {
      // 사용자 click 시점에만 1회 자동 트리거 (페이지 크기 토글)
      window.postMessage({ source: 'gpago-content', type: 'GPAGO_TRIGGER_ONCE' }, window.location.origin);
    }
    if (msg && msg.type === 'GPAGO_SHOW_BANNER') {
      showBanner(msg.message || '대기 중...');
    }
    if (msg && msg.type === 'GPAGO_HIDE_BANNER') {
      hideBanner();
    }
  });

  // ─── 4. 페이지 상단 배너 (사용자 안내용) ───
  function showBanner(message) {
    hideBanner();
    const div = document.createElement('div');
    div.id = '__gpago_banner__';
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#3478F6,#2196F3);color:white;padding:14px 24px;font-size:13px;font-weight:bold;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;gap:12px;line-height:1.4;';
    div.innerHTML = '<span>' + message + '</span><button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,.2);border:none;color:white;padding:4px 10px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;">닫기</button>';
    (document.body || document.documentElement).appendChild(div);
  }
  function hideBanner() {
    const old = document.getElementById('__gpago_banner__');
    if (old) old.remove();
  }

  // ─── 5. "...으로만 검색하기" 링크 자동 클릭 (텀즈 분석 등 정확 매칭 필요 시) ───
  //   Naver 가 "찾으시는 상품과 유사한 상품도 함께 노출됩니다" 문구와 함께 노출
  //   클릭하면 fuzzy 매칭 해제 → 입력한 키워드 그대로 검색 → NLU terms 도 정확한 입력 기반
  (function autoClickStrictSearch() {
    if (sessionStorage.getItem('gpago_strict_clicked') === '1') return;
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      if (tries > 25) { clearInterval(interval); return; }  // ~5초까지 시도
      try {
        // a/button 중 strict-search 안내 텍스트를 포함한 요소 찾기
        //   1) "...으로만 검색하기" (구버전)
        //   2) "'키워드' 검색 결과 보기" (옵션 필터 자동 적용 시 — 핑크키캡 등)
        //   3) "'키워드' 검색 결과" (단순 형태)
        const candidates = document.querySelectorAll('a, button, span[role="button"]');
        const STRICT_REGEX = /(으로만\s*검색하기|['"‘’“”].+?['"‘’“”]\s*검색\s*결과(\s*보기)?)/;
        for (const el of candidates) {
          const t = (el.textContent || '').trim();
          if (t && t.length < 80 && STRICT_REGEX.test(t)) {
            try {
              sessionStorage.setItem('gpago_strict_clicked', '1');
              console.log('[GPAGO content] strict-search 자동 클릭 →', t);
              el.click();
              clearInterval(interval);
              return;
            } catch (_) {}
          }
        }
      } catch (_) {}
    }, 200);
  })();
})();
