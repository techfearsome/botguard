/**
 * WordPress fingerprint surface.
 *
 * Strategy: present a consistent "this is a default WordPress install" surface
 * to fingerprinting tools (Wappalyzer, BuiltWith, WhatCMS, internet-wide
 * scanners) without logging or maintaining real WP behavior. The goal is to
 * make automated platform identification return "WordPress 6.4.x" so the site
 * blends into the long tail of WP installs rather than standing out as a
 * custom Node.js app worth investigating.
 *
 * Why these specific endpoints:
 *   - /wp-login.php, /wp-admin/, /wp-admin/admin-ajax.php, /xmlrpc.php
 *     are the URLs that virtually all fingerprinting tools probe to confirm
 *     "is this WordPress?". Together with the X-Pingback header and the
 *     <meta name="generator"> tag, they constitute the canonical WP signal.
 *   - /wp-json/ exposes the WP REST API root. Modern fingerprinters check it.
 *   - /readme.html is the historical version-disclosure file every WP install
 *     ships with.
 *
 * What we deliberately don't do:
 *   - No logging. Per product decision: not worth the storage cost for
 *     low-signal automated scans. Real attackers who get past this layer
 *     hit the actual filter chain, which already logs.
 *   - No /wp-content/ /wp-includes/ /plugins/ etc. Too sprawling and the
 *     existing fingerprints are sufficient.
 *   - No fake admin login session. Failed-login response is as far as we
 *     simulate.
 *
 * Routing: mount BEFORE the catch-all root-path route in server.js so these
 * paths win. Real /admin/* routes are registered earlier still, so there's
 * no collision risk.
 */

const express = require('express');
const router = express.Router();

// Pinned to a recent stable WP version. Don't rotate frequently - changing
// this every release is a maintenance burden with no real benefit. WP 6.4.x
// is widespread enough that hitting it doesn't stand out.
const WP_VERSION = '6.4.3';

// ----------------------------------------------------------------------------
// /wp-login.php  - login page (GET) and failed-login response (POST)
// ----------------------------------------------------------------------------
//
// The HTML is a stripped-down clone of what wp-login.php serves. Real WP
// includes far more (dynamic CSS, login_head action hooks, locale-aware text)
// but the markers fingerprinters check are: the <body class="login...">, the
// #login wrapper, and the form field names (log, pwd, wp-submit, redirect_to).

const wpLoginHtml = (errorHtml = '') => `<!DOCTYPE html>
<html lang="en-US">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<title>Log In</title>
<meta name="viewport" content="width=device-width" />
<meta name="robots" content="noindex,follow" />
<style>
html{background:#f0f0f1}
body{background:#f0f0f1;color:#3c434a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;font-size:13px;line-height:1.4;margin:0;min-width:0}
#login{width:320px;padding:8% 0 0;margin:auto}
h1{text-align:center;margin:0 auto 25px}
h1 a{background-image:url(/wp-admin/images/wordpress-logo.svg);background-size:84px;background-position:center top;background-repeat:no-repeat;color:#3c434a;height:84px;font-size:20px;font-weight:400;line-height:1.3;margin:0 auto 25px;padding:0;text-decoration:none;width:84px;text-indent:-9999px;outline:0;overflow:hidden;display:block}
form{margin-top:20px;margin-left:0;padding:26px 24px;font-weight:400;overflow:hidden;background:#fff;border:1px solid #c3c4c7;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.input,input[type=text],input[type=password],input[type=email]{font-size:24px;line-height:1.33333333;width:100%;padding:3px 5px;margin:2px 6px 16px 0;min-height:40px;max-height:none;background:#fff;border:1px solid #8c8f94;box-shadow:0 0 0 transparent;border-radius:4px;color:#2c3338}
label{color:#1d2327;font-size:14px;line-height:1.5}
.submit input{float:right}
.button-primary{background:#2271b1;border-color:#2271b1;color:#fff;text-shadow:none;padding:0 10px;font-size:13px;line-height:2.15384615;min-height:30px;border-radius:3px;border-width:1px;border-style:solid;cursor:pointer}
.forgetmenot{font-weight:400;float:left;margin-bottom:0}
#nav,#backtoblog{font-size:13px;padding:0 24px;text-align:left}
#nav a,#backtoblog a{color:#50575e;text-decoration:none}
#login_error{background:#fff;border-left:4px solid #d63638;box-shadow:0 1px 1px rgba(0,0,0,.04);margin:0 0 20px;padding:12px}
</style>
</head>
<body class="login no-js login-action-login wp-core-ui locale-en-us">
<div id="login">
<h1><a href="https://wordpress.org/">Powered by WordPress</a></h1>
${errorHtml}
<form name="loginform" id="loginform" action="/wp-login.php" method="post">
  <p>
    <label for="user_login">Username or Email Address</label>
    <input type="text" name="log" id="user_login" class="input" value="" size="20" autocapitalize="off" autocomplete="username" />
  </p>
  <div class="user-pass-wrap">
    <label for="user_pass">Password</label>
    <div class="wp-pwd">
      <input type="password" name="pwd" id="user_pass" class="input password-input" value="" size="20" autocomplete="current-password" spellcheck="false" />
    </div>
  </div>
  <p class="forgetmenot"><label for="rememberme"><input name="rememberme" type="checkbox" id="rememberme" value="forever" /> Remember Me</label></p>
  <p class="submit">
    <input type="submit" name="wp-submit" id="wp-submit" class="button button-primary button-large" value="Log In" />
    <input type="hidden" name="redirect_to" value="/wp-admin/" />
    <input type="hidden" name="testcookie" value="1" />
  </p>
</form>
<p id="nav"><a href="/wp-login.php?action=lostpassword">Lost your password?</a></p>
<p id="backtoblog"><a href="/">&larr; Go to Site</a></p>
</div>
</body>
</html>
`;

