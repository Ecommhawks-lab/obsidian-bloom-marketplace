/* Mercado Bloom portal client (runs on the storefront under the app proxy). No template literals on purpose. */
(function () {
  var root = document.querySelector('.mbp');
  if (!root) return;
  var prefix = root.getAttribute('data-prefix') || '/apps/mb';
  var uplift = Number(root.getAttribute('data-uplift') || 0);
  var commission = Number(root.getAttribute('data-commission') || 0);

  function $(sel, el) { return (el || document).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function money(n) { return '₪' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('he-IL'); }

  function toast(msg, bad) {
    var t = $('.mbp-toast') || document.createElement('div');
    t.className = 'mbp-toast' + (bad ? ' mbp-toast--bad' : '');
    t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t);
    clearTimeout(t._h); t._h = setTimeout(function () { t.remove(); }, 4200);
  }
  function api(path, body) {
    return fetch(prefix + '/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}), credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
    }).then(function (j) { if (!j.ok) throw new Error(j.error || 'שגיאה'); return j; });
  }
  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on; btn.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on) { btn._t = btn.textContent; btn.textContent = 'רגע...'; } else if (btn._t) btn.textContent = btn._t;
  }

  /* ---------- uploads: staged targets, browser posts straight to Shopify storage ---------- */
  function uploadFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type) && f.size < 20 * 1024 * 1024; });
    if (!list.length) return Promise.resolve([]);
    return api('upload-target', { files: list.map(function (f) { return { name: f.name, type: f.type, size: f.size }; }) })
      .then(function (j) {
        return Promise.all(j.targets.map(function (t, i) {
          var fd = new FormData();
          t.parameters.forEach(function (p) { fd.append(p.name, p.value); });
          fd.append('file', list[i]);
          return fetch(t.url, { method: 'POST', body: fd }).then(function (r) {
            if (!r.ok) throw new Error('העלאת התמונה נכשלה');
            return t.resourceUrl;
          });
        }));
      });
  }
  window.MBUpload = uploadFiles;

  /* ---------- product editor ---------- */
  var form = $('#mbp-product');
  if (form) {
    var media = JSON.parse(($('#mbp-media-data') || {}).textContent || '[]'); // [{url, kept:true} | {url, resource}]
    var mediaChanged = false;
    var grid = $('.mbp-media__grid', form);
    function drawMedia() {
      grid.innerHTML = '';
      media.forEach(function (m, i) {
        var d = document.createElement('div'); d.className = 'mbp-media__item';
        var img = document.createElement('img'); img.src = m.preview || m.url; img.alt = ''; d.appendChild(img);
        var x = document.createElement('button'); x.type = 'button'; x.className = 'mbp-media__x'; x.setAttribute('aria-label', 'הסרת תמונה'); x.textContent = '×';
        x.addEventListener('click', function () { media.splice(i, 1); mediaChanged = true; drawMedia(); });
        d.appendChild(x); grid.appendChild(d);
      });
      var add = document.createElement('label'); add.className = 'mbp-media__add';
      add.innerHTML = '<input type="file" accept="image/*" multiple hidden><span>+</span><small>הוספת תמונות</small>';
      add.querySelector('input').addEventListener('change', function (e) {
        var files = e.target.files; if (!files.length) return;
        add.classList.add('is-busy');
        uploadFiles(files).then(function (urls) {
          urls.forEach(function (u, k) { media.push({ url: u, resource: true, preview: URL.createObjectURL(files[k]) }); });
          mediaChanged = true; drawMedia();
        }).catch(function (err) { toast(err.message, true); add.classList.remove('is-busy'); });
      });
      grid.appendChild(add);
    }
    drawMedia();

    var hasOpt = $('#mbp-has-option', form), optBox = $('.mbp-options', form), single = $('.mbp-single-price', form);
    function syncOpt() { optBox.hidden = !hasOpt.checked; single.hidden = hasOpt.checked; }
    hasOpt.addEventListener('change', syncOpt); syncOpt();
    var rows = $('.mbp-opt-rows', form);
    function rowHtml() {
      return '<div class="mbp-opt-row"><input class="mbp-in" name="ov" placeholder="ערך, למשל: גדול" aria-label="ערך">' +
        '<input class="mbp-in" name="op" type="number" min="0" step="1" inputmode="decimal" placeholder="מחיר" aria-label="מחיר">' +
        '<input class="mbp-in" name="oc" type="number" min="0" step="1" inputmode="decimal" placeholder="לפני הנחה" aria-label="מחיר לפני הנחה">' +
        '<button type="button" class="mbp-icon-btn" data-del aria-label="מחיקת שורה">×</button></div>';
    }
    $('[data-add-row]', form).addEventListener('click', function () { rows.insertAdjacentHTML('beforeend', rowHtml()); });
    rows.addEventListener('click', function (e) { if (e.target.hasAttribute('data-del')) { e.target.closest('.mbp-opt-row').remove(); preview(); } });
    if (!rows.children.length) { rows.insertAdjacentHTML('beforeend', rowHtml()); rows.insertAdjacentHTML('beforeend', rowHtml()); }

    function preview() {
      var prices = hasOpt.checked
        ? $all('input[name=op]', rows).map(function (i) { return Number(i.value); }).filter(function (n) { return n > 0; })
        : [Number($('[name=price]', form).value)].filter(function (n) { return n > 0; });
      var out = $('.mbp-price-preview', form);
      if (!prices.length) { out.textContent = 'המחיר באתר יחושב אוטומטית: המחיר שלך + ' + money(uplift) + ' (משלוח חינם ללקוח).'; return; }
      var min = Math.min.apply(null, prices);
      out.innerHTML = 'מחיר באתר: <b>' + money(min + uplift) + '</b> (המחיר שלך ' + money(min) + ' + ' + money(uplift) + ' משלוח). ' +
        'את/ה מקבל/ת כ-<b>' + money(min * (1 - commission / 100)) + '</b> אחרי עמלה של ' + commission + '%.';
    }
    form.addEventListener('input', preview); preview();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('[data-save]');
      var body = {
        id: form.getAttribute('data-id') || null,
        title: $('[name=title]', form).value.trim(),
        description: $('[name=description]', form).value,
        category: $('[name=category]', form).value,
        tags: $('[name=tags]', form).value,
        price: $('[name=price]', form).value,
        compareAt: $('[name=compareAt]', form).value,
        option: null,
        media: mediaChanged ? media.map(function (m) { return m.url; }) : null
      };
      if (hasOpt.checked) {
        var vals = $all('.mbp-opt-row', rows).map(function (r) {
          return { name: $('[name=ov]', r).value.trim(), price: $('[name=op]', r).value, compareAt: $('[name=oc]', r).value };
        }).filter(function (v) { return v.name; });
        body.option = { name: $('[name=optName]', form).value.trim() || 'גודל', values: vals };
      }
      if (!body.title) { toast('יש למלא שם מוצר', true); return; }
      busy(btn, true);
      api(body.id ? 'creator/products/' + body.id : 'creator/products', body).then(function (j) {
        toast(j.message || 'נשמר');
        setTimeout(function () { location.href = prefix + '/creator/products'; }, 900);
      }).catch(function (err) { toast(err.message, true); busy(btn, false); });
    });

    var arch = $('[data-archive]');
    if (arch) arch.addEventListener('click', function () {
      if (!confirm('להסיר את המוצר מהחנות?')) return;
      busy(arch, true);
      api('creator/products/' + form.getAttribute('data-id') + '/archive').then(function () { location.href = prefix + '/creator/products'; })
        .catch(function (err) { toast(err.message, true); busy(arch, false); });
    });
  }

  /* ---------- generic JSON forms: <form data-api="creator/profile"> ---------- */
  $all('form[data-api]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = f.querySelector('[type=submit]');
      var data = {};
      $all('input,select,textarea', f).forEach(function (el) {
        if (!el.name) return;
        if (el.type === 'checkbox') {
          if (el.hasAttribute('data-multi')) { (data[el.name] = data[el.name] || []); if (el.checked) data[el.name].push(el.value); }
          else data[el.name] = el.checked;
        } else if (el.multiple) data[el.name] = $all('option', el).filter(function (o) { return o.selected; }).map(function (o) { return o.value; });
        else data[el.name] = el.value;
      });
      var logo = f.querySelector('input[type=file][data-logo]');
      var chain = Promise.resolve();
      if (logo && logo.files.length) chain = uploadFiles(logo.files).then(function (u) { data.logo_resource = u[0]; });
      busy(btn, true);
      chain.then(function () { return api(f.getAttribute('data-api'), data); })
        .then(function (j) { toast(j.message || 'נשמר'); busy(btn, false); if (j.reload) setTimeout(function () { location.reload(); }, 700); })
        .catch(function (err) { toast(err.message, true); busy(btn, false); });
    });
  });

  /* ---------- action buttons: <button data-action="courier/deliveries/3" data-body='{"status":"delivered"}'> ---------- */
  $all('[data-action]').forEach(function (b) {
    b.addEventListener('click', function () {
      var q = b.getAttribute('data-confirm');
      if (q && !confirm(q)) return;
      busy(b, true);
      api(b.getAttribute('data-action'), JSON.parse(b.getAttribute('data-body') || '{}')).then(function (j) {
        if (j.url) { location.href = j.url; return; }
        toast(j.warning || j.message || 'עודכן', !!j.warning);
        setTimeout(function () { location.reload(); }, 800);
      }).catch(function (err) { toast(err.message, true); busy(b, false); });
    });
  });

  /* ---------- simple client-side filter for long checkbox lists ---------- */
  $all('[data-filter-for]').forEach(function (inp) {
    var box = document.getElementById(inp.getAttribute('data-filter-for'));
    inp.addEventListener('input', function () {
      var q = inp.value.trim();
      $all('label', box).forEach(function (l) { l.hidden = q && l.textContent.indexOf(q) === -1; });
    });
  });
})();
