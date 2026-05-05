/* token-patch.js — CEF FiveM : injecte x-ec-token sur tous les fetch API */
(function() {
  try {
    var urlToken = new URLSearchParams(window.location.search).get('token');
    if (urlToken) {
      try { localStorage.setItem('ec_token', urlToken); } catch(e) {}
      try { sessionStorage.setItem('ec_token', urlToken); } catch(e) {}
    }
  } catch(e) {}
  var _orig = window.fetch;
  window.fetch = function(url, opts) {
    opts = opts || {};
    try {
      var token = null;
      try { token = localStorage.getItem('ec_token'); } catch(e) {}
      if (!token) { try { token = sessionStorage.getItem('ec_token'); } catch(e) {} }
      if (!token) { try { token = new URLSearchParams(window.location.search).get('token'); } catch(e) {} }
      if (token && typeof url === 'string' && url.startsWith('/')) {
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
