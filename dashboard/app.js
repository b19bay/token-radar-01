/* Token Radar — renders the board from window.RADAR (data.js).
 * Filters, sorting, hash deep-links and the model sandbox all run here,
 * client-side, from the row factors the program stored. No network. */
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) {
    document.body.textContent = 'Radar data did not load.';
    return;
  }
  var rows = D.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });
  var topImplied = rows.length ? rows[0].implied_value_usd : 1;

  var state = { q: '', cat: 'All', chain: 'All', watch: false, minTvl: 0, growth: 'all', sort: 'implied' };
  var sandbox = { gw: 0.35, ms: 1, ps: 1, active: false };
  var currentDetail = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtInt(n) { return n.toLocaleString('en-US'); }
  function fmtMoney(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + fmtInt(Math.round(n));
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function med(nums) {
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    if (n === 0) return 0;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var medPeer = med(rows.map(function (r) { return r.model.peer_multiple; }));
  var medGrowth = med(rows.map(function (r) { return r.model.growth_multiplier; }));
  var medMat = med(rows.map(function (r) { return r.model.maturity_multiplier; }));

  /* ---- effective implied value: model value, or the sandbox recompute ---- */
  function effImplied(r) {
    if (!sandbox.active) return r.implied_value_usd;
    var m = r.model;
    var peer = clamp(m.peer_multiple * sandbox.ps, 0.05, 3.0);
    var growth = 1 + (m.growth_pct / 100) * sandbox.gw;
    var mat = r.age_days === null ? 0.85 : 0.7 + 0.3 * sandbox.ms * (1 - Math.exp(-r.age_days / 365));
    return Math.max(1, Math.round(r.tvl_usd * peer * growth * mat * m.breadth_multiplier));
  }

  /* ---- header, stats, source lines ---- */
  function renderHeader() {
    var t = D.meta.totals;
    var chips = [
      ['Protocols scanned', fmtInt(t.protocols_scanned)],
      ['Ranked', fmtInt(t.ranked)],
      ['Watchlist', fmtInt(t.watchlist)],
      ['Set aside', fmtInt(t.set_aside)],
      ['Live-token shown', fmtInt(D.live_rows.length)],
      ['Total implied value', fmtMoney(D.meta.total_implied_usd)],
      ['Median implied value', fmtMoney(D.meta.median_implied_usd)],
    ];
    $('stats').innerHTML = chips.map(function (c) {
      return '<span class="chip"><span class="lab">' + esc(c[0]) + '</span><b>' + esc(c[1]) + '</b></span>';
    }).join('');
    $('sourceLine').textContent = 'Snapshot ' + D.meta.as_of + ' · ' + D.meta.source +
      ' · watchlist floor ' + fmtMoney(D.meta.floor_usd) + ' · model ' + D.meta.model_version;
    $('footSource').textContent = 'Source: ' + D.meta.source + '. Snapshot date ' + D.meta.as_of + '.';
  }

  /* ---- filter controls ---- */
  function fillSelects() {
    var cats = {};
    var chains = {};
    rows.forEach(function (r) {
      if (r.category) cats[r.category] = true;
      r.chains.forEach(function (c) { chains[c] = true; });
    });
    var catNames = Object.keys(cats).sort();
    $('cat').innerHTML = '<option value="All">All categories</option>' + catNames.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
    var chainNames = Object.keys(chains).sort();
    $('chain').innerHTML = '<option value="All">All chains</option>' + chainNames.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
  }

  function syncControls() {
    $('q').value = state.q;
    $('cat').value = state.cat;
    $('chain').value = state.chain;
    $('watch').checked = state.watch;
    $('minTvl').value = String(state.minTvl);
    $('growth').value = state.growth;
    $('sort').value = state.sort;
  }

  /* ---- board ---- */
  function chainText(chains) {
    if (chains.length <= 2) return chains.join(', ');
    return chains[0] + ', ' + chains[1] + ' +' + (chains.length - 2);
  }

  function viewRows() {
    var out = [];
    var q = state.q.trim().toLowerCase();
    rows.forEach(function (r) {
      if (state.watch && !r.watchlist) return;
      if (state.cat !== 'All' && r.category !== state.cat) return;
      if (state.chain !== 'All' && r.chains.indexOf(state.chain) < 0) return;
      if (r.tvl_usd < state.minTvl) return;
      if (state.growth === 'up' && !(r.change_7d !== null && r.change_7d >= 0)) return;
      if (state.growth === 'down' && !(r.change_7d !== null && r.change_7d < 0)) return;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return;
      out.push(r);
    });
    var key = state.sort;
    out.sort(function (a, b) {
      var d = 0;
      if (key === 'implied') d = effImplied(b) - effImplied(a);
      else if (key === 'tvl') d = b.tvl_usd - a.tvl_usd;
      else if (key === 'change') d = (b.change_7d === null ? -9999 : b.change_7d) - (a.change_7d === null ? -9999 : a.change_7d);
      else if (key === 'age') d = (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days);
      else if (key === 'name') d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      if (d !== 0) return d;
      return a.rank - b.rank;
    });
    return out;
  }

  function renderBoard() {
    var v = viewRows();
    var html = '';
    v.forEach(function (r, i) {
      var imp = effImplied(r);
      var pct = clamp((imp / topImplied) * 100, 0, 100);
      var chg = r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg');
      html += '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td><div class="pname">' + esc(r.name) + '</div><div class="pslug">' + esc(r.slug) + '</div></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(chainText(r.chains)) + '</td>' +
        '<td class="num">' + fmtMoney(r.tvl_usd) + '</td>' +
        '<td class="num ' + chg + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + (r.age_days === null ? '—' : fmtInt(r.age_days) + ' d') + '</td>' +
        '<td class="num"><span class="impval">' + fmtMoney(imp) + '</span>' +
        '<span class="bar"><span style="width:' + pct.toFixed(1) + '%"></span></span></td>' +
        '<td>' + (r.watchlist ? '<span class="wl">Watchlist</span>' : '') + '</td>' +
        '<td><button type="button" class="detailBtn" data-slug="' + esc(r.slug) + '">Detail</button></td>' +
        '</tr>';
    });
    $('boardBody').innerHTML = html || '<tr><td colspan="10">No protocols match these filters.</td></tr>';
    $('countLine').textContent = 'Showing ' + fmtInt(v.length) + ' of ' + fmtInt(rows.length) + ' rows';
    $('sandboxBadge').hidden = !sandbox.active;
  }

  /* ---- detail view ---- */
  function whySentence(r) {
    var m = r.model;
    var drivers = [];
    if (m.peer_multiple > medPeer * 1.2) drivers.push('a peer multiple of ' + m.peer_multiple.toFixed(3) + ', above the board median of ' + medPeer.toFixed(3));
    else if (m.peer_multiple < medPeer * 0.8) drivers.push('a peer multiple of ' + m.peer_multiple.toFixed(3) + ', below the board median of ' + medPeer.toFixed(3));
    if (m.growth_multiplier > medGrowth + 0.02) drivers.push('7-day growth of ' + fmtPct(r.change_7d) + ' lifting it');
    else if (m.growth_multiplier < medGrowth - 0.02) drivers.push('7-day growth of ' + fmtPct(r.change_7d) + ' dragging it');
    if (m.maturity_multiplier > medMat + 0.05) drivers.push('a long track record of ' + fmtInt(r.age_days || 0) + ' days');
    else if (m.maturity_multiplier < medMat - 0.05) drivers.push(r.age_days === null ? 'an unknown track record' : 'a short track record of ' + fmtInt(r.age_days) + ' days');
    var size = r.tvl_usd >= 1e9 ? 'its very large TVL of ' + fmtMoney(r.tvl_usd) : 'its TVL of ' + fmtMoney(r.tvl_usd);
    var rest = drivers.length ? ', with ' + drivers.join('; ') : ', with factors close to the board medians';
    return 'It ranks #' + r.rank + ' mainly on ' + size + rest + '.';
  }

  function openDetail(slug, scroll) {
    var r = bySlug[slug];
    if (!r) return;
    currentDetail = slug;
    var m = r.model;
    var product = Math.max(1, Math.round(r.tvl_usd * m.peer_multiple * m.growth_multiplier * m.maturity_multiplier * m.breadth_multiplier));
    var match = product === r.implied_value_usd;
    var peerNote = m.peer_fallback
      ? 'global fallback — fewer than 3 live peers in this category'
      : m.peer_count + ' live peers in ' + (r.category || 'this category');
    var ageNote = r.age_days === null
      ? 'listing date unknown, so the 0.85 unknown-age factor applies'
      : fmtInt(r.age_days) + ' days since listing on ' + (r.listed_at || 'an unknown date');
    var panel = $('detailPanel');
    panel.hidden = false;
    panel.innerHTML =
      '<div class="detail-head"><div><h2>' + esc(r.name) + '</h2>' +
      '<p class="src">' + esc(r.slug) + ' &middot; ' + esc(r.category || 'No category') + ' &middot; ' + esc(r.chains.join(', ')) + '</p></div>' +
      '<button type="button" class="ghost" id="closeDetail">Close &times;</button></div>' +
      '<div class="kv">' +
      '<div><div class="k">Board rank</div><div class="v">#' + r.rank + '</div></div>' +
      '<div><div class="k">Implied value</div><div class="v amber">' + fmtMoney(r.implied_value_usd) + '</div></div>' +
      '<div><div class="k">TVL</div><div class="v">' + fmtMoney(r.tvl_usd) + '</div></div>' +
      '<div><div class="k">7-day change</div><div class="v ' + (r.change_7d === null ? '' : (r.change_7d >= 0 ? 'teal' : '')) + '">' + fmtPct(r.change_7d) + '</div></div>' +
      '<div><div class="k">Age</div><div class="v">' + (r.age_days === null ? 'Unknown' : fmtInt(r.age_days) + ' days') + '</div></div>' +
      '<div><div class="k">Token status</div><div class="v">Records no token</div></div>' +
      (r.watchlist ? '<div><div class="k">Watchlist</div><div class="v teal">Yes</div></div>' : '') +
      '</div>' +
      '<h3>Value breakdown — recomputed here from the stored factors</h3>' +
      '<div class="table-scroll"><table class="breakdown"><tbody>' +
      '<tr><td>TVL</td><td class="num">' + fmtMoney(r.tvl_usd) + '</td></tr>' +
      '<tr><td>Peer multiple (' + esc(peerNote) + ')</td><td class="num">' + m.peer_multiple.toFixed(4) + '</td></tr>' +
      '<tr><td>Growth — ' + fmtPct(r.change_7d) + ' over 7 days</td><td class="num">&times; ' + m.growth_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td>Maturity — ' + esc(ageNote) + '</td><td class="num">&times; ' + m.maturity_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td>Breadth — ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + '</td><td class="num">&times; ' + m.breadth_multiplier.toFixed(4) + '</td></tr>' +
      '<tr><td><strong>Product (TVL &times; peer &times; growth &times; maturity &times; breadth)</strong></td><td class="num"><strong>' + fmtMoney(product) + '</strong></td></tr>' +
      '<tr><td>Board value</td><td class="num"><strong>' + fmtMoney(r.implied_value_usd) + '</strong> ' +
      (match ? '<span class="match">matches</span>' : '<span class="mismatch">differs by ' + fmtMoney(Math.abs(product - r.implied_value_usd)) + '</span>') + '</td></tr>' +
      '</tbody></table></div>' +
      '<p class="why"><strong>Why this ranks here:</strong> ' + esc(whySentence(r)) + '</p>' +
      '<h3>Farm plan</h3>' +
      '<ol class="farm">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="note">This plan is a starting point, not a promise: no airdrop, token or return is guaranteed. Check the protocol&rsquo;s own announcements before moving funds.</p>';
    $('closeDetail').addEventListener('click', closeDetail);
    if (scroll !== false) panel.scrollIntoView({ behavior: 'auto', block: 'start' });
    writeHash();
  }

  function closeDetail() {
    currentDetail = null;
    $('detailPanel').hidden = true;
    $('detailPanel').innerHTML = '';
    writeHash();
  }

  /* ---- peer table, live table, set-aside table ---- */
  function renderPeerTable() {
    $('peerBody').innerHTML = D.peer_table.map(function (p) {
      return '<tr><td>' + esc(p.category) + '</td><td class="num">' + p.multiple.toFixed(4) + '</td>' +
        '<td class="num">' + fmtInt(p.peer_count) + '</td><td>' + (p.fallback ? 'Global fallback' : 'Category median') + '</td></tr>';
    }).join('');
  }

  function renderLive() {
    $('liveBody').innerHTML = D.live_rows.map(function (p) {
      return '<tr><td><div class="pname">' + esc(p.name) + '</div><div class="pslug">' + esc(p.slug) + '</div></td>' +
        '<td>' + esc(p.category || '—') + '</td>' +
        '<td class="num">' + (p.mcap_usd === null ? '—' : fmtMoney(p.mcap_usd)) + '</td>' +
        '<td class="num">' + fmtMoney(p.tvl_usd) + '</td>' +
        '<td class="num">' + (p.fdv_tvl === null ? '—' : p.fdv_tvl.toFixed(3)) + '</td></tr>';
    }).join('');
  }

  function renderAside() {
    var counts = D.aside_counts || {};
    var parts = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (k) { return counts[k] + ' ' + k.toLowerCase(); });
    $('asideCounts').textContent = D.meta.totals.set_aside + ' protocols set aside: ' + parts.join(', ') + '.';
    $('asideBody').innerHTML = D.aside_rows.map(function (p) {
      return '<tr><td><div class="pname">' + esc(p.name) + '</div><div class="pslug">' + esc(p.slug) + '</div></td>' +
        '<td>' + esc(p.category || '—') + '</td>' +
        '<td class="num">' + fmtMoney(p.tvl_usd) + '</td>' +
        '<td>' + esc(p.reason) + '</td></tr>';
    }).join('');
  }

  /* ---- hash deep-links ---- */
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var detail = null;
    h.split('&').forEach(function (part) {
      var kv = part.split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv[1] || '');
      if (k === 'detail') detail = v;
      else if (k === 'cat') state.cat = v;
      else if (k === 'chain') state.chain = v;
      else if (k === 'watchlist') state.watch = v === '1';
      else if (k === 'q') state.q = v;
    });
    return detail;
  }

  function writeHash() {
    var p = [];
    if (state.q) p.push('q=' + encodeURIComponent(state.q));
    if (state.cat !== 'All') p.push('cat=' + encodeURIComponent(state.cat));
    if (state.chain !== 'All') p.push('chain=' + encodeURIComponent(state.chain));
    if (state.watch) p.push('watchlist=1');
    if (currentDetail) p.push('detail=' + encodeURIComponent(currentDetail));
    try {
      history.replaceState(null, '', p.length ? '#' + p.join('&') : '#');
    } catch (e) { /* file:// may restrict history; filters still work */ }
  }

  function refresh() {
    renderBoard();
    writeHash();
  }

  /* ---- wire up ---- */
  fillSelects();
  var detailSlug = readHash();
  syncControls();
  renderHeader();
  renderBoard();
  renderPeerTable();
  renderLive();
  renderAside();
  if (detailSlug) openDetail(detailSlug, true);

  $('q').addEventListener('input', function () { state.q = $('q').value; refresh(); });
  $('cat').addEventListener('change', function () { state.cat = $('cat').value; refresh(); });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; refresh(); });
  $('watch').addEventListener('change', function () { state.watch = $('watch').checked; refresh(); });
  $('minTvl').addEventListener('change', function () { state.minTvl = Number($('minTvl').value); refresh(); });
  $('growth').addEventListener('change', function () { state.growth = $('growth').value; refresh(); });
  $('sort').addEventListener('change', function () { state.sort = $('sort').value; refresh(); });
  $('reset').addEventListener('click', function () {
    state = { q: '', cat: 'All', chain: 'All', watch: false, minTvl: 0, growth: 'all', sort: 'implied' };
    closeDetail();
    syncControls();
    refresh();
  });

  document.querySelectorAll('th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      state.sort = th.getAttribute('data-sort') || 'implied';
      syncControls();
      refresh();
    });
  });

  $('boardBody').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-slug]') : null;
    if (btn) { openDetail(btn.getAttribute('data-slug'), true); return; }
    var tr = e.target.closest ? e.target.closest('tr[data-slug]') : null;
    if (tr) openDetail(tr.getAttribute('data-slug'), true);
  });

  /* ---- sandbox ---- */
  function sandboxChanged() {
    sandbox.gw = Number($('gw').value);
    sandbox.ms = Number($('ms').value);
    sandbox.ps = Number($('ps').value);
    $('gwVal').textContent = sandbox.gw.toFixed(2);
    $('msVal').textContent = sandbox.ms.toFixed(2);
    $('psVal').textContent = sandbox.ps.toFixed(2);
    sandbox.active = sandbox.gw !== 0.35 || sandbox.ms !== 1 || sandbox.ps !== 1;
    renderBoard();
  }
  $('gw').addEventListener('input', sandboxChanged);
  $('ms').addEventListener('input', sandboxChanged);
  $('ps').addEventListener('input', sandboxChanged);
  $('sandboxReset').addEventListener('click', function () {
    $('gw').value = '0.35';
    $('ms').value = '1';
    $('ps').value = '1';
    sandboxChanged();
  });

  window.addEventListener('hashchange', function () {
    var d = readHash();
    syncControls();
    renderBoard();
    if (d) openDetail(d, true);
    else if (currentDetail) closeDetail();
  });
})();
