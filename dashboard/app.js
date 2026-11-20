// Token Radar's dashboard, second rewrite. It reads window.RADAR (written
// beside dashboard/ by main.ts) and renders the ranked board, a filterable
// table, a top-3 spotlight, and a per-protocol detail drawer with the
// model's own inputs and the protocol's farm plan. No network: every byte
// it shows is in data.js. The page recomputes each row with recomputeRow,
// the same arithmetic lib/model.ts runs, so the page's code and board.json
// agree.
//
// Rendering is template strings into one mount, with event delegation: one
// click listener, one input listener and one change listener on the mount
// read data-action / data-key / data-slug attributes. The farm plan is the
// same derivation main.ts writes to board.json: category, chains, TVL and
// age decide the action, the capital, the hold and every cost and time. No
// name is special-cased.

(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var mount = document.getElementById('board');
  if (!mount) return;

  var state = {
    q: '',
    category: 'all',
    chain: 'all',
    growth: 'all',
    minTvl: 0,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  // ------------------------------------------------------------ formatting

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }

  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function ageText(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  /** Escape text for an HTML template: names and categories come from the snapshot. */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------------ the model, again

  // recomputeRow: the model in one function. TVL x 0.30, times the growth,
  // maturity and chain-breadth multipliers, from the snapshot figures alone.
  function recomputeRow(row, model) {
    var raw = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
    var growthFactor = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var breadth = 1 + Math.min((row.chains || []).length, model.breadth_max_chains) * model.breadth_per_chain;
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthFactor * maturity * breadth));
  }

  // ------------------------------------------------------------ the farm plan

  function firstChain(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }

  function stakeFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  // The category action, as a flat keyword table in first-match order. Each
  // keyword maps to one template; a category matches the first keyword it
  // contains, lowercased. {capital} and {gas} carry their dollar sign.
  var ACTION_TEMPLATES = [
    ['lend', 'Supply {capital} of USDC to {name} on {chain} and keep the position open so it counts in every snapshot.'],
    ['cdp', 'Supply {capital} of USDC to {name} on {chain} and keep the position open so it counts in every snapshot.'],
    ['collateral', 'Supply {capital} of USDC to {name} on {chain} and keep the position open so it counts in every snapshot.'],
    ['dex', "Provide {capital} of liquidity to {name}'s main pool on {chain} and keep the position open."],
    ['yield', "Provide {capital} of liquidity to {name}'s main pool on {chain} and keep the position open."],
    ['leveraged farm', "Provide {capital} of liquidity to {name}'s main pool on {chain} and keep the position open."],
    ['bridge', 'Bridge {capital} of USDC to {chain} through {name}, then use the bridged funds inside its app.'],
    ['staking', "Stake {capital} of the chain's staking asset through {name} and keep the receipt token."],
    ['restak', "Stake {capital} of the chain's staking asset through {name} and keep the receipt token."],
    ['perpetual', 'Deposit {capital} of USDC as margin on {name} and open one small hedged position.'],
    ['derivative', 'Deposit {capital} of USDC as margin on {name} and open one small hedged position.'],
    ['basis', 'Deposit {capital} of USDC as margin on {name} and open one small hedged position.'],
    ['prediction', 'Fund {capital} and place one market position on {name}, then settle it.'],
    ['curator', 'Deposit {capital} into a {name} vault on {chain} and keep the vault shares.'],
    ['allocator', 'Deposit {capital} into a {name} vault on {chain} and keep the vault shares.'],
    ['stable', 'Mint or deposit {capital} of the stable asset through {name} on {chain}.'],
    ['rwa', "Mint {capital} of the protocol's yield-bearing asset on {chain} and hold it."],
    ['insurance', 'Buy {capital} of cover from {name} on {chain} and keep the policy active.'],
    ['payment', 'Route {capital} of payments through {name} on {chain} and keep the receipts.'],
  ];

  function fillTemplate(template, ctx) {
    return template
      .replaceAll('{capital}', '$' + ctx.capital)
      .replaceAll('{name}', ctx.name)
      .replaceAll('{chain}', ctx.chain)
      .replaceAll('{hold}', String(ctx.hold))
      .replaceAll('{gas}', '$' + ctx.gas);
  }

  function actionFor(p, ctx) {
    var lowered = (p.category || '').toLowerCase();
    for (var i = 0; i < ACTION_TEMPLATES.length; i++) {
      var entry = ACTION_TEMPLATES[i];
      if (lowered.indexOf(entry[0]) >= 0) return fillTemplate(entry[1], ctx);
    }
    return fillTemplate('Deposit {capital} of USDC into {name} on {chain} and keep the position open.', ctx);
  }

  function joinStep(text, cost, time) {
    var joined = text + ' Cost: ' + cost + '. Time: ' + time + '.';
    var clipped = joined.length > 600 ? joined.slice(0, 596) + '...' : joined;
    return clipped.length < 20 ? clipped + " Hold the position and check the protocol's own page." : clipped;
  }

  function farmSteps(p) {
    var ctx = {
      name: p.name,
      chain: firstChain(p),
      capital: stakeFor(p),
      hold: holdFor(p.age_days),
      gas: 0,
    };
    ctx.gas = ctx.capital >= 150 ? 8 : 4;
    var action = actionFor(p, ctx);
    var steps = [
      [fillTemplate('Use a fresh wallet that holds only the {capital} you plan to farm, and keep its seed phrase offline on paper.', ctx), 'under $3 of gas for the first transaction', '5 minutes'],
      [action, fillTemplate('{capital} of capital and about {gas} of gas', ctx), '15 minutes to set up'],
      [fillTemplate('Do one qualifying action every week on {chain}, such as a deposit, a borrow, a swap or a vote, so the wallet stays active.', ctx), 'about $2 of gas a week', '10 minutes a week'],
      [fillTemplate('Hold the position for at least {hold} days so the activity is counted in more than one snapshot, not just one.', ctx), fillTemplate('the {capital} stays locked in the position', ctx), ctx.hold + ' days'],
      ["Check the protocol's own points or rewards page weekly, and claim only from a link the protocol itself publishes.", 'no fee to check, and never pay anyone to claim', '10 minutes a week'],
      ['Write the wallet address, the dates and every transaction hash in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'],
    ];
    return steps.map(function (s) { return joinStep(s[0], s[1], s[2]); });
  }

  // ------------------------------------------------------------ hash state

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('growth')) state.growth = params.get('growth');
    if (params.get('tab')) state.tab = params.get('tab');
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.growth !== 'all') params.set('growth', state.growth);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ------------------------------------------------------------ filtering

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.minTvl > 0 && r.tvl_usd < state.minTvl) return false;
      if (state.growth === 'up' && !(r.change_7d !== null && r.change_7d > 0)) return false;
      if (state.growth === 'down' && !(r.change_7d !== null && r.change_7d < 0)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function orderedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av;
      var bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'chains') { av = (a.chains || []).length; bv = (b.chains || []).length; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function chainList(row) {
    return row.chains && row.chains.length ? row.chains.slice(0, 2).join(', ') : 'an unnamed chain';
  }

  // ------------------------------------------------------------ sections

  function mastheadHtml() {
    return '' +
      '<header class="masthead">' +
        '<div class="brand"><span class="dot"></span><span class="brand-name">Token Radar</span></div>' +
        '<div class="masthead-meta">' +
          '<span>Snapshot ' + esc(DATA.as_of) + '</span>' +
          '<span>DefiLlama protocol index</span>' +
          '<span>' + esc(DATA.model_version) + ' model</span>' +
        '</div>' +
      '</header>';
  }

  function statRow(label, value) {
    return '<div class="stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }

  function ledeHtml() {
    return '' +
      '<section class="lede">' +
        '<div>' +
          '<h1>' + DATA.watchlist_size + ' watchlist protocols, ranked by implied value</h1>' +
          '<p>The watchlist is the floor: every protocol with at least <b>$' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL</b> and no token on record. ' +
          'The early radar adds <b>' + DATA.early_size + ' pre-token protocols</b> below that floor, so the board finds launches early. ' +
          'Implied value is a model, not a promise: it never predicts whether or when a token is issued.</p>' +
        '</div>' +
        '<div class="stats">' +
          statRow('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size) +
          statRow('Pre-token rows scored', String(DATA.board_size)) +
          statRow('Early rows below the floor', String(DATA.early_size)) +
          statRow('Median implied value', money(DATA.median_implied_usd)) +
          statRow('Biggest category on the board', DATA.top_category) +
          statRow('Live-token protocols set aside', String(DATA.live_size)) +
        '</div>' +
      '</section>';
  }

  function spotlightHtml() {
    var cards = DATA.rows.slice(0, 3).map(function (r) {
      var growthClass = r.change_7d !== null && r.change_7d < 0 ? 'down' : 'up';
      return '' +
        '<button class="spot-card" type="button" data-action="open" data-slug="' + esc(r.slug) + '">' +
          '<span class="rank-tag">RANK ' + r.rank + ' &middot; TOP FARM</span>' +
          '<h3>' + esc(r.name) + '</h3>' +
          '<span class="sub">' + esc(r.category || 'Other') + ' on ' + esc(r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') + '</span>' +
          '<span class="numbers">' +
            '<span>Implied <b>' + money(r.implied_value_usd) + '</b></span>' +
            '<span>TVL <b>' + money(r.tvl_usd) + '</b></span>' +
            '<span>7d <b class="' + growthClass + '">' + pct(r.change_7d) + '</b></span>' +
          '</span>' +
          '<span class="go">View farm plan &rarr;</span>' +
        '</button>';
    }).join('');
    return '<section class="spotlight" aria-label="Top three farms">' + cards + '</section>';
  }

  function optionHtml(value, label, current) {
    return '<option value="' + esc(value) + '"' + (String(value) === String(current) ? ' selected' : '') + '>' + esc(label) + '</option>';
  }

  function filtersHtml() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var countText = state.tab === 'pre-token'
      ? filteredRows().length + ' of ' + DATA.board_size + ' rows shown'
      : DATA.live.length + ' live-token protocols';
    return '' +
      '<div class="filters">' +
        '<div class="field"><label for="q">Search</label>' +
          '<input type="search" id="q" placeholder="Search name or chain" value="' + esc(state.q) + '" aria-label="Search the board"></div>' +
        '<div class="field"><label for="category">Category</label><select id="category" aria-label="Category">' +
          optionHtml('all', 'All categories', state.category) +
          categories.map(function (c) { return optionHtml(c, c, state.category); }).join('') +
        '</select></div>' +
        '<div class="field"><label for="chain">Chain</label><select id="chain" aria-label="Chain">' +
          optionHtml('all', 'All chains', state.chain) +
          chains.map(function (c) { return optionHtml(c, c, state.chain); }).join('') +
        '</select></div>' +
        '<div class="field"><label for="growth">7-day growth</label><select id="growth" aria-label="7-day growth">' +
          optionHtml('all', 'Any growth', state.growth) +
          optionHtml('up', 'Growing only', state.growth) +
          optionHtml('down', 'Falling only', state.growth) +
        '</select></div>' +
        '<div class="field"><label for="mintvl">Minimum TVL</label><select id="mintvl" aria-label="Minimum TVL">' +
          optionHtml('0', 'Any TVL', state.minTvl) +
          optionHtml('50000000', '$50M+', state.minTvl) +
          optionHtml('100000000', '$100M+', state.minTvl) +
          optionHtml('500000000', '$500M+', state.minTvl) +
          optionHtml('1000000000', '$1B+', state.minTvl) +
        '</select></div>' +
        '<div class="field"><label>Token status</label><div class="seg" role="group" aria-label="Token status">' +
          '<button type="button" data-action="tab" data-tab="pre-token" aria-pressed="' + (state.tab === 'pre-token') + '">Pre-token</button>' +
          '<button type="button" data-action="tab" data-tab="live" aria-pressed="' + (state.tab === 'live') + '">Live token</button>' +
        '</div></div>' +
        '<span class="shown-count">' + esc(countText) + '</span>' +
      '</div>';
  }

  function sortHeadHtml(key, label) {
    var arrow = state.sort === key ? (state.dir < 0 ? ' &darr;' : ' &uarr;') : '';
    return '<th scope="col"><button type="button" data-action="sort" data-key="' + key + '">' + esc(label) + arrow + '</button></th>';
  }

  function boardTableHtml() {
    var list = orderedRows(filteredRows());
    if (list.length === 0) {
      return '' +
        '<div class="table-card"><div class="empty">' +
          '<h2>No protocol matches that filter</h2>' +
          '<p>Clear the search or pick another category to see the board again.</p>' +
          '<button class="btn primary" type="button" data-action="clear">Clear filters</button>' +
        '</div></div>';
    }
    var max = 0;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    if (!max) max = 1;
    var rows = list.map(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
      var barWidth = Math.max(3, Math.round((r.implied_value_usd / max) * 100));
      return '' +
        '<tr data-action="open" data-slug="' + esc(r.slug) + '" data-selected="' + (state.selected === r.slug) + '" tabindex="0">' +
          '<td class="num">' + r.rank + '</td>' +
          '<td><div class="proto-name"><b>' + esc(r.name) + '</b><span class="sub">' + esc(r.category || 'Other') + ' on ' + esc(chainList(r)) + '</span></div></td>' +
          '<td class="num">' + money(r.tvl_usd) + '</td>' +
          '<td class="num ' + growthClass + '">' + growth + '</td>' +
          '<td class="num">' + ageText(r.age_days) + '</td>' +
          '<td class="num">' + (r.chains || []).length + '</td>' +
          '<td><div class="value-cell"><div class="value-bar" aria-hidden="true"><i style="width:' + barWidth + '%"></i></div><span class="num">' + money(r.implied_value_usd) + '</span></div></td>' +
          '<td><span class="pill">no token</span></td>' +
        '</tr>';
    }).join('');
    return '' +
      '<div class="table-card"><div class="table-scroll"><table>' +
        '<caption class="caption" style="caption-side: top; text-align: left;">Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.</caption>' +
        '<thead><tr>' +
          sortHeadHtml('implied', 'Rank') +
          sortHeadHtml('name', 'Protocol') +
          sortHeadHtml('tvl', 'TVL') +
          sortHeadHtml('growth', '7d') +
          sortHeadHtml('age', 'Age') +
          sortHeadHtml('chains', 'Chains') +
          sortHeadHtml('implied', 'Implied value') +
          '<th scope="col">Token</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';
  }

  function liveTableHtml() {
    var rows = DATA.live.map(function (r) {
      return '' +
        '<tr>' +
          '<td class="num">live</td>' +
          '<td><div class="proto-name"><b>' + esc(r.name) + '</b><span class="sub">' + esc(r.category || 'Other') + ' on ' + esc(chainList(r)) + '</span></div></td>' +
          '<td class="num">' + money(r.tvl_usd) + '</td>' +
          '<td class="num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'up' : 'down') + '">' + pct(r.change_7d) + '</td>' +
          '<td class="num">' + money(r.mcap_usd) + '</td>' +
          '<td><span class="pill live">already trades</span></td>' +
        '</tr>';
    }).join('');
    return '' +
      '<div class="table-card"><div class="table-scroll"><table>' +
        '<caption class="caption" style="caption-side: top; text-align: left;">Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.</caption>' +
        '<thead><tr><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col">TVL</th><th scope="col">7d</th><th scope="col">Market cap</th><th scope="col">Token</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div></div>';
  }

  function modelNoteHtml() {
    var m = DATA.model;
    return '' +
      '<section class="model-note">' +
        '<h2>How implied value is computed</h2>' +
        '<p class="sub">Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.</p>' +
        '<div class="formula">implied = round( tvl_usd x ' + m.base_multiple + ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + min(chains, ' + m.breadth_max_chains + ') x ' + m.breadth_per_chain + ') )</div>' +
        '<p class="sub">TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token on record; an unlisted age uses ' + m.unknown_age_days + ' days. Chains count how many networks the protocol runs on. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.</p>' +
        '<p class="callout"><b>Reading the board.</b> Rank 1 is the largest implied value, not a prediction: a protocol records no token, never that it has none, and this board never predicts whether or when a token is issued. Farm the top of the board first, hold each position for the weeks its plan names, and check the protocol\u2019s own points page before you claim anything.</p>' +
      '</section>';
  }

  function factorBarHtml(label, value, lo, hi) {
    var width = Math.max(2, Math.min(100, Math.round(((value - lo) / (hi - lo)) * 100)));
    return '' +
      '<div class="factor">' +
        '<div class="factor-top"><span>' + esc(label) + '</span><b>' + value + '</b></div>' +
        '<div class="track" aria-hidden="true"><i style="width:' + width + '%"></i></div>' +
      '</div>';
  }

  function drawerHtml() {
    if (!state.selected) return '';
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) {
      if (DATA.rows[i].slug === state.selected) { row = DATA.rows[i]; break; }
    }
    if (!row) return '';
    var steps = farmSteps(row);
    var recomputed = recomputeRow(row, DATA.model);
    var check = recomputed === row.implied_value_usd
      ? ', the same number board.json carries.'
      : ', which differs from the board: the data would be stale.';
    var stepItems = steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(action) + '</b><span class="step-cost">' + esc(tail) + '</span></li>';
    }).join('');
    var kvRow = function (label, value) {
      return '<div><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
    };
    return '' +
      '<div class="backdrop" data-action="close"></div>' +
      '<aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">' +
        '<div class="drawer-head"><div>' +
          '<span class="brand-name">Rank ' + row.rank + ' of ' + DATA.board_size + '</span>' +
          '<h2 id="drawer-title">' + esc(row.name) + '</h2>' +
          '<p class="sub">' + esc(row.category || 'Other') + ' on ' + esc((row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain')) + '</p>' +
        '</div>' +
        '<button class="close-btn" type="button" aria-label="Close details" data-action="close">Close</button></div>' +
        '<section class="drawer-section"><h3>Implied value</h3><div class="kv">' +
          kvRow('TVL', money(row.tvl_usd)) +
          kvRow('Seven-day growth', pct(row.change_7d)) +
          kvRow('Age with no token', ageText(row.age_days)) +
          kvRow('Chains', String((row.chains || []).length)) +
          kvRow('Growth multiplier', String(row.growth_multiplier)) +
          kvRow('Maturity multiplier', String(row.maturity_multiplier)) +
          kvRow('Breadth multiplier', String(row.breadth_multiplier)) +
          kvRow('Implied value', money(row.implied_value_usd)) +
        '</div>' +
        factorBarHtml('Growth multiplier', row.growth_multiplier, 0.64, 1.72) +
        factorBarHtml('Maturity multiplier', row.maturity_multiplier, 0.55, 1) +
        factorBarHtml('Breadth multiplier', row.breadth_multiplier, 1, 1.16) +
        '<p class="sub" style="margin-top:12px">Model ' + esc(DATA.model_version) + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + check + ' This is an estimate, not a price, and it records no token, it does not prove there is none.</p>' +
        '</section>' +
        '<section class="drawer-section"><h3>Farm plan</h3><ol class="steps">' + stepItems + '</ol></section>' +
      '</aside>';
  }

  // ------------------------------------------------------------ render

  function render() {
    var active = document.activeElement;
    var activeId = active && active.id ? active.id : null;
    var selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    var selEnd = active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
    var html = '' +
      '<div class="page">' +
        mastheadHtml() +
        ledeHtml() +
        (state.tab === 'pre-token' ? spotlightHtml() : '') +
        filtersHtml() +
        (state.tab === 'pre-token' ? boardTableHtml() : liveTableHtml()) +
        (state.tab === 'pre-token' ? modelNoteHtml() : '') +
      '</div>' +
      drawerHtml();
    mount.innerHTML = html;
    mount.setAttribute('aria-busy', 'false');
    if (activeId) {
      var again = document.getElementById(activeId);
      if (again) {
        again.focus();
        if (selStart !== null && typeof again.setSelectionRange === 'function') {
          try { again.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text field */ }
        }
      }
    }
  }

  function update() {
    writeHash();
    render();
  }

  // ------------------------------------------------------------ events

  mount.addEventListener('click', function (e) {
    var target = e.target;
    while (target && target !== mount) {
      var action = target.getAttribute && target.getAttribute('data-action');
      if (action) break;
      target = target.parentNode;
    }
    if (!target || target === mount) return;
    var actionName = target.getAttribute('data-action');
    if (actionName === 'open') {
      state.selected = target.getAttribute('data-slug');
      update();
    } else if (actionName === 'close') {
      state.selected = null;
      update();
    } else if (actionName === 'tab') {
      state.tab = target.getAttribute('data-tab');
      update();
    } else if (actionName === 'sort') {
      var key = target.getAttribute('data-key');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = -1; }
      render();
    } else if (actionName === 'clear') {
      state.q = '';
      state.category = 'all';
      state.chain = 'all';
      state.growth = 'all';
      state.minTvl = 0;
      update();
    }
  });

  mount.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.getAttribute && e.target.getAttribute('data-action') === 'open') {
      e.preventDefault();
      state.selected = e.target.getAttribute('data-slug');
      update();
    }
  });

  mount.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'q') {
      state.q = e.target.value;
      writeHash();
      render();
    }
  });

  mount.addEventListener('change', function (e) {
    if (!e.target || !e.target.id) return;
    if (e.target.id === 'category') { state.category = e.target.value; update(); }
    else if (e.target.id === 'chain') { state.chain = e.target.value; update(); }
    else if (e.target.id === 'growth') { state.growth = e.target.value; update(); }
    else if (e.target.id === 'mintvl') { state.minTvl = Number(e.target.value); update(); }
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.selected) {
      state.selected = null;
      update();
    }
  });

  readHash();
  render();
})();
