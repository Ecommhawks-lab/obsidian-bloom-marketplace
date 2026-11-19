// Server-rendered portal pages. Returned as application/liquid so the store's
// own header, footer, fonts and RTL wrap them. Avoid "{{" / "{%" except on purpose.
import { PORTAL_CSS, PORTAL_JS } from './generated.mjs';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  .replace(/\{\{/g, '{&#123;').replace(/\{%/g, '{&#37;');
export const ils = (cents) => '₪' + (Math.round(Number(cents || 0)) / 100).toLocaleString('he-IL', { maximumFractionDigits: 2 });
const ilsAmount = (n) => '₪' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('he-IL', { maximumFractionDigits: 2 });
const dt = (s) => { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')); return isNaN(d) ? s : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' }); };

const PRODUCT_STATUS = {
  pending: ['ממתין לאישור', 'warn'], approved: ['פעיל בחנות', 'ok'], edited: ['פעיל · שינויים בבדיקה', 'ok'],
  rejected: ['נדחה', 'bad'], hidden: ['הוסר מהחנות', ''],
};
const DELIVERY_STATUS = {
  unassigned: ['ממתין לשיבוץ', 'warn'], assigned: ['שובץ – לאיסוף', 'warn'], picked_up: ['בדרך ללקוח', 'ok'],
  delivered: ['נמסר', 'ok'], failed: ['בעיה במסירה', 'bad'],
};
export const CATEGORIES = ['פרחים', 'זרים', 'עציצים', 'פרחים מיובשים', 'מתנות', 'עיצוב לבית', 'קרמיקה', 'טקסטיל', 'תכשיטים', 'אחר'];
const badge = (map, s) => { const [t, tone] = map[s] || [s, '']; return `<span class="mbp-badge${tone ? ' mbp-badge--' + tone : ''}">${esc(t)}</span>`; };

export function layout(ctx, { title, nav = null, active = '', body, data = {} }) {
  const links = nav === 'creator'
    ? [['', 'לוח בקרה'], ['/products', 'המוצרים שלי'], ['/products/new', 'מוצר חדש'], ['/orders', 'הזמנות'], ['/profile', 'החנות שלי']]
    : nav === 'courier' ? [['', 'משלוחים'], ['/history', 'היסטוריה'], ['/profile', 'הפרופיל שלי']] : [];
  const base = `${ctx.prefix}/${nav}`;
  const navHtml = links.length ? `<nav class="mbp-nav" aria-label="ניווט אזור אישי">${links.map(([p, t]) =>
    `<a href="${base}${p}"${active === p ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>` : '';
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<style>${PORTAL_CSS}</style>
<div class="mbp" data-prefix="${esc(ctx.prefix)}"${attrs}>
  <div class="mbp-wrap">
    <div class="mbp-top"><div><h1>${esc(title)}</h1>${ctx.who ? `<p class="mbp-sub">${esc(ctx.who)}</p>` : ''}</div></div>
    ${navHtml}
    ${body}
  </div>
</div>
<script>${PORTAL_JS}</script>`;
}

/* ------------------------------ gates ------------------------------ */
export function loginPage(ctx, area) {
  const label = area === 'courier' ? 'אזור השליחים' : 'אזור היוצרים';
  const join = area === 'courier' ? '/pages/join-couriers' : '/pages/join-creators';
  // routes.account_login_url is rendered by the theme (Liquid) on purpose.
  return layout(ctx, { title: label, body: `
    <div class="mbp-card" style="max-width:520px">
      <h2>יש להתחבר כדי להמשיך</h2>
      <p>ההתחברות היא עם אותו אימייל שאיתו הגשת את הבקשה. נשלח אליך קוד חד-פעמי למייל.</p>
      <div class="mbp-actions">
        <a class="mbp-btn" href="{{ routes.account_login_url }}?return_url=${esc(ctx.prefix)}/${area}">התחברות</a>
        <a class="mbp-btn mbp-btn--ghost" href="${join}">עדיין לא הצטרפת? להגשת בקשה</a>
      </div>
    </div>` });
}
export function statusPage(ctx, area, state, note = '') {
  const join = area === 'courier' ? '/pages/join-couriers' : '/pages/join-creators';
  const msg = {
    pending: ['הבקשה שלך בבדיקה', 'קיבלנו את הבקשה ונחזור אליך בהקדם במייל. אין צורך לשלוח שוב.'],
    rejected: ['הבקשה לא אושרה', note || 'אפשר ליצור איתנו קשר לפרטים נוספים.'],
    suspended: ['החשבון מושהה', 'הגישה לאזור האישי הושהתה. לפרטים צרו קשר.'],
    none: ['לא מצאנו בקשה על האימייל הזה', 'כדי לקבל גישה יש להגיש בקשת הצטרפות. אם כבר הגשת – ודא/י שהתחברת עם אותו אימייל.'],
  }[state];
  return layout(ctx, { title: area === 'courier' ? 'אזור השליחים' : 'אזור היוצרים', body: `
    <div class="mbp-card" style="max-width:560px"><h2>${msg[0]}</h2><p>${esc(msg[1])}</p>
    ${state === 'none' ? `<div class="mbp-actions"><a class="mbp-btn" href="${join}">להגשת בקשה</a></div>` : ''}
    ${state !== 'none' ? `<div class="mbp-actions"><a class="mbp-btn mbp-btn--ghost" href="/pages/contact">צור קשר</a></div>` : ''}</div>` });
}

/* ------------------------------ creator ------------------------------ */
export function creatorDashboard(ctx, { creator, stats, remaining, recent, stripe }) {
  const cap = creator.capacity_daily;
  const used = cap ? cap - Math.min(cap, remaining) : 0;
  return layout(ctx, { title: `שלום, ${creator.name}`, nav: 'creator', active: '', body: `
    ${ctx.flash || ''}
    <div class="mbp-kpis" role="list">
      ${[['השבוע', stats.week], ['החודש', stats.month], ['6 חודשים', stats.sixmo], ['מתחילת השנה', stats.ytd]].map(([l, v]) =>
        `<div class="mbp-kpi" role="listitem"><small>${l}</small><b>${ils(v)}</b></div>`).join('')}
    </div>
    <div class="mbp-grid mbp-grid--2" style="margin-top:12px">
      <div class="mbp-col">
        <div class="mbp-card"><h2>הזמנות אחרונות</h2>
          ${recent.length ? `<table class="mbp-table"><thead><tr><th>הזמנה</th><th>תאריך</th><th>עיר</th><th>לך</th></tr></thead><tbody>
            ${recent.map((o) => `<tr><td>${esc(o.order_name)}</td><td>${dt(o.created_at)}</td><td>${esc(o.city)}</td><td class="mbp-num">${ils(o.net_cents)}</td></tr>`).join('')}
          </tbody></table>` : `<div class="mbp-empty"><b>עוד אין הזמנות</b>ברגע שתגיע הזמנה היא תופיע כאן.</div>`}
          <div class="mbp-actions"><a class="mbp-btn mbp-btn--ghost" href="${ctx.prefix}/creator/orders">לכל ההזמנות</a></div>
        </div>
      </div>
      <div class="mbp-col">
        <div class="mbp-card"><h2>יתרה לתשלום</h2><b style="font-size:26px" class="mbp-num">${ils(stats.owed)}</b>
          <p class="mbp-help">סה"כ הכנסות: ${ils(stats.total)} · ${stats.orders} הזמנות</p>
          ${stripe.enabled ? (stripe.connected && stripe.payouts_enabled
            ? '<p class="mbp-help"><span class="mbp-badge mbp-badge--ok">חשבון תשלומים מחובר</span></p>'
            : `<div class="mbp-actions"><button class="mbp-btn" data-action="creator/stripe">${stripe.connected ? 'השלמת פרטי תשלום' : 'חיבור חשבון לקבלת תשלומים'}</button></div>`) : ''}
        </div>
        <div class="mbp-card"><h2>קיבולת להיום</h2>
          ${cap ? `<p>${used} מתוך ${cap} הזמנות</p><div class="mbp-progress" aria-hidden="true"><span style="width:${Math.min(100, Math.round(used / cap * 100))}%"></span></div>
          <p class="mbp-help">${remaining > 0 ? 'המוצרים שלך זמינים להזמנה.' : 'הגעת לקיבולת היומית – המוצרים יחזרו להיות זמינים מחר.'}</p>`
          : '<p class="mbp-help">לא הוגדרה מגבלה יומית. אפשר להגדיר ב"החנות שלי".</p>'}
        </div>
        <div class="mbp-card"><h2>המוצרים שלי</h2>
          <p>${stats.live} פעילים · ${stats.pending} ממתינים לאישור${stats.rejected ? ' · ' + stats.rejected + ' נדחו' : ''}</p>
          <div class="mbp-actions"><a class="mbp-btn" href="${ctx.prefix}/creator/products/new">+ מוצר חדש</a>
          <a class="mbp-btn mbp-btn--ghost" href="/collections/vendors?q=${encodeURIComponent(creator.vendor)}">צפייה בחנות שלי</a></div>
        </div>
      </div>
    </div>` });
}

export function creatorProducts(ctx, { products }) {
  return layout(ctx, { title: 'המוצרים שלי', nav: 'creator', active: '/products', body: `
    <div class="mbp-card">
      <div class="mbp-actions" style="margin:0 0 12px"><a class="mbp-btn" href="${ctx.prefix}/creator/products/new">+ הוספת מוצר</a></div>
      ${products.length ? `<ul class="mbp-list">${products.map((p) => `
        <li><img class="mbp-thumb" src="${esc(p.image_url || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="mbp-grow"><b>${esc(p.title)}</b><span class="mbp-muted">המחיר שלך ${ilsAmount(p.creator_price)} · באתר ${ilsAmount(p.list_price)}</span>
          ${p.status === 'rejected' && p.reject_reason ? `<div class="mbp-muted">סיבה: ${esc(p.reject_reason)}</div>` : ''}</div>
          <div style="display:grid;gap:6px;justify-items:end">${badge(PRODUCT_STATUS, p.status)}
          <a class="mbp-muted" href="${ctx.prefix}/creator/products/${p.id}">עריכה</a></div></li>`).join('')}</ul>`
        : `<div class="mbp-empty"><b>עוד אין מוצרים</b>הוסיפו את המוצר הראשון – אחרי אישור קצר הוא יעלה לחנות.</div>`}
    </div>` });
}

export function productEditor(ctx, { product, media, settings }) {
  const d = product?.data || {};
  const opt = d.option && d.option.values?.length ? d.option : null;
  const status = product ? `<div class="mbp-card"><h2>סטטוס</h2>${badge(PRODUCT_STATUS, product.status)}
      ${product.status === 'rejected' && product.reject_reason ? `<p class="mbp-help">סיבת הדחייה: ${esc(product.reject_reason)}. אפשר לתקן ולשמור – המוצר יחזור לבדיקה.</p>` : ''}
      ${['approved', 'edited'].includes(product.status) ? '<p class="mbp-help">שינויים נשמרים מיד באתר ונבדקים על ידינו.</p>' : ''}
      ${product.status === 'pending' ? `<p class="mbp-help">המוצר יעלה לחנות אחרי אישור (בדרך כלל תוך ${esc(settings.review_days)} ימי עסקים).</p>` : ''}</div>`
    : `<div class="mbp-card"><h2>סטטוס</h2><p class="mbp-help">אחרי השמירה המוצר יישלח לאישור ויעלה לחנות לאחר שנאשר אותו.</p></div>`;
  return layout(ctx, {
    title: product ? 'עריכת מוצר' : 'מוצר חדש', nav: 'creator', active: product ? '/products' : '/products/new',
    data: { uplift: settings.uplift_ils, commission: ctx.commission },
    body: `
    <form id="mbp-product" ${product ? `data-id="${product.id}"` : ''} novalidate>
      <div class="mbp-grid mbp-grid--2">
        <div class="mbp-col">
          <div class="mbp-card">
            <div class="mbp-field"><label class="mbp-label" for="mbp-title">שם המוצר</label>
              <input class="mbp-in" id="mbp-title" name="title" required maxlength="120" value="${esc(product?.title || '')}" placeholder="למשל: זר אדמוניות ורודות"></div>
            <div class="mbp-field" style="margin:0"><label class="mbp-label" for="mbp-desc">תיאור</label>
              <textarea id="mbp-desc" name="description" placeholder="מה בזר, גודל, איך לשמור עליו...">${esc(d.description || '')}</textarea></div>
          </div>
          <div class="mbp-card mbp-media"><h2>מדיה</h2>
            <div class="mbp-media__grid"></div>
            <p class="mbp-help">תמונות JPG או PNG, רצוי מרובעות. התמונה הראשונה היא הראשית.</p>
            <script type="application/json" id="mbp-media-data">${JSON.stringify((media || []).map((u) => ({ url: u }))).replace(/</g, '\\u003c')}</script>
          </div>
          <div class="mbp-card"><h2>תמחור</h2>
            <div class="mbp-single-price"><div class="mbp-row">
              <div class="mbp-field"><label class="mbp-label" for="mbp-price">המחיר שלך (₪)</label>
                <input class="mbp-in" id="mbp-price" name="price" type="number" min="0" step="1" inputmode="decimal" value="${esc(d.price ?? product?.creator_price ?? '')}"></div>
              <div class="mbp-field"><label class="mbp-label" for="mbp-cmp">מחיר לפני הנחה (רשות)</label>
                <input class="mbp-in" id="mbp-cmp" name="compareAt" type="number" min="0" step="1" inputmode="decimal" value="${esc(d.compareAt ?? '')}"></div>
            </div></div>
            <p class="mbp-price-preview" aria-live="polite"></p>
          </div>
          <div class="mbp-card"><h2>אפשרויות</h2>
            <label class="mbp-check"><input type="checkbox" id="mbp-has-option" ${opt ? 'checked' : ''}> למוצר יש אפשרויות כמו גודל או כמות פרחים</label>
            <div class="mbp-options" hidden>
              <div class="mbp-field"><label class="mbp-label" for="mbp-optname">שם האפשרות</label>
                <input class="mbp-in" id="mbp-optname" name="optName" value="${esc(opt?.name || 'גודל')}"></div>
              <div class="mbp-opt-rows">${(opt?.values || []).map((v) => `<div class="mbp-opt-row">
                <input class="mbp-in" name="ov" value="${esc(v.name)}" aria-label="ערך"><input class="mbp-in" name="op" type="number" min="0" step="1" value="${esc(v.price)}" aria-label="מחיר">
                <input class="mbp-in" name="oc" type="number" min="0" step="1" value="${esc(v.compareAt || '')}" aria-label="מחיר לפני הנחה">
                <button type="button" class="mbp-icon-btn" data-del aria-label="מחיקת שורה">×</button></div>`).join('')}</div>
              <button type="button" class="mbp-btn mbp-btn--ghost" data-add-row>+ הוספת ערך</button>
            </div>
          </div>
        </div>
        <div class="mbp-col">
          ${status}
          <div class="mbp-card"><h2>ארגון המוצר</h2>
            <div class="mbp-field"><label class="mbp-label" for="mbp-cat">קטגוריה</label>
              <select id="mbp-cat" name="category">${CATEGORIES.map((c) => `<option${(d.category || '') === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
            <div class="mbp-field" style="margin:0"><label class="mbp-label" for="mbp-tags">תגיות</label>
              <input class="mbp-in" id="mbp-tags" name="tags" value="${esc((d.tags || []).join(', '))}" placeholder="ורדים, יום הולדת">
              <p class="mbp-help">מופרדות בפסיק. עוזרות ללקוחות למצוא את המוצר.</p></div>
          </div>
        </div>
      </div>
      <div class="mbp-savebar">
        ${product && product.status !== 'hidden' ? '<button type="button" class="mbp-btn mbp-btn--danger" data-archive>הסרה מהחנות</button>' : '<span></span>'}
        <button type="submit" class="mbp-btn" data-save>שמירה</button>
      </div>
    </form>` });
}

export function creatorOrders(ctx, { orders }) {
  return layout(ctx, { title: 'הזמנות', nav: 'creator', active: '/orders', body: `
    <div class="mbp-card">${orders.length ? `<table class="mbp-table"><thead><tr><th>הזמנה</th><th>פריטים</th><th>עיר</th><th>משלוח</th><th>לך</th></tr></thead><tbody>
      ${orders.map((o) => `<tr><td>${esc(o.order_name)}<div class="mbp-muted">${dt(o.created_at)}</div></td>
        <td>${o.items.map((i) => `${esc(i.title)}${i.variant && i.variant !== 'Default Title' ? ' · ' + esc(i.variant) : ''} ×${i.qty}`).join('<br>')}</td>
        <td>${esc(o.city)}</td><td>${badge(DELIVERY_STATUS, o.delivery_status || 'unassigned')}</td>
        <td class="mbp-num">${ils(o.net_cents)}${o.paid_out ? '<div class="mbp-muted">שולם</div>' : ''}</td></tr>`).join('')}
    </tbody></table>` : `<div class="mbp-empty"><b>עוד אין הזמנות</b></div>`}</div>` });
}

export function creatorProfile(ctx, { creator, cities, stripe }) {
  return layout(ctx, { title: 'החנות שלי', nav: 'creator', active: '/profile', body: `
    <form class="mbp-grid mbp-grid--2" data-api="creator/profile">
      <div class="mbp-col">
        <div class="mbp-card"><h2>פרטי החנות</h2>
          <div class="mbp-field" style="display:flex;gap:14px;align-items:center">
            <img class="mbp-logo" src="${esc(creator.logo_url || '')}" alt="" onerror="this.style.visibility='hidden'">
            <div><label class="mbp-label" for="mbp-logo">לוגו</label><input id="mbp-logo" type="file" accept="image/*" data-logo></div></div>
          <div class="mbp-field"><label class="mbp-label">שם החנות</label><input class="mbp-in" value="${esc(creator.name)}" disabled>
            <p class="mbp-help">לשינוי שם החנות צרו קשר – השם מופיע על כל המוצרים.</p></div>
          <div class="mbp-field"><label class="mbp-label" for="mbp-city">עיר</label>
            <select id="mbp-city" name="city">${cities.map((c) => `<option${c === creator.city ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
          <div class="mbp-field"><label class="mbp-label" for="mbp-bio">כמה מילים עליך</label>
            <textarea id="mbp-bio" name="bio" maxlength="600">${esc(creator.bio || '')}</textarea></div>
          <div class="mbp-field" style="margin:0"><label class="mbp-label" for="mbp-ig">אינסטגרם או אתר</label>
            <input class="mbp-in" id="mbp-ig" name="instagram" value="${esc(creator.instagram || '')}" dir="ltr"></div>
        </div>
      </div>
      <div class="mbp-col">
        <div class="mbp-card"><h2>קיבולת יומית</h2>
          <label class="mbp-label" for="mbp-cap">כמה הזמנות אפשר להכין ביום?</label>
          <input class="mbp-in" id="mbp-cap" name="capacity_daily" type="number" min="0" max="500" value="${esc(creator.capacity_daily || 0)}">
          <p class="mbp-help">כשמגיעים למספר הזה, המוצרים מסומנים "אזל" עד מחר. 0 = ללא הגבלה.</p></div>
        <div class="mbp-card"><h2>הקישור לחנות שלך</h2>
          <p class="mbp-help">אפשר לשתף ברשתות החברתיות:</p>
          <input class="mbp-in" dir="ltr" readonly value="https://${esc(ctx.shopDomain)}/collections/vendors?q=${encodeURIComponent(creator.vendor)}" onclick="this.select()"></div>
        ${stripe.enabled ? `<div class="mbp-card"><h2>קבלת תשלומים</h2>${stripe.connected && stripe.payouts_enabled
          ? '<span class="mbp-badge mbp-badge--ok">מחובר</span>'
          : `<button type="button" class="mbp-btn" data-action="creator/stripe">${stripe.connected ? 'השלמת פרטים' : 'חיבור חשבון'}</button>`}</div>` : ''}
        <button type="submit" class="mbp-btn mbp-btn--block">שמירה</button>
      </div>
    </form>` });
}

/* ------------------------------ courier ------------------------------ */
function deliveryCard(ctx, d, actions = true) {
  const a = d.address || {};
  const addr = [a.address1, a.address2, a.city].filter(Boolean).join(', ');
  const waze = 'https://waze.com/ul?navigate=yes&q=' + encodeURIComponent(addr);
  const act = (status, label, cls = '', confirm = '') =>
    `<button class="mbp-btn ${cls}" data-action="courier/deliveries/${d.id}" data-body='{"status":"${status}"}'${confirm ? ` data-confirm="${esc(confirm)}"` : ''}>${label}</button>`;
  return `<article class="mbp-delivery">
    <div class="mbp-delivery__head"><b>${esc(d.order_name)} · ${esc(d.city)}</b>${badge(DELIVERY_STATUS, d.status)}</div>
    ${d.deliver_on ? `<div><b>לביצוע ב-<span class="mbp-num">${esc(d.deliver_on.split('-').reverse().join('/'))}</span></b></div>` : ''}
    <div>${esc(d.customer_name)}${d.phone ? ` · <a href="tel:${esc(d.phone)}" class="mbp-num">${esc(d.phone)}</a>` : ''}</div>
    <div class="mbp-muted">${esc(addr)}</div>
    ${d.note ? `<div class="mbp-muted">הערה: ${esc(d.note)}</div>` : ''}
    ${d.pickups?.length ? `<div class="mbp-muted">איסוף מ: ${d.pickups.map((p) => esc(p.name + (p.city ? ' (' + p.city + ')' : '') + (p.phone ? ' ' + p.phone : ''))).join(' · ')}</div>` : ''}
    <div class="mbp-muted">תשלום למשלוח: <span class="mbp-num">${ils(d.fee_cents)}</span></div>
    ${actions ? `<div class="mbp-actions">
      <a class="mbp-btn mbp-btn--ghost" href="${waze}" target="_blank" rel="noopener">ניווט ב-Waze</a>
      ${d.status === 'assigned' || d.status === 'failed' ? act('picked_up', 'נאסף') : ''}
      ${d.status === 'picked_up' ? act('delivered', 'נמסר ללקוח', '', 'לאשר שהמשלוח נמסר?') : ''}
      ${['assigned', 'picked_up'].includes(d.status) ? act('failed', 'בעיה', 'mbp-btn--danger', 'לסמן בעיה במסירה?') : ''}
    </div>` : `<div class="mbp-muted">${dt(d.delivered_at || d.created_at)}${d.paid_out ? ' · שולם' : ''}</div>`}
  </article>`;
}
export function courierDashboard(ctx, { courier, open, stats, stripe }) {
  return layout(ctx, { title: `שלום, ${courier.name}`, nav: 'courier', active: '', body: `
    <div class="mbp-kpis">
      <div class="mbp-kpi"><small>משלוחים פתוחים</small><b>${open.length}</b></div>
      <div class="mbp-kpi"><small>נמסרו היום</small><b>${stats.today}</b></div>
      <div class="mbp-kpi"><small>נמסרו החודש</small><b>${stats.month}</b></div>
      <div class="mbp-kpi"><small>יתרה לתשלום</small><b>${ils(stats.owed)}</b></div>
    </div>
    <div class="mbp-grid mbp-grid--2" style="margin-top:12px">
      <div class="mbp-col"><div class="mbp-card"><h2>משלוחים שלי</h2>
        ${open.length ? open.map((d) => deliveryCard(ctx, d)).join('') : `<div class="mbp-empty"><b>אין משלוחים פתוחים</b>משלוחים חדשים באזורים שלך יופיעו כאן.</div>`}
      </div></div>
      <div class="mbp-col">
        <div class="mbp-card"><h2>האזורים שלי</h2><p>${(courier.areas || []).map(esc).join(', ') || 'לא הוגדרו'}</p>
          <a class="mbp-btn mbp-btn--ghost" href="${ctx.prefix}/courier/profile">עדכון</a></div>
        ${stripe.enabled ? `<div class="mbp-card"><h2>קבלת תשלומים</h2>${stripe.connected && stripe.payouts_enabled
          ? '<span class="mbp-badge mbp-badge--ok">מחובר</span>'
          : `<button class="mbp-btn" data-action="courier/stripe">${stripe.connected ? 'השלמת פרטים' : 'חיבור חשבון'}</button>`}</div>` : ''}
      </div>
    </div>` });
}
export function courierHistory(ctx, { done }) {
  return layout(ctx, { title: 'היסטוריית משלוחים', nav: 'courier', active: '/history', body: `
    <div class="mbp-card">${done.length ? done.map((d) => deliveryCard(ctx, d, false)).join('') : '<div class="mbp-empty"><b>עוד אין משלוחים שנמסרו</b></div>'}</div>` });
}
export function courierProfile(ctx, { courier, cities }) {
  const av = courier.availability || {};
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  return layout(ctx, { title: 'הפרופיל שלי', nav: 'courier', active: '/profile', body: `
    <form class="mbp-grid mbp-grid--2" data-api="courier/profile">
      <div class="mbp-col"><div class="mbp-card"><h2>אזורי חלוקה</h2>
        <input class="mbp-in" placeholder="חיפוש עיר" data-filter-for="mbp-areas" style="margin-bottom:8px">
        <div class="mbp-checks" id="mbp-areas">${cities.map((c) => `<label class="mbp-check"><input type="checkbox" name="areas" value="${esc(c)}" data-multi${(courier.areas || []).includes(c) ? ' checked' : ''}> ${esc(c)}</label>`).join('')}</div>
      </div></div>
      <div class="mbp-col"><div class="mbp-card"><h2>זמינות</h2>
        <div class="mbp-checks" style="max-height:none">${days.map((d) => `<label class="mbp-check"><input type="checkbox" name="days" value="${d}" data-multi${(av.days || []).includes(d) ? ' checked' : ''}> ${d}</label>`).join('')}</div>
        <div class="mbp-row" style="margin-top:10px"><div><label class="mbp-label" for="mbp-from">משעה</label><input class="mbp-in" id="mbp-from" type="time" name="from" value="${esc(av.from || '')}"></div>
        <div><label class="mbp-label" for="mbp-to">עד שעה</label><input class="mbp-in" id="mbp-to" type="time" name="to" value="${esc(av.to || '')}"></div></div>
        <div class="mbp-field" style="margin-top:10px"><label class="mbp-label" for="mbp-phone">טלפון</label><input class="mbp-in" id="mbp-phone" name="phone" dir="ltr" value="${esc(courier.phone || '')}"></div>
      </div><button type="submit" class="mbp-btn mbp-btn--block">שמירה</button></div>
    </form>` });
}