// On a real WP install, hitting /wp-login.php with no session sets a
// `wordpress_test_cookie` to detect cookie support. We do the same for
// fingerprint accuracy.
function setWpTestCookie(res) {
  res.cookie('wordpress_test_cookie', 'WP+Cookie+check', {
    path: '/',
    sameSite: 'Lax',
  });
}

router.get('/wp-login.php', (req, res) => {
  setWpTestCookie(res);
  // No Cache-Control - matches WP default
  res.type('text/html; charset=UTF-8').send(wpLoginHtml());
});

// Failed login response. WP's actual response is a 200 with the form re-rendered
// + an error block at the top. The error message text below matches the stock
// WP "incorrect password" string verbatim because that's what fingerprinters
// (and humans probing the surface) expect to see.
router.post('/wp-login.php', (req, res) => {
  setWpTestCookie(res);
  // Mimic WP's behavior: brief artificial delay before failure response
  // makes the surface more credible and is well within budget for these
  // low-traffic endpoints.
  setTimeout(() => {
    const errorHtml = `<div id="login_error"><strong>Error:</strong> The username or password you entered is incorrect. <a href="/wp-login.php?action=lostpassword">Lost your password?</a><br /></div>`;
    res.type('text/html; charset=UTF-8').send(wpLoginHtml(errorHtml));
  }, 50);
});

// /wp-admin/ - real WP redirects unauthenticated users to /wp-login.php.
// Note: Express by default matches /wp-admin and /wp-admin/ as the same
// route, so whichever we register first wins for both. We want the
// reauth-redirect to be the response in both cases, so register that one
// first (the earlier /wp-admin -> /wp-admin/ redirect would be a no-op
// loop anyway given Express's behavior).
router.get('/wp-admin', (req, res) => {
  res.redirect(302, '/wp-login.php?redirect_to=' + encodeURIComponent('/wp-admin/') + '&reauth=1');
});
router.get('/wp-admin/', (req, res) => {
  res.redirect(302, '/wp-login.php?redirect_to=' + encodeURIComponent('/wp-admin/') + '&reauth=1');
});

// ----------------------------------------------------------------------------
// /wp-admin/admin-ajax.php  - WP's AJAX endpoint
// ----------------------------------------------------------------------------
//
// Real WP returns plain "0" with status 200 for unauthenticated requests with
// no action= parameter. This is the most-fingerprinted detail because
// admin-ajax.php is whitelisted in robots.txt (we already do that in our
// robots.txt) and so legitimate scanners do hit it.
router.all('/wp-admin/admin-ajax.php', (req, res) => {
  res.type('text/html; charset=UTF-8').send('0');
});

// ----------------------------------------------------------------------------
// /xmlrpc.php  - WP's XML-RPC endpoint
// ----------------------------------------------------------------------------
router.get('/xmlrpc.php', (req, res) => {
  res.type('text/plain').send('XML-RPC server accepts POST requests only.');
});

// XML-RPC fault response. The fault code/string below match what real WP
// returns when called with no method. Format and indentation are byte-exact
// to what wp-includes/class-IXR.php emits.
const xmlrpcFaultResponse = `<?xml version="1.0"?>
<methodResponse>
  <fault>
    <value>
      <struct>
        <member>
          <name>faultCode</name>
          <value><int>-32700</int></value>
        </member>
        <member>
          <name>faultString</name>
          <value><string>parse error. not well formed</string></value>
        </member>
      </struct>
    </value>
  </fault>
</methodResponse>
`;
router.post('/xmlrpc.php', (req, res) => {
  res.type('text/xml').send(xmlrpcFaultResponse);
});

