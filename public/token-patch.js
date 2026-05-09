/* token-patch.js — CEF FiveM : injecte x-ec-token sur tous les fetch API */
(function() {
  // Lire le token depuis le hash # ou ?token= et le stocker
  try {
    var hashToken = window.location.hash ? window.location.hash.replace('#', '') : null;
    var urlToken = null;
    try { urlToken = new URLSearchParams(window.location.search).get('token'); } catch(e) {}
    var token = hashToken || urlToken;
    if (token && token.length > 10) {
      try { localStorage.setItem('ec_token', token); } catch(e) {}
      try { sessionStorage.setItem('ec_token', token); } catch(e) {}
      // Nettoyer le hash de l URL sans recharger la page
      if (hashToken && window.history && window.history.replaceState) {
        try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch(e) {}
      }
    }
  } catch(e) {}

  var _orig = window.fetch;
  window.fetch = function(url, opts) {
    opts = opts || {};
    try {
      var token = null;
      try { token = localStorage.getItem('ec_token'); } catch(e) {}
      if (!token) { try { token = sessionStorage.getItem('ec_token'); } catch(e) {} }
      if (!token) { try { token = window.location.hash ? window.location.hash.replace('#','') : null; } catch(e) {} }
      if (!token) { try { token = new URLSearchParams(window.location.search).get('token'); } catch(e) {} }
      if (token && token.length > 10 && typeof url === 'string' && url.startsWith('/')) {
        opts.headers = opts.headers || {};
        if (opts.headers instanceof Headers) {
          opts.headers.set('x-ec-token', token);
        } else {
          opts.headers['x-ec-token'] = token;
        }
        opts.credentials = opts.credentials || 'include';
      }
    } catch(e) {}
    return _orig.call(this, url, opts);
  };
})();
