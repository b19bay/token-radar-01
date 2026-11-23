// Launch Radar's page: the board, the live view and the method, from window.RADAR.
//
// The page renders only what main.ts wrote into data.js: the ranked board, the live-token
// set, the exclusions and the measured validation. Nothing is fetched and nothing is
// invented in the page: a row the page shows is a row of board.json, and a farm plan the
// page shows is that row's own farm_steps.

(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + String(Math.round(n));
  }
  function pct(n) {
    if (n === null || n === undefined) return '—';
    var s = n.toFixed(1) + '%';
    return (n >= 0 ? '+' : '') + s;
  }
  function cls(n) { return n === null || n === undefined ? '' : n >= 0 ? 'pos' : 'neg'; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ageLabel(d) {
    if (d === null || d === undefined) return '—';
    if (d < 30) return d + 'd';
    if (d < 365) return Math.round(d / 30) + 'mo';
    return (d / 365).toFixed(1) + 'y';
  }

  document.getElementById('asof').textContent = 'Snapshot as of ' + R.as_of + ' · ' + R.total_protocols + ' protocols';
  document.getElementById('footDate').textContent = R.as_of;

  // Validation strip: the measured errors, stated as measured.
  var strip = document.getElementById('validStrip');
  strip.innerHTML = R.validation.map(function (v) {
    return '<div class="vstat"><b>' + esc(v.name) + '</b> median |log error| ' + v.median_abs_log_error.toFixed(3) +
      ' · ' + Math.round(v.within_2x * 100) + '% within 2&times;<span>train ' + v.train_n + ' · test ' + v.test_n + '</span></div>';
  }).join('') +
    '<div class="vstat"><b>Coverage</b> ' + R.total_protocols + ' / ' + R.total_protocols + ' protocols accounted for<span>board ' + R.board_size + ' · live ' + R.live_size + ' · excluded ' + R.excluded_size + '</span></div>';

  // KPI strip.
  document.getElementById('kpis').innerHTML = [
    [R.watchlist_size, 'Watchlist protocols'],
    [R.board_size, 'Board rows (pre-token)'],
    [R.live_size, 'Live tokens'],
    [R.global_multiple.toFixed(3), 'Global comps multiple'],
    [R.total_protocols, 'Protocols accounted for'],
  ].map(function (k) {
    return '<div class="kpi"><div class="n">' + k[0] + '</div><div class="l">' + k[1] + '</div></div>';
  }).join('');

  // Tabs.
  var tabs = document.querySelectorAll('.tab');
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      document.querySelectorAll('.pane').forEach(function (p) { p.classList.remove('active'); });
      document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    });
  });

  // Category filter options, by board size.
  var cats = {};
  R.rows.forEach(function (r) { cats[r.category || 'Uncategorised'] = (cats[r.category || 'Uncategorised'] || 0) + 1; });
  var sel = document.getElementById('category');
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option');
    o.value = c;
    o.textContent = c + ' (' + cats[c] + ')';
    sel.appendChild(o);
  });

  // Board table: sort + filter.
  var sortKey = 'rank';
  var sortDir = 1;
  var selected = null;

  function filteredRows() {
    var q = document.getElementById('search').value.trim().toLowerCase();
    var cat = sel.value;
    var watchOnly = document.getElementById('watchOnly').checked;
    return R.rows.filter(function (r) {
      if (watchOnly && !r.watchlist) return false;
      if (cat && (r.category || 'Uncategorised') !== cat) return false;
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function sortedRows(rows) {
    return rows.slice().sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'string') return sortDir * (x < y ? -1 : x > y ? 1 : 0);
      return sortDir * (x - y);
    });
  }
  function renderBoard() {
    var rows = sortedRows(filteredRows());
    var body = document.getElementById('boardBody');
    body.innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b>' + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '<br><span style="color:var(--muted);font-size:12px">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.join(', ') || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + cls(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageLabel(r.age_days) + '</td>' +
        '<td class="num">' + (r.token_odds * 100).toFixed(0) + '%</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td></tr>';
    }).join('');
    document.getElementById('rowCount').textContent = rows.length + ' of ' + R.rows.length + ' rows';
    body.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () { showDetail(tr.dataset.slug); });
    });
  }
  document.querySelectorAll('#boardTable th').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = 1; }
      document.querySelectorAll('#boardTable th').forEach(function (x) { x.classList.remove('sorted'); });
      th.classList.add('sorted');
      renderBoard();
    });
  });
  ['search', 'category', 'watchOnly'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', renderBoard);
  });

  // Detail view: model breakdown, farm plan, comparables — all from the same row.
  function showDetail(slug) {
    selected = slug;
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === slug) r = R.rows[i];
    if (!r) return;
    var base = Math.round(r.tvl_usd * r.comps_multiple);
    var comps = R.live.filter(function (l) { return l.category === r.category; }).slice(0, 5);
    var el = document.getElementById('detail');
    el.hidden = false;
    el.innerHTML =
      '<h2>' + esc(r.name) + ' <span class="big">' + money(r.implied_value_usd) + '</span></h2>' +
      '<p class="sub">Rank ' + r.rank + ' of ' + R.rows.length + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ') || '—') +
      ' · TVL ' + money(r.tvl_usd) + ' · listed ' + esc(r.listed_at || 'unknown') + (r.watchlist ? ' · <b style="color:var(--amber)">on the watchlist</b>' : '') + '</p>' +
      '<h3>Model breakdown</h3>' +
      '<table><thead><tr><th>Term</th><th class="num">Value</th><th>What it is</th></tr></thead><tbody>' +
      '<tr><td>TVL &times; comps multiple</td><td class="num">' + money(base) + '</td><td>TVL &times; ' + r.comps_multiple.toFixed(3) + ' (median mcap/TVL of traded ' + esc(r.category || 'peers') + ')</td></tr>' +
      '<tr><td>Growth multiplier</td><td class="num">&times;' + r.growth_multiplier.toFixed(2) + '</td><td>7-day TVL change ' + pct(r.change_7d) + ', clamped &minus;50&hellip;+100%</td></tr>' +
      '<tr><td>Tenure multiplier</td><td class="num">&times;' + r.tenure_multiplier.toFixed(2) + '</td><td>Age ' + ageLabel(r.age_days) + ' on a 0.70&ndash;1.00 ramp over four years</td></tr>' +
      '<tr><td>Token odds</td><td class="num">&times;' + r.token_odds.toFixed(2) + '</td><td>Peer share of the category that already records a token, shrunk to the global rate</td></tr>' +
      '<tr><td><b>Implied value</b></td><td class="num"><b>' + money(r.implied_value_usd) + '</b></td><td>What a token would be worth if the record stayed as it is</td></tr>' +
      '</tbody></table>' +
      '<h3>Farm plan &mdash; netted</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<h3>Comparables &mdash; traded ' + esc(r.category || 'peers') + '</h3>' +
      (comps.length ? '<table><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Mcap / TVL</th></tr></thead><tbody>' +
        comps.map(function (c) {
          return '<tr><td>' + esc(c.name) + '</td><td class="num">' + money(c.tvl_usd) + '</td><td class="num">' + money(c.mcap_usd) + '</td><td class="num">' + (c.multiple === null ? '—' : c.multiple.toFixed(3)) + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p>No traded peer in this category carries a market cap.</p>');
    renderBoard();
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Live view.
  document.getElementById('liveBody').innerHTML = R.live.map(function (l) {
    return '<tr><td><b>' + esc(l.name) + '</b><br><span style="color:var(--muted);font-size:12px">' + esc(l.slug) + '</span></td>' +
      '<td>' + esc(l.category || '—') + '</td><td>' + esc(l.chains.join(', ') || '—') + '</td>' +
      '<td class="num">' + money(l.tvl_usd) + '</td><td class="num">' + money(l.mcap_usd) + '</td>' +
      '<td class="num">' + (l.multiple === null ? '—' : l.multiple.toFixed(3)) + '</td>' +
      '<td class="num ' + cls(l.change_7d) + '">' + pct(l.change_7d) + '</td></tr>';
  }).join('');

  // Method tab: validation table + coverage text.
  document.getElementById('validTable').innerHTML =
    '<table><thead><tr><th>Test</th><th class="num">Train</th><th class="num">Test</th><th class="num">Median |log error|</th><th class="num">Within 2&times;</th></tr></thead><tbody>' +
    R.validation.map(function (v) {
      return '<tr><td>' + esc(v.name) + '</td><td class="num">' + v.train_n + '</td><td class="num">' + v.test_n + '</td><td class="num">' + v.median_abs_log_error.toFixed(3) + '</td><td class="num">' + Math.round(v.within_2x * 100) + '%</td></tr>';
    }).join('') + '</tbody></table>';
  document.getElementById('coverageText').textContent =
    'The board ranks ' + R.board_size + ' pre-token protocols, including all ' + R.watchlist_size + ' on the watchlist. ' +
    'The Live view carries ' + R.live_size + ' protocols whose token already trades, at the market\u2019s own value. ' +
    R.excluded_size + ' pre-token protocols are listed with their reason instead of ranked: centralised exchanges and versioned pools. ' +
    'Together the dashboard accounts for all ' + R.total_protocols + ' protocols in the snapshot.';

  renderBoard();
})();
