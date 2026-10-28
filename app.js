(() => {
  const { $, $$, fmt, esc } = Kit;
  const TARGET = 'converted';
  const SKIP = /^(id|lead_id|leadid|name|email|phone|company|account)$/;

  // ───────── Sample data: synthetic leads from a known logistic process ─────────
  function sampleLeads() {
    const r = Kit.rng(1128);
    const src = [['Referral', 1.2], ['Webinar', 0.5], ['Event', 0.4], ['Paid search', 0], ['Content download', -0.1], ['Outbound', -0.6]];
    const ind = [['Financial Services', 0.25], ['Healthcare', 0.15], ['Technology', 0.2], ['Retail', -0.1], ['Manufacturing', 0], ['Public Sector', -0.25]];
    const size = [['1-50', -0.7], ['51-200', -0.2], ['201-1000', 0.3], ['1001-5000', 0.6], ['5000+', 0.45]];
    const title = [['C-level', 0.6], ['VP', 0.8], ['Director', 0.5], ['Manager', 0], ['Individual contributor', -0.6]];
    const rows = [];
    for (let i = 0; i < 1500; i++) {
      const s = r.weighted([[0, 8], [1, 14], [2, 10], [3, 26], [4, 22], [5, 20]]);
      const n = r.int(0, ind.length - 1), z = r.weighted([[0, 20], [1, 28], [2, 26], [3, 16], [4, 10]]), t = r.weighted([[0, 6], [1, 12], [2, 22], [3, 32], [4, 28]]);
      const pages = Math.max(0, Math.round(Math.exp(1.5 + r.normal() * 0.8)));
      const opens = Math.max(0, Math.round(3 + r.normal() * 2.5 + (s === 1 ? 2 : 0)));
      const demo = r() < 0.08 + pages * 0.006 ? 1 : 0;
      const days = Math.min(120, Math.round(Math.abs(r.normal()) * 35));
      const logit = -3.4 + src[s][1] + ind[n][1] + size[z][1] + title[t][1] + 0.05 * Math.min(pages, 40) + 0.09 * opens + 1.6 * demo - 0.018 * days + r.normal() * 0.35;
      rows.push({
        lead_id: 'L-' + (20000 + i), source: src[s][0], industry: ind[n][0], company_size: size[z][0], title_level: title[t][0],
        pages_viewed: pages, email_opens: opens, demo_requested: demo, days_since_last_touch: days,
        converted: r() < 1 / (1 + Math.exp(-logit)) ? 1 : 0,
      });
    }
    return rows;
  }

  let raw = sampleLeads();
  let schema = null;  // [{name, type:'num'|'cat', levels, mean, sd, on}]

  Kit.bindOutputs(document, { split: (v) => v + '%', reg: (v) => ['None', '0.001', '0.003', '0.01', '0.03', '0.1', '0.3'][v], cut: (v) => v + '% of leads' });
  const LAMBDAS = [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3];

  // ───────── Feature engineering ─────────
  function detectSchema(rows) {
    const cols = Object.keys(rows[0]).filter((c) => c !== TARGET && !SKIP.test(c));
    return cols.map((c) => {
      const vals = rows.map((r) => r[c]);
      const nums = vals.map(Number);
      const isNum = vals.every((v) => v !== '' && isFinite(Number(v)));
      const uniq = [...new Set(vals.map(String))];
      if (isNum) {
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length) || 1;
        return { name: c, type: 'num', mean, sd, on: true };
      }
      if (uniq.length <= 30 && uniq.length < rows.length * 0.5) return { name: c, type: 'cat', levels: uniq.sort(), on: true };
      return null;
    }).filter(Boolean);
  }
  const pretty = (s) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  function featureNames() {
    const out = [];
    schema.filter((f) => f.on).forEach((f) => {
      if (f.type === 'num') out.push({ label: pretty(f.name), f });
      else f.levels.forEach((l) => out.push({ label: `${pretty(f.name)}: ${l}`, f, level: l }));
    });
    return out;
  }
  function vectorize(row, names) {
    return names.map(({ f, level }) => (f.type === 'num' ? (Number(row[f.name]) - f.mean) / f.sd : String(row[f.name]) === level ? 1 : 0));
  }

  // ───────── Logistic regression (batch gradient descent + L2) ─────────
  function train(X, y, lambda) {
    const n = X.length, d = X[0].length;
    const w = new Float64Array(d);
    let b = Math.log((y.reduce((a, c) => a + c, 0) + 1) / (n - y.reduce((a, c) => a + c, 0) + 1));
    const lr = 0.4;
    for (let epoch = 0; epoch < 400; epoch++) {
      const gw = new Float64Array(d);
      let gb = 0;
      for (let i = 0; i < n; i++) {
        let z = b;
        const xi = X[i];
        for (let j = 0; j < d; j++) z += w[j] * xi[j];
        const err = 1 / (1 + Math.exp(-z)) - y[i];
        gb += err;
        for (let j = 0; j < d; j++) gw[j] += err * xi[j];
      }
      for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + lambda * w[j]);
      b -= lr * (gb / n);
    }
    return { w, b };
  }
  const predict = (m, x) => 1 / (1 + Math.exp(-(m.b + x.reduce((s, v, j) => s + v * m.w[j], 0))));

  function auc(scores, y) {
    const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
    let rank = 0, posRanks = 0, pos = 0;
    for (let k = 0; k < idx.length; ) {
      let e = k;
      while (e + 1 < idx.length && scores[idx[e + 1]] === scores[idx[k]]) e++;
      const avg = (k + e) / 2 + 1;
      for (let t = k; t <= e; t++) if (y[idx[t]]) { posRanks += avg; pos++; }
      k = e + 1;
      rank = k;
    }
    const neg = idx.length - pos;
    return pos && neg ? (posRanks - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
  }

  // ───────── Pipeline ─────────
  let state = null;
  function fit() {
    const names = featureNames();
    $('#featCount').textContent = `${names.length} inputs`;
    if (!names.length) { Kit.toast('Pick at least one feature'); return; }
    const rows = raw.filter((r) => r[TARGET] !== '' && r[TARGET] != null);
    const rnd = Kit.rng(99);
    const order = rows.map((_, i) => [rnd(), i]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const nTest = Math.round(rows.length * Number($('#split').value) / 100);
    const testIdx = order.slice(0, nTest), trainIdx = order.slice(nTest);
    // Standardize with statistics from the training rows only, so the test set stays truly unseen
    schema.filter((f) => f.type === 'num').forEach((f) => {
      const v = trainIdx.map((i) => Number(rows[i][f.name]));
      f.mean = v.reduce((a, b) => a + b, 0) / v.length;
      f.sd = Math.sqrt(v.reduce((a, b) => a + (b - f.mean) ** 2, 0) / v.length) || 1;
    });
    const Y = rows.map((r) => (Number(r[TARGET]) ? 1 : 0));
    const X = rows.map((r) => vectorize(r, names));
    const model = train(trainIdx.map((i) => X[i]), trainIdx.map((i) => Y[i]), LAMBDAS[Number($('#reg').value)]);
    const test = testIdx.map((i) => ({ row: rows[i], x: X[i], y: Y[i], p: predict(model, X[i]) })).sort((a, b) => b.p - a.p);
    state = { names, model, test, auc: auc(test.map((t) => t.p), test.map((t) => t.y)), base: Y.reduce((a, b) => a + b, 0) / Y.length, n: rows.length };
    draw();
  }

  function draw() {
    const { names, model, test } = state;
    const posTotal = test.reduce((a, t) => a + t.y, 0);
    const cutPct = Number($('#cut').value) / 100;
    const k = Math.max(1, Math.round(test.length * cutPct));
    const top = test.slice(0, k);
    const tp = top.reduce((a, t) => a + t.y, 0), fp = k - tp, fn = posTotal - tp, tn = test.length - k - fn;
    const captured = posTotal ? tp / posTotal : 0;
    const precision = tp / k, testBase = posTotal / test.length;

    $('#kCap').textContent = fmt.pct(captured);
    $('#kCapHint').textContent = `by calling the top ${fmt.pct(cutPct)} of leads`;
    $('#kLift').textContent = (precision / (testBase || 1)).toFixed(1) + '×';
    $('#kLiftHint').textContent = `${fmt.pct(precision, 1)} convert in the top slice`;
    $('#kAuc').textContent = state.auc.toFixed(3);
    $('#kAucHint').textContent = state.auc >= 0.8 ? 'Strong separation' : state.auc >= 0.7 ? 'Useful separation' : 'Weak — add better features';
    $('#kBase').textContent = fmt.pct(state.base, 1);
    $('#kBaseHint').textContent = `${fmt.num(state.n)} leads · ${fmt.num(test.length)} held out`;

    $('#conf').innerHTML = `
      <div></div><div class="h">Converted</div><div class="h">Didn’t</div>
      <div class="h rh">Called</div><div class="c good"><b>${tp}</b>found</div><div class="c">${fp ? `<b>${fp}</b>wasted calls` : '<b>0</b>'}</div>
      <div class="h rh">Skipped</div><div class="c bad"><b>${fn}</b>missed</div><div class="c good"><b>${tn}</b>saved</div>
      <div class="conf-note">On ${fmt.num(test.length)} held-out leads. Calling ${k} finds ${tp} of ${posTotal} buyers.</div>`;

    // Gains
    const gains = [{ x: 0, y: 0 }];
    let c = 0;
    test.forEach((t, i) => { c += t.y; if ((i + 1) % Math.max(1, Math.floor(test.length / 60)) === 0 || i === test.length - 1) gains.push({ x: (i + 1) / test.length, y: posTotal ? c / posTotal : 0 }); });
    Kit.mount('#gains', (w) => Kit.svg.lines({
      w, h: 260, yMin: 0, yMax: 1, xfmt: (v) => fmt.pct(v), yfmt: (v) => fmt.pct(v), xTicks: [0, 0.2, 0.4, 0.6, 0.8, 1],
      series: [{ name: 'Signal', color: 'var(--c3)', points: gains, area: true, width: 2.5 }, { name: 'Random', color: 'var(--faint)', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], dash: '4 4', width: 1.5 }],
      markers: [{ x: cutPct, y: captured, label: `${fmt.pct(captured)} found`, color: 'var(--c3)' }],
    }));

    // ROC
    const roc = [{ x: 0, y: 0 }];
    const neg = test.length - posTotal;
    let tpc = 0, fpc = 0;
    test.forEach((t, i) => { t.y ? tpc++ : fpc++; if (i % 4 === 0 || i === test.length - 1) roc.push({ x: neg ? fpc / neg : 0, y: posTotal ? tpc / posTotal : 0 }); });
    Kit.mount('#roc', (w) => Kit.svg.lines({
      w, h: 260, yMin: 0, yMax: 1, xfmt: (v) => fmt.pct(v), yfmt: (v) => fmt.pct(v), xTicks: [0, 0.2, 0.4, 0.6, 0.8, 1], hover: false,
      series: [{ name: 'Signal', color: 'var(--c1)', points: roc, area: true, width: 2.5 }, { name: 'Coin flip', color: 'var(--faint)', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], dash: '4 4', width: 1.5 }],
    }));

    // Weights
    const ws = names.map((nm, j) => ({ label: nm.label, value: model.w[j] }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 14)
      .map((d) => ({ ...d, color: d.value >= 0 ? 'var(--c2)' : 'var(--c5)', tip: `${d.label}\nWeight ${d.value.toFixed(2)} · odds ×${Math.exp(d.value).toFixed(2)} per ${names.find((n) => n.label === d.label).f.type === 'num' ? '1 std. dev.' : 'when true'}` }));
    Kit.mount('#weights', (w) => Kit.svg.hbars({ w, items: ws, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(2), labelW: Math.min(230, w * 0.38), rowH: 28 }));

    // Call list
    $('#listSub').textContent = `Held-out leads ranked by score · top ${k} highlighted`;
    $('#list tbody').innerHTML = test.slice(0, 60).map((t, i) => {
      const contrib = names.map((nm, j) => ({ nm, v: model.w[j] * t.x[j] })).filter((c) => Math.abs(c.v) > 0.05).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 3);
      const sub = [t.row.title_level, t.row.company_size && t.row.company_size + ' emp.', t.row.source].filter(Boolean).join(' · ');
      const sc = Math.round(t.p * 100);
      return `<tr style="${i < k ? '' : 'opacity:.55'}">
        <td class="hide-sm">${i + 1}</td>
        <td><span class="lead-name">${esc(t.row.lead_id || 'Lead ' + (i + 1))}</span><span class="lead-sub">${esc(sub || t.row.industry || '')}</span></td>
        <td class="num"><span class="score-pill" style="background:color-mix(in srgb, var(--c3) ${Math.round(10 + t.p * 60)}%, transparent)">${sc}</span></td>
        <td>${t.y ? '<span class="chip chip--good"><i></i>Converted</span>' : '<span class="chip">No</span>'}</td>
        <td class="wrap"><span class="why">${contrib.map((c) => `<span class="${c.v > 0 ? 'up' : 'down'}">${c.v > 0 ? '↑' : '↓'} ${esc(reason(c.nm, t.row))}</span>`).join('')}</span></td>
      </tr>`;
    }).join('');
  }

  // Human-readable reason chip for one feature of one lead
  function reason(nm, row) {
    if (nm.f.type === 'cat') return nm.level;
    const v = row[nm.f.name];
    const binary = nm.f.mean >= 0 && nm.f.mean <= 1 && nm.f.sd <= 0.5;
    if (binary) return (Number(v) ? '' : 'No ') + pretty(nm.f.name).toLowerCase().replace(/^./, (c) => c.toUpperCase());
    return `${pretty(nm.f.name)}: ${v}`;
  }

  function renderFeatures() {
    $('#feats').innerHTML = schema.map((f, i) => `<label><input type="checkbox" data-i="${i}" ${f.on ? 'checked' : ''}/>${esc(pretty(f.name))}</label>`).join('');
    $$('#feats input').forEach((cb) => cb.addEventListener('change', () => { schema[cb.dataset.i].on = cb.checked; fit(); }));
  }

  function loadRows(rows) {
    raw = rows;
    schema = detectSchema(rows);
    renderFeatures();
    fit();
  }

  // ───────── Events ─────────
  const refit = Kit.debounce(fit, 120);
  $('#split').addEventListener('input', refit);
  $('#reg').addEventListener('input', refit);
  $('#cut').addEventListener('input', () => state && draw());
  $('#dlSample').addEventListener('click', () => Kit.csv.download('signal-sample-leads.csv', Kit.csv.stringify(sampleLeads())));
  $('#reset').addEventListener('click', () => { loadRows(sampleLeads()); $('#dataNote').textContent = '1,500 synthetic leads · trained live in your browser'; });
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const rows = Kit.csv.parse(await Kit.csv.readFile(f));
      if (rows.length < 50 || !(TARGET in rows[0])) throw new Error('need converted column');
      loadRows(rows);
      $('#dataNote').textContent = `Trained on ${f.name} · ${fmt.num(rows.length)} rows`;
      Kit.toast('Model trained on your data');
    } catch {
      Kit.toast('Need 50+ rows and a 0/1 “converted” column.');
    }
    e.target.value = '';
  });

  loadRows(raw);
})();
