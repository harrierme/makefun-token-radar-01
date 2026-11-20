// Token Radar page: renders the board from the data file beside this folder,
// sorts and filters it, and shows one protocol's detail view.
//
// The data arrives as a global from ../data.js (the program writes it next to the
// dashboard folder so the source here stays small). Nothing here reaches the network.

(function () {
  'use strict';

  var data = window.TOKEN_RADAR || { rows: [], as_of: '', source: '', model: '' };
  var rows = data.rows || [];

  var $ = function (id) { return document.getElementById(id); };
  var qEl = $('q');
  var catEl = $('cat');
  var chainEl = $('chain');
  var sortEl = $('sort');
  var rowsEl = $('rows');
  var countEl = $('count');
  var emptyEl = $('empty');
  var detailEl = $('detail');

  function money(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function pct(n) {
    if (n === null || n === undefined) return '<span class="flat">n/a</span>';
    var cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
    var sign = n > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + n.toFixed(2) + '%</span>';
  }

  function ageLabel(years) {
    if (years === null || years === undefined) return 'n/a';
    if (years < 1) return Math.max(1, Math.round(years * 12)) + ' mo';
    return years.toFixed(1) + ' y';
  }

  function watchlist() {
    return rows.filter(function (r) { return r.rank <= 40; });
  }

  // Fill the filter selects from the data itself, so the options are never stale.
  function fillSelects() {
    var cats = {};
    var chains = {};
    rows.forEach(function (r) {
      if (r.category) cats[r.category] = true;
      (r.chains || []).forEach(function (c) { chains[c] = true; });
    });
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      catEl.appendChild(o);
    });
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      chainEl.appendChild(o);
    });
  }

  function currentFilter() {
    return {
      q: (qEl.value || '').trim().toLowerCase(),
      cat: catEl.value,
      chain: chainEl.value,
      sort: sortEl.value,
    };
  }

  function applyFilter(f) {
    var out = rows.filter(function (r) {
      if (f.cat && r.category !== f.cat) return false;
      if (f.chain && (r.chains || []).indexOf(f.chain) === -1) return false;
      if (f.q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase();
        if (hay.indexOf(f.q) === -1) return false;
      }
      return true;
    });
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return (b.age_years || 0) - (a.age_years || 0); },
      name: function (a, b) { return a.name.localeCompare(b.name); },
    };
    out.sort(by[f.sort] || by.rank);
    return out;
  }

  function render(list) {
    rowsEl.innerHTML = '';
    emptyEl.hidden = list.length !== 0;
    countEl.textContent = list.length + ' of ' + rows.length + ' protocols';
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.dataset.slug = r.slug;
      var watch = r.rank <= 40 ? '<span class="tag">watchlist</span>' : '';
      tr.innerHTML =
        '<td class="num rank">' + r.rank + '</td>' +
        '<td><span class="name"></span>' + watch + '<br><span class="slug"></span></td>' +
        '<td>' + (r.category || '—') + '</td>' +
        '<td>' + (r.chains || []).join(', ') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageLabel(r.age_years) + '</td>' +
        '<td class="num value">' + money(r.implied_value_usd) + '</td>';
      tr.querySelector('.name').textContent = r.name;
      tr.querySelector('.slug').textContent = r.slug;
      tr.addEventListener('click', function () { showDetail(r.slug); });
      frag.appendChild(tr);
    });
    rowsEl.appendChild(frag);
  }

  function showDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    rowsEl.querySelectorAll('tr').forEach(function (tr) {
      tr.setAttribute('aria-current', tr.dataset.slug === slug ? 'true' : 'false');
    });
    $('d-name').textContent = r.name;
    var facts = [
      ['Rank', '#' + r.rank + ' of ' + rows.length],
      ['Implied value', money(r.implied_value_usd)],
      ['TVL', money(r.tvl_usd)],
      ['7-day change', r.change_7d === null ? 'not reported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%'],
      ['Listed', r.listed_at || 'not reported'],
      ['Age', ageLabel(r.age_years)],
      ['Category', r.category || '—'],
      ['Chains', (r.chains || []).join(', ')],
    ];
    $('d-facts').innerHTML = facts.map(function (f) {
      return '<div><dt>' + f[0] + '</dt><dd></dd></div>';
    }).join('');
    Array.prototype.forEach.call($('d-facts').querySelectorAll('dd'), function (dd, i) {
      dd.textContent = facts[i][1];
    });
    var growth = r.change_7d === null ? 0 : r.change_7d;
    var gf = 1 + Math.max(-0.15, Math.min(0.4, growth / 100));
    var af = 1 + Math.min(r.age_years || 0, 3) * 0.1;
    $('d-why').textContent =
      money(r.tvl_usd) + ' of TVL at 0.50, bent by a ' + (gf * 100 - 100).toFixed(1) +
      '% growth factor and a ' + (af * 100 - 100).toFixed(1) +
      '% age factor, gives ' + money(r.implied_value_usd) + '. The formula sees only TVL, ' +
      'growth and age — never the name.';
    $('d-steps').innerHTML = '';
    (r.farm_steps || []).forEach(function (s) {
      var li = document.createElement('li');
      li.textContent = s;
      $('d-steps').appendChild(li);
    });
    detailEl.hidden = false;
    detailEl.scrollIntoView({ behavior: 'auto', block: 'start' });
    if (location.hash !== '#/detail/' + slug) {
      history.replaceState(null, '', '#/detail/' + slug);
    }
  }

  function hideDetail() {
    detailEl.hidden = true;
    rowsEl.querySelectorAll('tr').forEach(function (tr) {
      tr.setAttribute('aria-current', 'false');
    });
    if (location.hash.indexOf('#/detail/') === 0) {
      history.replaceState(null, '', '#');
    }
  }

  function rerender() {
    render(applyFilter(currentFilter()));
  }

  function route() {
    var h = location.hash || '';
    if (h.indexOf('#/detail/') === 0) {
      var slug = decodeURIComponent(h.slice(9));
      showDetail(slug);
    } else if (h.indexOf('#/filter/') === 0) {
      // #/filter/<category> opens the board filtered to one category.
      hideDetail();
      var cat = decodeURIComponent(h.slice(9));
      catEl.value = cat;
      rerender();
      window.scrollTo(0, 0);
    } else {
      hideDetail();
      rerender();
      window.scrollTo(0, 0);
    }
  }

  $('close-detail').addEventListener('click', hideDetail);
  [qEl, catEl, chainEl, sortEl].forEach(function (el) {
    el.addEventListener('input', rerender);
    el.addEventListener('change', rerender);
  });
  window.addEventListener('hashchange', route);

  $('asof').textContent = data.as_of || '';
  $('model').textContent = data.model || '';
  $('source').textContent = data.source || '';
  fillSelects();
  route();
})();
