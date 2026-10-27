/* Shared toolkit — data helpers, formatting, and dependency-free SVG charts. */
(function () {
  const Kit = {};

  // ───────── Random (seeded so sample data is reproducible) ─────────
  Kit.rng = function (seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.normal = () => {
      let u = 0, v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    next.pick = (arr) => arr[Math.floor(next() * arr.length)];
    next.weighted = (pairs) => {
      const total = pairs.reduce((s, p) => s + p[1], 0);
      let r = next() * total;
      for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
      return pairs[pairs.length - 1][0];
    };
    return next;
  };

  // ───────── Formatting ─────────
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  Kit.fmt = {
    num: (n) => nf0.format(n),
    num1: (n) => nf1.format(n),
    money: (n) => (n < 0 ? '-$' : '$') + nf0.format(Math.abs(Math.round(n))),
    compact: (n) => {
      const a = Math.abs(n), s = n < 0 ? '-' : '';
      if (a >= 1e9) return s + '$' + nf1.format(a / 1e9) + 'B';
      if (a >= 1e6) return s + '$' + nf1.format(a / 1e6) + 'M';
      if (a >= 1e3) return s + '$' + nf0.format(a / 1e3) + 'K';
      return s + '$' + nf0.format(a);
    },
    pct: (n, d = 0) => (n * 100).toFixed(d) + '%',
    signedPct: (n, d = 0) => (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + '%',
    month: (ym) => {
      const [y, m] = ym.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' }) + ' ’' + String(y).slice(2);
    },
  };

  Kit.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ───────── CSV ─────────
  Kit.csv = {
    parse(text) {
      const rows = [];
      let row = [], field = '', q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
          if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
          else if (c === '"') q = false;
          else field += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r' && text[i + 1] === '\n') i++;
          row.push(field); field = '';
          if (row.some((v) => v !== '')) rows.push(row);
          row = [];
        } else field += c;
      }
      row.push(field);
      if (row.some((v) => v !== '')) rows.push(row);
      const head = rows.shift().map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
      return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
    },
    stringify(rows, cols) {
      cols = cols || Object.keys(rows[0] || {});
      const cell = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    },
    download(name, text) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    },
    readFile(file) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsText(file);
      });
    },
  };

  Kit.toast = (msg) => {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('on'), 2600);
  };

  Kit.$ = (s, r = document) => r.querySelector(s);
  Kit.$$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Wire range/number inputs to their <output> labels
  Kit.bindOutputs = (root = document, fmts = {}) => {
    Kit.$$('input[type="range"]', root).forEach((inp) => {
      const out = root.querySelector(`output[for="${inp.id}"]`);
      if (!out) return;
      const f = fmts[inp.id] || ((v) => v);
      const upd = () => (out.textContent = f(Number(inp.value)));
      inp.addEventListener('input', upd);
      upd();
    });
  };

  Kit.debounce = (fn, ms = 120) => {
    let h;
    return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
  };

  // ───────── Tooltip (any element with data-tip) ─────────
  let tipEl;
  const showTip = (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tipEl && tipEl.classList.remove('on'); return; }
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl); }
    tipEl.textContent = t.getAttribute('data-tip');
    tipEl.classList.add('on');
    const pad = 14, r = tipEl.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  };
  document.addEventListener('pointermove', showTip, { passive: true });
  document.addEventListener('pointerleave', () => tipEl && tipEl.classList.remove('on'));

  // ───────── Charts ─────────
  const charts = new Map();
  const ro = 'ResizeObserver' in window ? new ResizeObserver((entries) => {
    entries.forEach((en) => {
      const c = charts.get(en.target);
      if (c && Math.abs(en.contentRect.width - c.w) > 2) draw(en.target);
    });
  }) : null;
  function draw(el) {
    const c = charts.get(el);
    c.w = Math.max(240, el.clientWidth);
    el.innerHTML = c.fn(c.w);
  }
  // Render fn(width) -> svg string into el; re-renders on resize.
  Kit.mount = (el, fn) => {
    if (typeof el === 'string') el = Kit.$(el);
    const isNew = !charts.has(el);
    charts.set(el, { fn, w: 0 });
    draw(el);
    if (isNew && ro) ro.observe(el);
  };

  const lin = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));
  Kit.scale = lin;

  Kit.ticks = (min, max, count = 5) => {
    if (min === max) return [min];
    const span = max - min, step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const err = step0 / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  };

  const svg = (w, h, inner) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">${inner}</svg>`;
  const tip = (s) => (s ? ` data-tip="${Kit.esc(s)}"` : '');

  Kit.svg = {};

  // Histogram with optional vertical markers
  Kit.svg.histogram = ({ w, h = 260, values, bins = 40, xfmt = String, color = 'var(--c1)', markers = [], hi = null, hiColor = 'var(--c2)' }) => {
    const m = { t: 38, r: 12, b: 28, l: 12 };
    let min = Math.min(...values), max = Math.max(...values);
    markers.forEach((mk) => { min = Math.min(min, mk.x); max = Math.max(max, mk.x); });
    if (min === max) { min -= 1; max += 1; }
    const bw = (max - min) / bins;
    const counts = new Array(bins).fill(0);
    values.forEach((v) => counts[Math.min(bins - 1, Math.floor((v - min) / bw))]++);
    const x = lin(min, max, m.l, w - m.r);
    const y = lin(0, Math.max(...counts), h - m.b, m.t);
    let g = '';
    counts.forEach((c, i) => {
      const x0 = x(min + i * bw), x1 = x(min + (i + 1) * bw);
      const mid = min + (i + 0.5) * bw;
      const fill = hi && hi(mid) ? hiColor : color;
      g += `<rect x="${x0 + 0.5}" y="${y(c)}" width="${Math.max(0.5, x1 - x0 - 1)}" height="${h - m.b - y(c)}" rx="2" style="fill:${fill}"${tip(`${xfmt(min + i * bw)} – ${xfmt(min + (i + 1) * bw)}\n${Kit.fmt.pct(c / values.length, 1)} of outcomes`)}/>`;
    });
    Kit.ticks(min, max, 6).forEach((t) => {
      g += `<text x="${x(t)}" y="${h - 8}" text-anchor="middle">${xfmt(t)}</text>`;
    });
    const placed = [];
    markers.forEach((mk) => {
      const xx = x(mk.x);
      // bump the label up a row if it would collide with an earlier one
      const row = placed.some((p) => Math.abs(p - xx) < 56) ? 1 : 0;
      placed.push(xx);
      const ly = m.t - 10 - row * 14;
      g += `<line x1="${xx}" x2="${xx}" y1="${ly + 4}" y2="${h - m.b}" style="stroke:${mk.color || 'var(--text)'};stroke-width:1.5;stroke-dasharray:${mk.dash ? '4 4' : 'none'}"/>`;
      g += `<text x="${xx}" y="${ly}" text-anchor="${xx > w * 0.85 ? 'end' : xx < w * 0.15 ? 'start' : 'middle'}" class="lbl-strong" style="fill:${mk.color || 'var(--text)'}">${Kit.esc(mk.label)}</text>`;
    });
    return svg(w, h, g);
  };

  // Multi-series line chart. series: [{name, color, points:[{x,y}], dash, area, width}]
  Kit.svg.lines = ({ w, h = 280, series, band, xfmt = String, yfmt = String, xTicks, yMin, yMax, markers = [], hover = true }) => {
    const m = { t: 16, r: 16, b: 30, l: 56 };
    const all = series.flatMap((s) => s.points);
    if (band) all.push(...band.upper, ...band.lower);
    const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = yMin ?? Math.min(0, ...ys), y1 = yMax ?? Math.max(...ys);
    if (y0 === y1) y1 = y0 + 1;
    const yt = Kit.ticks(y0, y1, 5);
    y0 = Math.min(y0, yt[0]); y1 = Math.max(y1, yt[yt.length - 1]);
    const x = lin(x0, x1, m.l, w - m.r), y = lin(y0, y1, h - m.b, m.t);
    let g = '<g class="grid">';
    yt.forEach((t) => { g += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${yfmt(t)}</text>`; });
    g += '</g>';
    (xTicks || Kit.ticks(x0, x1, Math.min(8, Math.floor(w / 90)))).forEach((t) => {
      g += `<text x="${x(t)}" y="${h - 8}" text-anchor="middle">${xfmt(t)}</text>`;
    });
    if (band) {
      const d = band.upper.map((p, i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`).join('') +
        band.lower.slice().reverse().map((p) => `L${x(p.x)},${y(p.y)}`).join('') + 'Z';
      g += `<path d="${d}" style="fill:${band.color};opacity:.16"/>`;
    }
    series.forEach((s) => {
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`).join('');
      if (s.area) {
        g += `<path d="${d}L${x(s.points[s.points.length - 1].x)},${y(Math.max(y0, 0))}L${x(s.points[0].x)},${y(Math.max(y0, 0))}Z" style="fill:${s.color};opacity:.12"/>`;
      }
      g += `<path d="${d}" style="fill:none;stroke:${s.color};stroke-width:${s.width || 2.25};stroke-linejoin:round;stroke-linecap:round;${s.dash ? 'stroke-dasharray:' + s.dash : ''}"/>`;
    });
    markers.forEach((mk) => {
      if (mk.y != null && mk.x == null) {
        g += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(mk.y)}" y2="${y(mk.y)}" style="stroke:${mk.color || 'var(--faint)'};stroke-dasharray:4 4"/>`;
        g += `<text x="${w - m.r}" y="${y(mk.y) - 6}" text-anchor="end" class="lbl-strong" style="fill:${mk.color || 'var(--faint)'}">${Kit.esc(mk.label || '')}</text>`;
      } else if (mk.x != null && mk.y != null) {
        g += `<circle cx="${x(mk.x)}" cy="${y(mk.y)}" r="5" style="fill:${mk.color || 'var(--text)'};stroke:var(--card);stroke-width:2"/>`;
        g += `<text x="${x(mk.x) + 9}" y="${y(mk.y) - 9}" class="lbl-strong" style="fill:${mk.color || 'var(--text)'}">${Kit.esc(mk.label || '')}</text>`;
      } else if (mk.x != null) {
        g += `<line x1="${x(mk.x)}" x2="${x(mk.x)}" y1="${m.t}" y2="${h - m.b}" style="stroke:${mk.color || 'var(--faint)'};stroke-dasharray:4 4"/>`;
        g += `<text x="${x(mk.x) + 6}" y="${m.t + 10}" class="lbl-strong" style="fill:${mk.color || 'var(--faint)'}">${Kit.esc(mk.label || '')}</text>`;
      }
    });
    if (hover && series[0]) {
      // invisible hover columns for tooltips
      const pts = series[0].points;
      pts.forEach((p, i) => {
        const left = i === 0 ? m.l : (x(pts[i - 1].x) + x(p.x)) / 2;
        const right = i === pts.length - 1 ? w - m.r : (x(p.x) + x(pts[i + 1].x)) / 2;
        const lines = [xfmt(p.x)].concat(series.filter((s) => s.name).map((s) => {
          const q = s.points.find((z) => z.x === p.x);
          return q ? `${s.name}: ${yfmt(q.y)}` : null;
        }).filter(Boolean));
        g += `<rect x="${left}" y="${m.t}" width="${Math.max(1, right - left)}" height="${h - m.t - m.b}" style="fill:transparent"${tip(lines.join('\n'))}/>`;
      });
    }
    return svg(w, h, g);
  };

  // Horizontal bars; supports negatives (diverging from zero)
  Kit.svg.hbars = ({ w, items, fmt = String, rowH = 30, labelW = 150, color = 'var(--c1)', negColor = 'var(--c5)' }) => {
    const vals = items.map((d) => d.value);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const m = { t: 4, r: 64, b: 4, l: labelW + (lo < 0 ? 58 : 0) };
    const h = m.t + m.b + items.length * rowH;
    const x = lin(lo, hi === lo ? 1 : hi, m.l, w - m.r);
    let g = `<line x1="${x(0)}" x2="${x(0)}" y1="${m.t}" y2="${h - m.b}" style="stroke:var(--line-2)"/>`;
    items.forEach((d, i) => {
      const yy = m.t + i * rowH;
      const xa = x(Math.min(0, d.value)), xb = x(Math.max(0, d.value));
      const fill = d.color || (d.value < 0 ? negColor : color);
      g += `<text x="${labelW - 10}" y="${yy + rowH / 2 + 4}" text-anchor="end" style="fill:var(--text)">${Kit.esc(d.label)}</text>`;
      g += `<rect x="${xa}" y="${yy + 6}" width="${Math.max(1, xb - xa)}" height="${rowH - 12}" rx="4" style="fill:${fill}"${tip(d.tip || `${d.label}: ${fmt(d.value)}`)}/>`;
      const tx = d.value < 0 ? xa - 6 : xb + 6;
      g += `<text x="${tx}" y="${yy + rowH / 2 + 4}" text-anchor="${d.value < 0 ? 'end' : 'start'}">${fmt(d.value)}</text>`;
    });
    return svg(w, h, g);
  };

  // Tornado sensitivity chart around a base value
  Kit.svg.tornado = ({ w, items, base, fmt = String, rowH = 34, labelW = 170 }) => {
    const m = { t: 22, r: 70, b: 6, l: labelW + 60 };
    const h = m.t + m.b + items.length * rowH;
    const all = items.flatMap((d) => [d.low, d.high]).concat(base);
    const pad = (Math.max(...all) - Math.min(...all)) * 0.04 || 1;
    const x = lin(Math.min(...all) - pad, Math.max(...all) + pad, m.l, w - m.r);
    let g = `<line x1="${x(base)}" x2="${x(base)}" y1="${m.t - 6}" y2="${h - m.b}" style="stroke:var(--text);stroke-width:1.5"/>`;
    g += `<text x="${x(base)}" y="${m.t - 10}" text-anchor="middle" class="lbl-strong">Base ${fmt(base)}</text>`;
    items.forEach((d, i) => {
      const yy = m.t + i * rowH;
      g += `<text x="${labelW - 10}" y="${yy + rowH / 2 + 4}" text-anchor="end" style="fill:var(--text)">${Kit.esc(d.label)}</text>`;
      const seg = (v, col, label) => {
        const a = Math.min(x(v), x(base)), b = Math.max(x(v), x(base));
        return `<rect x="${a}" y="${yy + 7}" width="${Math.max(1, b - a)}" height="${rowH - 14}" rx="3" style="fill:${col}"${tip(`${d.label} ${label}\nResult: ${fmt(v)} (${v >= base ? '+' : ''}${fmt(v - base)})`)}/>`;
      };
      g += seg(d.low, 'var(--c5)', d.lowLabel || 'low');
      g += seg(d.high, 'var(--c1)', d.highLabel || 'high');
      const minV = Math.min(d.low, d.high), maxV = Math.max(d.low, d.high);
      g += `<text x="${x(minV) - 6}" y="${yy + rowH / 2 + 4}" text-anchor="end">${fmt(minV)}</text>`;
      g += `<text x="${x(maxV) + 6}" y="${yy + rowH / 2 + 4}">${fmt(maxV)}</text>`;
    });
    return svg(w, h, g);
  };

  // Heatmap: cell(r, c) -> {color, text, tip, textColor}
  Kit.svg.heatmap = ({ w, rows, cols, cell, labelW = 150, cellH = 30, headH = 34, gap = 3 }) => {
    const cw = (w - labelW) / cols.length;
    const h = headH + rows.length * cellH;
    let g = '';
    cols.forEach((c, j) => {
      g += `<text x="${labelW + j * cw + cw / 2}" y="${headH - 12}" text-anchor="middle" style="fill:var(--muted);font-weight:600">${Kit.esc(c)}</text>`;
    });
    rows.forEach((r, i) => {
      const yy = headH + i * cellH;
      g += `<text x="${labelW - 10}" y="${yy + cellH / 2 + 4}" text-anchor="end" style="fill:var(--text)">${Kit.esc(r)}</text>`;
      cols.forEach((c, j) => {
        const d = cell(i, j);
        if (!d) return;
        const xx = labelW + j * cw;
        g += `<rect x="${xx + gap / 2}" y="${yy + gap / 2}" width="${cw - gap}" height="${cellH - gap}" rx="5" style="fill:${d.color}"${tip(d.tip)}/>`;
        if (d.text && cw > 26) g += `<text x="${xx + cw / 2}" y="${yy + cellH / 2 + 4}" text-anchor="middle" style="fill:${d.textColor || 'var(--text)'};pointer-events:none;font-weight:500">${Kit.esc(d.text)}</text>`;
      });
    });
    return svg(w, h, g);
  };

  // Stacked columns with positive and negative parts. series: [{name, color, values[]}]
  Kit.svg.stacked = ({ w, h = 300, cats, series, fmt = String, catFmt = String, line }) => {
    const m = { t: 14, r: 14, b: 30, l: 60 };
    let lo = 0, hi = 0;
    cats.forEach((_, i) => {
      let p = 0, n = 0;
      series.forEach((s) => { const v = s.values[i]; v >= 0 ? (p += v) : (n += v); });
      hi = Math.max(hi, p); lo = Math.min(lo, n);
    });
    if (line) { hi = Math.max(hi, ...line.values); lo = Math.min(lo, ...line.values); }
    const yt = Kit.ticks(lo, hi, 5);
    lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]);
    const y = lin(lo, hi, h - m.b, m.t);
    const bw = (w - m.l - m.r) / cats.length;
    let g = '<g class="grid">';
    yt.forEach((t) => { g += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`; });
    g += '</g>';
    const every = Math.ceil(cats.length / Math.max(1, Math.floor((w - m.l) / 60)));
    cats.forEach((c, i) => {
      let p = 0, n = 0;
      const xx = m.l + i * bw;
      const lines = [catFmt(c)];
      series.forEach((s) => {
        const v = s.values[i];
        if (!v) return;
        lines.push(`${s.name}: ${fmt(v)}`);
        const a = v >= 0 ? p : n, b = a + v;
        v >= 0 ? (p = b) : (n = b);
        g += `<rect x="${xx + bw * 0.14}" y="${Math.min(y(a), y(b))}" width="${bw * 0.72}" height="${Math.max(0.5, Math.abs(y(a) - y(b)))}" rx="1.5" style="fill:${s.color}"/>`;
      });
      if (line) lines.push(`${line.name}: ${fmt(line.values[i])}`);
      g += `<rect x="${xx}" y="${m.t}" width="${bw}" height="${h - m.t - m.b}" style="fill:transparent"${tip(lines.join('\n'))}/>`;
      if (i % every === 0) g += `<text x="${xx + bw / 2}" y="${h - 8}" text-anchor="middle">${catFmt(c)}</text>`;
    });
    g += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--line-2)"/>`;
    if (line) {
      const d = line.values.map((v, i) => `${i ? 'L' : 'M'}${m.l + i * bw + bw / 2},${y(v)}`).join('');
      g += `<path d="${d}" style="fill:none;stroke:${line.color};stroke-width:2;pointer-events:none"/>`;
    }
    return svg(w, h, g);
  };

  Kit.legend = (items) => `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${Kit.esc(i.name)}</span>`).join('')}</div>`;

  // Blend between two hex colors (t in 0..1)
  Kit.mix = (a, b, t) => {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const A = p(a), B = p(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('');
  };
  Kit.dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

  window.Kit = Kit;
})();
