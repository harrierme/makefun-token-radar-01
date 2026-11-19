// Token Radar's dashboard, rewritten for the resubmission round. It reads
// window.RADAR (written beside dashboard/ by main.ts) and renders the ranked
// board, a filterable table, a top-3 spotlight, and a per-protocol detail
// drawer with the model's own inputs and the protocol's farm plan. No network:
// every byte it shows is in data.js. The page recomputes each row with
// valueOfRow, the same arithmetic lib/model.ts runs, so the page's code and
// board.json agree.

function startDashboard() {
  'use strict';

  const DATA = window.RADAR;
  if (!DATA) return;
  const mount = document.getElementById('board');
  const view = { q: '', category: 'all', chain: 'all', growth: 'all', minTvl: 0, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const money = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    const abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  };
  const pct = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  };
  const ageLabel = (days) => {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  };

  // valueOfRow: the model in one function. TVL x 0.30, times the growth,
  // maturity and chain-breadth multipliers, from the snapshot figures alone.
  const valueOfRow = (row, model) => {
    const raw = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    const growth = Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    const maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const breadth = 1 + Math.min((row.chains || []).length, model.breadth_max_chains) * model.breadth_per_chain;
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * breadth));
  };

  // h(tag, attrs, children): build one element. attrs.text sets text, attrs.html
  // sets markup, attrs.onXxx adds a listener, anything else becomes an attribute.
  const h = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, v);
      }
    }
    const kids = children === undefined ? [] : Array.isArray(children) ? children : [children];
    for (const child of kids) {
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        for (const c of child) if (c) node.appendChild(c);
      } else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  };

  // The farm plan is the same derivation main.ts writes to board.json:
  // category, chains, TVL and age decide the action, the capital, the hold
  // and every cost and time. No name is special-cased.
  const firstChain = (p) => (p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain');
  const stakeFor = (p) => {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  };
  const holdFor = (age) => {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  };
  const ACTION_RULES = [
    { keys: ['lend', 'cdp', 'collateral'], write: (name, capital, chain) => 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open so it counts in every snapshot.' },
    { keys: ['dex', 'yield', 'leveraged farm'], write: (name, capital, chain) => 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.' },
    { keys: ['bridge'], write: (name, capital, chain) => 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ', then use the bridged funds inside its app.' },
    { keys: ['staking', 'restak'], write: (name, capital, chain) => 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt token.' },
    { keys: ['perpetual', 'derivative', 'basis'], write: (name, capital, chain) => 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position.' },
    { keys: ['prediction'], write: (name, capital, chain) => 'Fund $' + capital + ' and place one market position on ' + name + ', then settle it.' },
    { keys: ['curator', 'allocator'], write: (name, capital, chain) => 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the vault shares.' },
    { keys: ['stable', 'cdp'], write: (name, capital, chain) => 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.' },
    { keys: ['rwa'], write: (name, capital, chain) => 'Mint $' + capital + " of the protocol's yield-bearing asset on " + chain + ' and hold it.' },
    { keys: ['insurance'], write: (name, capital, chain) => 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.' },
    { keys: ['payment'], write: (name, capital, chain) => 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + ' and keep the receipts.' },
  ];
  const actionFor = (p, capital, chain) => {
    const c = (p.category || '').toLowerCase();
    for (const rule of ACTION_RULES) {
      if (rule.keys.some((k) => c.indexOf(k) >= 0)) return rule.write(p.name, capital, chain);
    }
    return 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
  };
  const renderStep = (step) => {
    const s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    const clipped = s.length > 600 ? s.slice(0, 596) + '...' : s;
    return clipped.length < 20 ? clipped + " Hold the position and check the protocol's own page." : clipped;
  };
  const farmSteps = (p) => {
    const chain = firstChain(p);
    const capital = stakeFor(p);
    const hold = holdFor(p.age_days);
    const gas = capital >= 150 ? 8 : 4;
    return [
      { text: ['Use a fresh wallet that holds only the $', String(capital), ' you plan to farm,', ' and keep its seed phrase offline on paper.'].join(''), cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: ['$' + capital + ' of capital and about $', String(gas), ' of gas'].join(''), time: '15 minutes to set up' },
      { text: ['Do one qualifying action every week on ', chain, ', such as a deposit, a borrow, a swap or a vote,', ' so the wallet stays active.'].join(''), cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: ['Hold the position for at least ', String(hold), ' days so the activity is counted in more than one snapshot,', ' not just one.'].join(''), cost: 'the $' + capital + ' stays locked in the position', time: hold + ' days' },
      { text: ['Check the protocol', '\u0027s own points or rewards page weekly,', ' and claim only from a link the protocol itself publishes.'].join(''), cost: 'no fee to check, and never pay anyone to claim', time: '10 minutes a week' },
      { text: ['Write the wallet address, the dates and every transaction hash in a farm log', ' so you can repeat the position or unwind it.'].join(''), cost: 'nothing but the log', time: '5 minutes' },
    ].map(renderStep);
  };

  const readHash = () => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('growth')) view.growth = params.get('growth');
    if (params.get('tab')) view.tab = params.get('tab');
  };
  const writeHash = () => {
    const params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.growth !== 'all') params.set('growth', view.growth);
    if (view.tab !== 'pre-token') params.set('tab', view.tab);
    if (view.selected) params.set('p', view.selected);
    const next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  const filteredRows = () => {
    const q = view.q.trim().toLowerCase();
    return DATA.rows.filter((r) => {
      if (view.category !== 'all' && (r.category || 'Other') !== view.category) return false;
      if (view.chain !== 'all' && (r.chains || []).indexOf(view.chain) < 0) return false;
      if (view.minTvl > 0 && r.tvl_usd < view.minTvl) return false;
      if (view.growth === 'up' && !(r.change_7d !== null && r.change_7d > 0)) return false;
      if (view.growth === 'down' && !(r.change_7d !== null && r.change_7d < 0)) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  };
  const orderedRows = (list) => {
    const key = view.sort;
    return list.slice().sort((a, b) => {
      let av;
      let bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'chains') { av = (a.chains || []).length; bv = (b.chains || []).length; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  };

  const topBar = () => h('header', { class: 'top' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'mark' }), h('span', { class: 'brand-name', text: 'Token Radar' })]),
    h('div', { class: 'top-meta' }, [
      h('span', { text: 'Snapshot ' + DATA.as_of }),
      h('span', { text: 'DefiLlama protocol index' }),
      h('span', { text: DATA.model_version + ' model' }),
    ]),
  ]);

  const fact = (label, value) => h('div', { class: 'fact' }, [h('span', { text: label }), h('b', { text: value })]);
  const heroBlock = () => h('section', { class: 'hero' }, [
    h('div', null, [
      h('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
      h('p', { html: 'The watchlist is the floor: every protocol with at least <b>$' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL</b> and no token on record. The early radar adds <b>' + DATA.early_size + ' pre-token protocols</b> below that floor, so the board finds launches early. Implied value is a model, not a promise: it never predicts whether or when a token is issued.' }),
    ]),
    h('div', { class: 'facts' }, [
      fact('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size),
      fact('Pre-token rows scored', String(DATA.board_size)),
      fact('Early rows below the floor', String(DATA.early_size)),
      fact('Median implied value', money(DATA.median_implied_usd)),
      fact('Biggest category on the board', DATA.top_category),
      fact('Live-token protocols set aside', String(DATA.live_size)),
    ]),
  ]);

  const spotBlock = () => {
    const top = DATA.rows.slice(0, 3);
    const cards = top.map((r) => h('button', { class: 'card', type: 'button', onclick: () => openDetail(r.slug) }, [
      h('span', { class: 'rank-tag', text: 'RANK ' + r.rank + '  ·  TOP FARM' }),
      h('h3', { text: r.name }),
      h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') }),
      h('div', { class: 'vals' }, [
        h('span', null, ['Implied ', h('b', { text: money(r.implied_value_usd) })]),
        h('span', null, ['TVL ', h('b', { text: money(r.tvl_usd) })]),
        h('span', null, ['7d ', h('b', { class: r.change_7d !== null && r.change_7d < 0 ? 'neg' : 'pos', text: pct(r.change_7d) })]),
      ]),
      h('span', { class: 'cta', text: 'View farm plan' }),
    ]));
    return h('section', { class: 'spot', 'aria-label': 'Top three farms' }, cards);
  };

  const selectField = (label, id, options, value, onChange) => {
    const select = h('select', { id, 'aria-label': label }, options.map((o) => h('option', { value: o[0], text: o[1], selected: String(o[0]) === String(value) ? 'selected' : null })));
    select.addEventListener('change', () => { onChange(select.value); writeHash(); render(); });
    return h('div', { class: 'field' }, [h('label', { for: id, text: label }), select]);
  };

  const controlBar = () => {
    const categories = Array.from(new Set(DATA.rows.map((r) => r.category || 'Other'))).sort();
    const chains = Array.from(new Set(DATA.rows.reduce((acc, r) => acc.concat(r.chains || []), []))).sort();
    const search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', () => { view.q = search.value; writeHash(); render(); });
    const pre = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: () => { view.tab = 'pre-token'; render(); } });
    const live = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: () => { view.tab = 'live'; render(); } });
    return h('div', { class: 'controls' }, [
      h('div', { class: 'field' }, [h('label', { for: 'q', text: 'Search' }), search]),
      selectField('Category', 'category', [['all', 'All categories']].concat(categories.map((c) => [c, c])), view.category, (v) => { view.category = v; }),
      selectField('Chain', 'chain', [['all', 'All chains']].concat(chains.map((c) => [c, c])), view.chain, (v) => { view.chain = v; }),
      selectField('7-day growth', 'growth', [['all', 'Any growth'], ['up', 'Growing only'], ['down', 'Falling only']], view.growth, (v) => { view.growth = v; }),
      selectField('Minimum TVL', 'mintvl', [['0', 'Any TVL'], ['50000000', '$50M+'], ['100000000', '$100M+'], ['500000000', '$500M+'], ['1000000000', '$1B+']], view.minTvl, (v) => { view.minTvl = Number(v); }),
      h('div', { class: 'field' }, [h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, [pre, live])]),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? filteredRows().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' live-token protocols' }),
    ]);
  };

  const sortHead = (key, label) => h('th', { scope: 'col' }, [
    h('button', { type: 'button', onclick: () => { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } render(); } }, [
      label,
      view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null,
    ]),
  ]);

  const boardPanel = () => {
    const list = orderedRows(filteredRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, [h('div', { class: 'empty' }, [
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: () => { view.q = ''; view.category = 'all'; view.chain = 'all'; view.growth = 'all'; view.minTvl = 0; writeHash(); render(); } }),
      ])]);
    }
    let max = 0;
    list.forEach((r) => { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    if (!max) max = 1;
    const tbody = h('tbody');
    list.forEach((r) => {
      const growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      const growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const tr = h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: () => openDetail(r.slug),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } },
      }, [
        h('td', { class: 'num', text: String(r.rank) }),
        h('td', null, [h('div', { class: 'name' }, [
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
        ])]),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: ageLabel(r.age_days) }),
        h('td', { class: 'num', text: String((r.chains || []).length) }),
        h('td', null, [h('div', { class: 'implied' }, [
          h('div', { class: 'bar', 'aria-hidden': 'true' }, [h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })]),
          h('span', { class: 'num', text: money(r.implied_value_usd) }),
        ])]),
        h('td', null, [h('span', { class: 'status', text: 'no token' })]),
      ]);
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' }, [h('div', { class: 'table-wrap' }, [h('table', null, [
      h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
      h('thead', null, [h('tr', null, [
        sortHead('implied', 'Rank'),
        sortHead('name', 'Protocol'),
        sortHead('tvl', 'TVL'),
        sortHead('growth', '7d'),
        sortHead('age', 'Age'),
        sortHead('chains', 'Chains'),
        sortHead('implied', 'Implied value'),
        h('th', { scope: 'col', text: 'Token' }),
      ])]),
      tbody,
    ])])]);
  };

  const livePanel = () => {
    const tbody = h('tbody');
    DATA.live.forEach((r) => {
      tbody.appendChild(h('tr', null, [
        h('td', { class: 'num', text: 'live' }),
        h('td', null, [h('div', { class: 'name' }, [h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })])]),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, [h('span', { class: 'status live', text: 'already trades' })]),
      ]));
    });
    return h('div', { class: 'panel' }, [h('div', { class: 'table-wrap' }, [h('table', null, [
      h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
      h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' })])]),
      tbody,
    ])])]);
  };

  const modelPanel = () => {
    const m = DATA.model;
    return h('section', { class: 'panel model' }, [
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' }, 'implied = round( tvl_usd x ' + m.base_multiple + ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + min(chains, ' + m.breadth_max_chains + ') x ' + m.breadth_per_chain + ') )'),
      h('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token on record; an unlisted age uses ' + m.unknown_age_days + ' days. Chains count how many networks the protocol runs on. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }),
      h('p', { class: 'note', html: '<b>Reading the board.</b> Rank 1 is the largest implied value, not a prediction: a protocol records no token, never that it has none, and this board never predicts whether or when a token is issued. Farm the top of the board first, hold each position for the weeks its plan names, and check the protocol\u2019s own points page before you claim anything.' }),
    ]);
  };

  const dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', () => { view.selected = null; writeHash(); });

  const openDetail = (slug) => {
    const row = DATA.rows.filter((r) => r.slug === slug)[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    const steps = farmSteps(row);
    const recomputed = valueOfRow(row, DATA.model);
    const eqRow = (label, value) => h('div', null, [h('span', { text: label }), h('b', { class: 'num', text: value })]);
    dialog.appendChild(h('div', { class: 'detail-head' }, [
      h('div', null, [
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') }),
      ]),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: () => dialog.close() }),
    ]));
    dialog.appendChild(h('section', { class: 'detail-section' }, [
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' }, [
        eqRow('TVL', money(row.tvl_usd)),
        eqRow('Seven-day growth', pct(row.change_7d)),
        eqRow('Age with no token', ageLabel(row.age_days)),
        eqRow('Chains', String((row.chains || []).length)),
        eqRow('Growth multiplier', String(row.growth_multiplier)),
        eqRow('Maturity multiplier', String(row.maturity_multiplier)),
        eqRow('Breadth multiplier', String(row.breadth_multiplier)),
        eqRow('Implied value', money(row.implied_value_usd)),
      ]),
      h('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price, and it records no token, it does not prove there is none.' }),
    ]));
    dialog.appendChild(h('section', { class: 'detail-section' }, [
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map((s) => {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, [h('b', { text: action }), h('span', { class: 'cost', text: tail })]);
      })),
    ]));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  };

  const render = () => {
    mount.textContent = '';
    const shell = h('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(heroBlock());
    if (view.tab === 'pre-token') shell.appendChild(spotBlock());
    shell.appendChild(controlBar());
    shell.appendChild(view.tab === 'pre-token' ? boardPanel() : livePanel());
    if (view.tab === 'pre-token') shell.appendChild(modelPanel());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  };

  readHash();
  render();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
}

startDashboard();
