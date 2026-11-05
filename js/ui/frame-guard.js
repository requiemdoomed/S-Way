/*
 * Clickjacking guard. The CSP `frame-ancestors 'none'` directive cannot be delivered
 * in a <meta> tag, and GitHub Pages cannot set response headers, so this script
 * refuses to render S-Way inside a frame. Hosts that support headers also receive
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY` (deployment/_headers).
 */
(function frameGuard() {
  'use strict';
  var framed;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  if (!framed) return;
  document.documentElement.setAttribute('data-framed', 'true');
  document.addEventListener('DOMContentLoaded', function () {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    var p = document.createElement('p');
    p.textContent = 'For your security, S-Way cannot be displayed inside another website. Open it directly in its own tab.';
    document.body.appendChild(p);
  });
  // Stop the application module from doing any work inside a frame.
  window.__SWAY_FRAMED__ = true;
}());