// ----------------------------------------------------------------------------
// /wp-json/  - WP REST API root
// ----------------------------------------------------------------------------
//
// Modern fingerprinters check this. The response shape mimics what wp-api
// emits: JSON with name, description, url, namespaces, authentication
// (empty for anonymous), and routes. Returning a minimal namespace list
// satisfies fingerprint detection without committing to actually serving
// REST API endpoints.
// /wp-json and /wp-json/ both serve the API root - real WP does the same
// thanks to its rewrite rules, and Express's default trailing-slash behavior
// makes a 301 redirect impossible to cleanly add for just one of these.
router.get(['/wp-json', '/wp-json/'], (req, res) => {
  const host = req.hostname || req.get('host') || 'localhost';
  const protocol = req.protocol || 'https';
  const base = `${protocol}://${host}`;
  res.set('Link', `<${base}/wp-json/>; rel="https://api.w.org/"`);
  res.type('application/json').send(JSON.stringify({
    name: '',
    description: '',
    url: base,
    home: base,
    gmt_offset: '0',
    timezone_string: '',
    namespaces: ['oembed/1.0', 'wp/v2', 'wp-site-health/v1', 'wp-block-editor/v1'],
    authentication: [],
    _links: {
      help: [{ href: 'https://developer.wordpress.org/rest-api/' }],
    },
  }));
});

// ----------------------------------------------------------------------------
// /readme.html  - canonical WP version-disclosure file
// ----------------------------------------------------------------------------
router.get('/readme.html', (req, res) => {
  res.type('text/html; charset=UTF-8').send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><title>WordPress &#8250; ReadMe</title>
<link rel="stylesheet" href="/wp-admin/css/install.css?ver=${WP_VERSION}" />
</head>
<body class="wp-core-ui">
<h1 id="logo">WordPress</h1>
<p style="text-align: center;">Semantic Personal Publishing Platform</p>
<h1>First Things First</h1>
<p>Welcome. WordPress is a very special project to me. Every developer and contributor adds something unique to the mix, and together we create something beautiful that I am proud to be a part of. Thousands of hours have gone into WordPress, and we are dedicated to making it better every day. Thank you for making it part of your world.</p>
<p>&#8212; Matt Mullenweg</p>
<h1>Installation: Famous 5-minute install</h1>
<ol>
  <li>Unzip the package in an empty directory and upload everything.</li>
  <li>Open <span class="file"><a href="/wp-admin/install.php">wp-admin/install.php</a></span> in your browser. It will take you through the process to set up a <code>wp-config.php</code> file with your database connection details.</li>
</ol>
<p>Version ${WP_VERSION}</p>
</body>
</html>
`);
});

// ----------------------------------------------------------------------------
// Header + meta injection helpers (used by site routes for homepage et al.)
// ----------------------------------------------------------------------------

/**
 * Set WordPress headers on a response. Stock WP sends these on every
 * frontend page response:
 *   - X-Pingback: advertising the XML-RPC endpoint
 *   - Link: REST API discovery (rel="https://api.w.org/")
 *
 * These are the two headers fingerprinters (Wappalyzer, BuiltWith) check
 * first before even looking at the HTML body.
 */
function setPingbackHeader(req, res) {
  const host = req.hostname || req.get('host') || 'localhost';
  const protocol = req.protocol || 'https';
  res.set('X-Pingback', `${protocol}://${host}/xmlrpc.php`);
  // REST API discovery — WP sends this on EVERY page, not just /wp-json/
  res.set('Link', `<${protocol}://${host}/wp-json/>; rel="https://api.w.org/"`);
}

/**
 * Inject the WP <meta name="generator"> tag plus a few other WP-style
 * markers into a complete HTML document. Inserts before </head> (or after
 * the opening <head> tag if no closing </head> is present).
 *
 * Markers added:
 *   <meta name="generator" content="WordPress X.Y.Z">
 *   <link rel="https://api.w.org/" href="/wp-json/">  (REST API discovery)
 *   <link rel="EditURI" type="application/rsd+xml" title="RSD" href="/xmlrpc.php?rsd">
 *
 * Together these are the three tags most fingerprinters check in HTML.
 */
function injectWpMeta(html) {
  if (typeof html !== 'string' || !html) return html;

  const wpMeta = `<meta name="generator" content="WordPress ${WP_VERSION}">
<link rel="https://api.w.org/" href="/wp-json/">
<link rel="EditURI" type="application/rsd+xml" title="RSD" href="/xmlrpc.php?rsd">`;

  // Try to insert just before </head>. If not present, fall back to right
  // after <head>. If neither, prepend (rare - means the doc has no head).
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, wpMeta + '\n</head>');
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, '<head$1>\n' + wpMeta);
  }
  return wpMeta + '\n' + html;
}

module.exports = {
  router,
  setPingbackHeader,
  injectWpMeta,
  WP_VERSION,
};
