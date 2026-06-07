// 스마트스토어센터(sell.smartstore.naver.com) MAIN world — 비즈어드바이저 API 응답 passive 캡처
// 페이지를 조작하지 않고, 페이지가 스스로 호출하는 fetch/XHR 응답만 관찰해서 content 로 전달.
(function () {
  if (window.__gpago_biz_inject__) return;
  window.__gpago_biz_inject__ = true;

  // 통계/판매성과/키워드 관련 응답만 후보로 (광고/리소스 제외)
  function looksLikeData(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return false;
    // 정적 리소스 제외
    if (/\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico|mp4)(\?|$)/.test(u)) return false;
    // 비즈어드바이저 / 통계 / 판매성과 / 키워드 / 유입 / 결제 관련
    return /bizadvisor|stat|sales|marketing|keyword|inflow|payment|performance|channel|report|trend|product/i.test(u);
  }

  function send(url, data) {
    try {
      window.postMessage({ source: 'gpago-biz-inject', type: 'BIZ_CAPTURED', url: String(url), data: data }, window.location.origin);
    } catch (_) {}
  }

  // fetch 래핑 (관찰만)
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const p = origFetch.apply(this, args);
    if (looksLikeData(url)) {
      p.then(res => {
        try {
          res.clone().text().then(text => {
            if (!text || text.length > 4000000) return;
            const c0 = text.trimStart()[0];
            if (c0 !== '{' && c0 !== '[') return;
            try { send(url, JSON.parse(text)); } catch (_) {}
          }).catch(() => {});
        } catch (_) {}
      }).catch(() => {});
    }
    return p;
  };
  try { window.fetch.toString = () => 'function fetch() { [native code] }'; } catch (_) {}

  // XHR 래핑 (관찰만)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gpago_biz_url__ = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (looksLikeData(xhr.__gpago_biz_url__)) {
      xhr.addEventListener('load', function () {
        try {
          const text = xhr.responseText;
          if (!text || text.length > 4000000) return;
          const c0 = text.trimStart()[0];
          if (c0 !== '{' && c0 !== '[') return;
          send(xhr.__gpago_biz_url__, JSON.parse(text));
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[GPAGO biz] inject ready — passive 캡처 (비즈어드바이저 응답 관찰)');
})();
