(function () {
  'use strict';

  /* ---------- Konstanta & state ---------- */
  var LS_TOKEN = 'kk_token', LS_KAS = 'kk_kas';
  var COLORS = ['#14B8A6', '#8B7CF6', '#FF8A5B', '#F5C542', '#4DA3FF', '#F472B6', '#34D399', '#A78BFA', '#FB7185'];
  var BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var ICON = { Pemasukan: '↓', Pengeluaran: '↑', Transfer: '⇄' };
  var IC_EDIT = '<svg class="ico" viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
  var IC_STOP = '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/></svg>';
  var IC_DEL ='<svg class="ico" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  var nf = new Intl.NumberFormat('id-ID');
  var editTrxId = null, editBillId = null, editDepId = null;
  var state = { token: null, user: null, kasList: [], kasId: null, config: null, preset: 'month', dari: '', sampai: '', halaman: 1, dash: null, chart: null, mode: 'login' };
  var busyCount = 0, toastTimer = null;

  /* ---------- Helper ---------- */
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function rp(n) { return 'Rp ' + nf.format(Math.round(n || 0)); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ym(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function today() { var d = new Date(); return ym(d) + '-' + pad(d.getDate()); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shortDate(iso) { var p = iso.split('-'); return Number(p[2]) + ' ' + BULAN[Number(p[1]) - 1]; }
  function show(el, on) { el.classList.toggle('hidden', !on); }
  function setErr(sel, msg) { var el = $(sel); el.textContent = msg || ''; show(el, !!msg); }
  function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function busy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    show($('#busy'), busyCount > 0);
  }
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /** Panggil fungsi backend lewat POST /api/rpc. Backend mengembalikan {ok, data|error}. */
  function api(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args })
    }).then(function (r) {
      return r.json().catch(function () { throw new Error('Respon server tidak valid (' + r.status + ').'); });
    }).then(function (res) {
      if (res && res.ok) return res.data;
      throw new Error((res && res.error) || 'Respon kosong dari server.');
    }, function (err) {
      if (err && err.name === 'TypeError') throw new Error('Gagal terhubung ke server.');
      throw err;
    });
  }
  function call(fn) { // api + overlay loading
    busy(true);
    return api.apply(null, arguments).then(
      function (d) { busy(false); return d; },
      function (e) { busy(false); throw e; }
    );
  }

  function openSheet(id) { show($(id), true); document.body.style.overflow = 'hidden'; }
  function closeSheets() { $$('.backdrop').forEach(function (b) { show(b, false); }); document.body.style.overflow = ''; }

  /* ---------- Auth ---------- */
  function setMode(mode) {
    state.mode = mode;
    $$('.tab[data-mode]').forEach(function (t) { t.classList.toggle('active', t.dataset.mode === mode); });
    show($('#nameField'), mode === 'signup');
    $('#fNama').required = mode === 'signup';
    $('#authBtn').textContent = mode === 'signup' ? 'Buat Akun' : 'Masuk';
    $('#fPin').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    setErr('#authErr', '');
  }

  function onAuthSubmit(e) {
    e.preventDefault();
    setErr('#authErr', '');
    var email = $('#fEmail').value, pin = $('#fPin').value;
    var p = state.mode === 'signup' ? call('apiSignUp', $('#fNama').value, email, pin) : call('apiLogin', email, pin);
    p.then(function (res) {
      state.token = res.token;
      store(LS_TOKEN, res.token);
      $('#fPin').value = '';
      return boot();
    }).catch(function (err) { setErr('#authErr', err.message); });
  }

  function logout() {
    store(LS_TOKEN, null); store(LS_KAS, null);
    state.token = null; state.user = null; state.kasId = null;
    closeSheets();
    show($('#appView'), false); show($('#authView'), true);
  }

  /* ---------- Boot ---------- */
  function boot() {
    return call('apiBootstrap', state.token).then(function (d) {
      state.user = d.user; state.kasList = d.kasList; state.config = d.config;
      var saved = load(LS_KAS);
      var found = d.kasList.filter(function (k) { return k.id === saved; })[0] || d.kasList[0];
      state.kasId = found ? found.id : null;
      buildForm();
      show($('#authView'), false); show($('#appView'), true);
      setTab('home');
      return refresh();
    }).catch(function (err) {
      logout();
      setErr('#authErr', err.message);
    });
  }

  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /** Preset dihitung ulang tiap muat data agar tetap benar bila aplikasi dibiarkan terbuka berhari-hari. */
  function applyPreset(p) {
    var now = new Date(), a = '', b = '';
    if (p === 'month') {
      a = ym(now) + '-01';
      b = isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (p === 'week') { // Senin - Minggu
      var dow = (now.getDay() + 6) % 7;
      var s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
      a = isoDate(s);
      b = isoDate(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6));
    }
    state.dari = a; state.sampai = b;
  }

  /** Ambil data dashboard untuk periode & halaman yang sedang aktif. */
  function fetchDash() {
    if (state.preset !== 'custom') applyPreset(state.preset);
    return call('apiGetDashboard', state.token, state.kasId, state.dari, state.sampai, state.halaman).then(function (d) {
      state.halaman = d.halaman;
      return d;
    });
  }

  function refresh() {
    if (!state.kasId) return Promise.resolve();
    store(LS_KAS, state.kasId);
    return fetchDash().then(function (d) {
      state.dash = d; render();
    }).catch(function (err) { toast(err.message); });
  }

  /* ---------- Periode (rentang tanggal) ---------- */
  function periodLabel() {
    if (state.preset === 'month') return 'Bulan ini';
    if (state.preset === 'week') return 'Minggu ini';
    if (state.preset === 'all' || (!state.dari && !state.sampai)) return 'Semua waktu';
    if (state.dari && state.sampai) {
      if (state.dari === state.sampai) return longDate(state.dari);
      var a = state.dari.split('-'), b = state.sampai.split('-');
      return a[0] === b[0] ? shortDate(state.dari) + ' – ' + shortDate(state.sampai) + ' ' + b[0] : shortDate(state.dari) + ' ' + a[0] + ' – ' + shortDate(state.sampai) + ' ' + b[0];
    }
    return state.dari ? 'Sejak ' + longDate(state.dari) : 'Hingga ' + longDate(state.sampai);
  }

  function renderPeriod() {
    var t = periodLabel();
    $$('.period-label').forEach(function (el) { el.textContent = t; });
  }

  function openPeriod() {
    $('#pDari').value = state.dari; $('#pSampai').value = state.sampai;
    $$('.preset').forEach(function (b) { b.classList.toggle('active', b.dataset.preset === state.preset); });
    setErr('#periodErr', '');
    openSheet('#sheetPeriod');
  }

  function setPreset(p) {
    state.preset = p; state.halaman = 1;
    if (p === 'all') { state.dari = ''; state.sampai = ''; }
    closeSheets();
    refresh();
  }

  function onPeriodSubmit(e) {
    e.preventDefault();
    var a = $('#pDari').value, b = $('#pSampai').value;
    if (!a && !b) { setPreset('all'); return; }
    if (a && b && a > b) { setErr('#periodErr', 'Tanggal "Dari" tidak boleh setelah "Sampai".'); return; }
    state.preset = 'custom'; state.dari = a; state.sampai = b; state.halaman = 1;
    closeSheets();
    refresh();
  }

  function gotoPage(n) { state.halaman = n; refresh(); }

  /* ---------- Render ---------- */
  function currentKas() { return state.kasList.filter(function (k) { return k.id === state.kasId; })[0] || {}; }

  function render() {
    var d = state.dash, isAdmin = d.role === 'Admin';
    var first = state.user.nama.trim().split(/\s+/)[0];
    $('#greet').textContent = 'Halo, ' + first + '!';
    $('#avatar').textContent = first.charAt(0).toUpperCase();
    $('#kasName').textContent = currentKas().nama || '-';
    $('#roleBadge').textContent = d.role;
    renderPeriod();

    var saldo = $('#saldo');
    saldo.textContent = rp(d.balance);
    saldo.classList.toggle('neg', d.balance < 0);
    $('#income').textContent = rp(d.income);
    $('#expense').textContent = rp(d.expense);

    show($('#btnAddTrx'), isAdmin); show($('#btnAddTrx2'), isAdmin); show($('#btnAddCollab'), isAdmin); show($('#viewerNote'), !isAdmin);
    $('.actions').style.gridTemplateColumns = isAdmin ? '1fr 1fr' : '1fr';

    renderChart(d);
    renderRecent(d, isAdmin);
    renderWallets(d, isAdmin);
    renderBills(d, isAdmin);
    renderDeposito(d, isAdmin);
    refreshOptions();
    show($('#setCard'), isAdmin);
  }

  function renderChart(d) {
    var has = d.byCategory.length > 0;
    show($('#chartEmpty'), !has);
    $('#donut').style.visibility = has ? 'visible' : 'hidden';
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    $('#legend').innerHTML = '';
    if (!has) return;

    if (window.Chart) {
      state.chart = new Chart($('#donut').getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: d.byCategory.map(function (c) { return c.kategori; }),
          datasets: [{ data: d.byCategory.map(function (c) { return c.total; }), backgroundColor: COLORS, borderWidth: 3, borderColor: '#fff', hoverOffset: 6 }]
        },
        options: {
          cutout: '66%', maintainAspectRatio: false, animation: { duration: 500 },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return ' ' + c.label + ': ' + rp(c.parsed); } } } }
        }
      });
    }
    $('#legend').innerHTML = d.byCategory.map(function (c, i) {
      var pct = d.expense ? Math.round((c.total / d.expense) * 100) : 0;
      return '<li><i style="background:' + COLORS[i % COLORS.length] + '"></i><span>' + esc(c.kategori) + '</span><b>' + rp(c.total) + '</b><em>' + pct + '%</em></li>';
    }).join('');
  }

  function renderRecent(d, isAdmin) {
    var ul = $('#recent');
    show($('#pager'), d.totalHalaman > 1);
    $('#pagerInfo').textContent = 'Halaman ' + d.halaman + ' dari ' + d.totalHalaman + ' · ' + d.totalTrx + ' transaksi';
    $('#pagePrev').disabled = d.halaman <= 1;
    $('#pageNext').disabled = d.halaman >= d.totalHalaman;
    if (!d.recent.length) { ul.innerHTML = '<li class="empty-list">Belum ada transaksi di periode ini.</li>'; return; }
    ul.innerHTML = d.recent.map(function (t) {
      var sign = t.jenis === 'Pemasukan' ? '+' : t.jenis === 'Pengeluaran' ? '−' : '';
      var r = t.rincian;
      return '<li class="trx">' +
        '<span class="dot t-' + t.jenis + '">' + ICON[t.jenis] + '</span>' +
        '<div class="trx-main"' + (r ? ' data-rinc' : '') + '><b>' + esc(t.nama) + '</b><small>' + esc(t.kategori) + ' · ' + esc(t.dompet) + ' · ' + shortDate(t.tanggal) + ' · ' + esc(t.oleh) + (r ? ' · ' + r.items.length + ' barang ▾' : '') + '</small></div>' +
        '<div class="trx-amt amt-' + t.jenis + '">' + sign + rp(t.nominal) + '</div>' +
        (isAdmin ? '<span class="row-actions"><button class="icon-btn" type="button" data-act="edit" data-id="' + esc(t.id) + '" aria-label="Edit">' + IC_EDIT + '</button>' +
          '<button class="icon-btn del" type="button" data-act="del" data-id="' + esc(t.id) + '" aria-label="Hapus">' + IC_DEL + '</button></span>' : '') +
        (r ? '<div class="trx-detail hidden">' + rincDetail(r) + '</div>' : '') +
        '</li>';
    }).join('');
  }

  function fmtQty(q) { return String(q).replace('.', ','); }

  /** Isi panel detail di daftar transaksi: barang, diskon, pajak, total. */
  function rincDetail(r) {
    var sub = 0;
    var h = r.items.map(function (it) {
      var line = Math.round(it.harga * it.qty) - it.diskon;
      sub += line;
      return '<div><span class="l">' + esc(it.nama) + '<small>' + fmtQty(it.qty) + ' × ' + rp(it.harga) + (it.diskon ? ' − diskon ' + rp(it.diskon) : '') + '</small></span><span class="r">' + rp(line) + '</span></div>';
    }).join('');
    if (r.pajak && r.pajak.nominal > 0) {
      h += '<div><span class="l">PPN' + (r.pajak.termasuk ? ' (sudah termasuk)' : '') + '</span><span class="r">' + (r.pajak.termasuk ? '' : '+') + rp(r.pajak.nominal) + '</span></div>';
      if (!r.pajak.termasuk) sub += r.pajak.nominal;
    }
    return h + '<div class="tot"><span class="l">Total</span><span class="r">' + rp(sub) + '</span></div>';
  }

  /** Konfirmasi dua langkah: ketukan pertama menampilkan "Yakin?". */
  function armDelete(btn) {
    btn.classList.add('confirm'); btn.textContent = 'Yakin?';
    setTimeout(function () { btn.classList.remove('confirm'); btn.innerHTML = IC_DEL; }, 3000);
  }

  function onRecentClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) {
      var main = e.target.closest('[data-rinc]');
      if (main) main.closest('.trx').querySelector('.trx-detail').classList.toggle('hidden');
      return;
    }
    if (btn.dataset.act === 'edit') {
      var t = state.dash.recent.filter(function (x) { return x.id === btn.dataset.id; })[0];
      if (t) openTrxForm(t);
      return;
    }
    if (!btn.classList.contains('confirm')) { armDelete(btn); return; }
    call('apiDeleteTransaction', state.token, state.kasId, btn.dataset.id)
      .then(function () { toast('Transaksi dihapus'); return refresh(); })
      .catch(function (err) { toast(err.message); });
  }

  /* ---------- Tab & Dompet ---------- */
  function setTab(name) {
    ['home', 'trx', 'bill', 'dep', 'wallet'].forEach(function (t) { show($('#tab-' + t), t === name); });
    $$('.tabbtn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    window.scrollTo(0, 0);
  }

  function renderWallets(d, isAdmin) {
    var total = $('#walletTotal');
    total.textContent = rp(d.balance);
    total.classList.toggle('neg', d.balance < 0);
    show($('#walletHint'), isAdmin);
    $('#walletBlocked').textContent = rp(d.deposito.ringkas.terblokir);
    $('#walletList').innerHTML = d.wallets.map(function (w) {
      return '<li class="wallet-item' + (isAdmin ? ' tap' : '') + '" data-d="' + esc(w.dompet) + '" data-awal="' + w.saldoAwal + '">' +
        '<div><b>' + esc(w.dompet) + '</b><small>Saldo awal ' + rp(w.saldoAwal) + '</small></div>' +
        '<span class="w-amt' + (w.saldo < 0 ? ' neg' : '') + '">' + rp(w.saldo) + '</span></li>';
    }).join('');
  }

  function onWalletPick(e) {
    var li = e.target.closest('.wallet-item');
    if (!li || !state.dash || state.dash.role !== 'Admin') return;
    var awal = Number(li.dataset.awal) || 0;
    $('#wName').value = li.dataset.d;
    $('#wSign').value = awal < 0 ? '-1' : '1';
    $('#wNominal').value = awal ? nf.format(Math.abs(awal)) : '';
    setErr('#walletErr', '');
    openSheet('#sheetWallet');
  }

  function onWalletSubmit(e) {
    e.preventDefault();
    setErr('#walletErr', '');
    var n = Number($('#wNominal').value.replace(/\D/g, '')) || 0;
    var value = n ? Number($('#wSign').value) * n : 0;
    call('apiSetSaldoAwal', state.token, state.kasId, $('#wName').value, value).then(function () {
      closeSheets(); toast('Saldo awal tersimpan ✓');
      return refresh();
    }).catch(function (err) { setErr('#walletErr', err.message); });
  }

  /* ---------- Tagihan & Cicilan ---------- */
  function dueLabel(t) {
    if (t.selisihHari < 0) return { text: 'Terlambat ' + (-t.selisihHari) + ' hari', cls: 'late' };
    if (t.selisihHari === 0) return { text: 'Hari ini', cls: 'late' };
    if (t.selisihHari <= 3) return { text: 'H-' + t.selisihHari, cls: 'soon' };
    return { text: shortDate(t.jatuhTempo), cls: '' };
  }

  function perBulan(t) { return t.siklus === 'Tahunan' ? t.nominal / 12 : t.nominal; }
  function dueWindow(t) { return t.siklus === 'Tahunan' ? 30 : 14; } // langganan tahunan diingatkan lebih awal

  function renderBills(d, isAdmin) {
    var active = d.tagihan.filter(function (t) { return !t.lunas && !t.berhenti; });

    // Kartu "Jatuh Tempo" di Beranda: terlambat + 14 hari ke depan (tahunan: 30 hari)
    var depDue = d.deposito.list.filter(function (x) { return x.status === 'Aktif' && x.selisihHari <= 14; }).map(function (x) {
      return { nama: 'Deposito ' + x.institusi, pemberi: x.nama, nominal: x.pokok, jatuhTempo: x.jatuhTempo, selisihHari: x.selisihHari };
    });
    var soon = active.filter(function (t) { return t.selisihHari <= dueWindow(t); }).concat(depDue)
      .sort(function (a, b) { return a.selisihHari - b.selisihHari; }).slice(0, 5);
    $('#dueList').innerHTML = soon.length ? soon.map(function (t) {
      var lb = dueLabel(t);
      return '<li class="due-item"><div><b>' + esc(t.nama) + '</b><small>' + esc(t.pemberi ? t.pemberi + ' · ' : '') + shortDate(t.jatuhTempo) + '</small></div>' +
        '<div class="bill-amt">' + rp(t.nominal) + '<br><span class="badge ' + lb.cls + '">' + lb.text + '</span></div></li>';
    }).join('') : '<li class="empty-list">' + ((d.tagihan.length || d.deposito.list.length) ? 'Tidak ada yang jatuh tempo dalam 14 hari ke depan.' : 'Belum ada tagihan atau deposito.') + '</li>';

    // Tab Tagihan
    var nonSub = active.filter(function (t) { return t.jenis !== 'Langganan'; });
    var sub = active.filter(function (t) { return t.jenis === 'Langganan'; });
    $('#billMonthly').textContent = rp(nonSub.reduce(function (s, t) { return s + perBulan(t); }, 0));
    $('#billRemain').textContent = rp(active.reduce(function (s, t) { return s + t.sisaTotal; }, 0));
    $('#billSub').textContent = rp(sub.reduce(function (s, t) { return s + perBulan(t); }, 0));
    show($('#btnAddBill'), isAdmin);

    var groups = [['Cicilan', 'Cicilan'], ['Tagihan Rutin', 'Tagihan Rutin'], ['Langganan', 'Langganan']];
    var html = groups.map(function (g) {
      var items = d.tagihan.filter(function (t) { return t.jenis === g[0]; });
      if (!items.length) return '';
      return '<h4 class="grp">' + g[1] + '</h4><ul class="bill-list">' + items.map(function (t) { return billItem(t, isAdmin); }).join('') + '</ul>';
    }).join('');
    $('#billList').innerHTML = html || '<ul class="bill-list"><li class="empty-list">Belum ada tagihan, cicilan, atau langganan.</li></ul>';
  }

  function billItem(t, isAdmin) {
    var inactive = t.lunas || t.berhenti;
    var lb = inactive ? null : dueLabel(t);
    var tahunan = t.siklus === 'Tahunan';
    var pct = t.tenor > 0 ? Math.min(100, Math.round(t.terbayar / t.tenor * 100)) : 0;
    var meta = t.tenor > 0 ? 'Cicilan ' + t.terbayar + '/' + t.tenor + (t.bunga ? ' · bunga ' + t.bunga + '% ' + String(t.metode || 'Flat').toLowerCase() : '') + ' · sisa ' + rp(t.sisaTotal)
      : t.berhenti ? 'Dihentikan · riwayat pembayaran tetap tersimpan'
      : (t.jenis === 'Langganan' ? 'Langganan' : 'Tagihan rutin') + (tahunan ? ' tahunan' : '') + ' · berikutnya ' + shortDate(t.jatuhTempo) + (tahunan ? ' · setara ' + rp(perBulan(t)) + '/bln' : '');
    var badge = t.lunas ? '<span class="badge">Lunas</span>' : t.berhenti ? '<span class="badge">Berhenti</span>' : '<span class="badge ' + lb.cls + '">' + lb.text + '</span>';
    var when = t.jenis === 'Langganan' && tahunan ? 'tiap tahun tgl ' + t.hari : 'tiap tgl ' + t.hari;
    var acts = '';
    if (isAdmin) {
      acts = '<span class="bill-actions">' +
        (t.berhenti ? '<button class="btn btn-soft sm" type="button" data-act="resume">Aktifkan</button>'
          : t.lunas ? '' : '<button class="btn btn-soft sm" type="button" data-act="pay">Bayar</button>') +
        '<button class="icon-btn" type="button" data-act="edit" aria-label="Edit">' + IC_EDIT + '</button>' +
        (t.jenis === 'Langganan' && !t.berhenti ? '<button class="icon-btn" type="button" data-act="stop" aria-label="Berhenti berlangganan">' + IC_STOP + '</button>' : '') +
        '<button class="icon-btn del" type="button" data-act="del" aria-label="Hapus">' + IC_DEL + '</button></span>';
    }
    return '<li class="bill' + (inactive ? ' done' : '') + '" data-id="' + esc(t.id) + '">' +
      '<div class="bill-top"><div><b>' + esc(t.nama) + '</b><small>' + esc(t.pemberi ? t.pemberi + ' · ' : '') + esc(t.kategori) + ' · ' + when + '</small></div>' +
      '<div class="bill-amt">' + rp(t.nominal) + (tahunan ? '<small class="per">/tahun</small>' : '') + '<br>' + badge + '</div></div>' +
      (t.tenor > 0 ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') +
      '<div class="bill-meta"><span>' + meta + '</span>' + acts + '</div></li>';
  }

  function onBillClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.closest('.bill').dataset.id;
    var t = state.dash.tagihan.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (btn.dataset.act === 'pay') { openPay(t); return; }
    if (btn.dataset.act === 'edit') { openBillForm(t); return; }
    if (btn.dataset.act === 'stop' || btn.dataset.act === 'resume') {
      var stop = btn.dataset.act === 'stop';
      if (stop && !btn.classList.contains('confirm')) { // konfirmasi dua langkah
        btn.classList.add('confirm'); btn.textContent = 'Yakin?';
        setTimeout(function () { btn.classList.remove('confirm'); btn.innerHTML = IC_STOP; }, 3000);
        return;
      }
      call('apiSetStatusTagihan', state.token, state.kasId, id, stop)
        .then(function () { toast(stop ? 'Langganan dihentikan' : 'Langganan diaktifkan kembali ✓'); return refresh(); })
        .catch(function (err) { toast(err.message); });
      return;
    }
    if (!btn.classList.contains('confirm')) { armDelete(btn); return; }
    call('apiDeleteTagihan', state.token, state.kasId, id)
      .then(function () { toast('Tagihan dihapus'); return refresh(); })
      .catch(function (err) { toast(err.message); });
  }

  function openBillForm(t) {
    var edit = t && t.id;
    editBillId = edit ? t.id : null;
    $('#billForm').reset();
    nominalManual = !!edit; // saat edit, nominal tersimpan dipertahankan (tidak ditimpa hitungan)
    $('#billTitle').textContent = edit ? 'Edit Tagihan / Cicilan' : 'Tambah Tagihan / Cicilan';
    $('#billBtn').textContent = edit ? 'Simpan Perubahan' : 'Simpan';
    if (edit) {
      $('#bJenis').value = t.jenis; $('#bNama').value = t.nama; $('#bPemberi').value = t.pemberi || '';
      $('#bNominal').value = nf.format(t.nominal); $('#bHari').value = t.hari;
      $('#bMulai').value = t.next || ym(new Date());
      $('#bTenor').value = t.tenor || ''; $('#bAwal').value = t.awal || ''; ensureOption($('#bDompet'), t.dompet); $('#bDompet').value = t.dompet;
      $('#bTotal').value = t.tenor > 0 ? nf.format(t.pokok || t.nominal * t.tenor) : '';
      $('#bBunga').value = t.bunga ? String(t.bunga).replace('.', ',') : '';
      $('#bMetode').value = t.metode || 'Flat';
      $('#bSiklus').value = t.siklus || 'Bulanan';
      onBillJenis();
      ensureOption($('#bKategori'), t.kategori); $('#bKategori').value = t.kategori || defaultKategori(t.jenis);
    } else {
      $('#bJenis').value = 'Cicilan';
      $('#bMulai').value = ym(new Date());
      onBillJenis();
    }
    setErr('#billErr', '');
    openSheet('#sheetBill');
  }

  /** Cicilan: nominal per bulan = total / tenor, kecuali user sudah mengubahnya manual. */
  var nominalManual = false;
  /** Angsuran per bulan. Flat: (pokok + pokok x bunga x tahun) / tenor. Efektif: anuitas (bunga dari sisa pokok). */
  function hitungAngsuran(pokok, bungaPct, tenor, metode) {
    if (!bungaPct) return pokok / tenor;
    if (metode === 'Efektif') {
      var r = bungaPct / 100 / 12;
      return pokok * r / (1 - Math.pow(1 + r, -tenor));
    }
    return (pokok + pokok * bungaPct / 100 * tenor / 12) / tenor;
  }
  function onCicilanCalc() {
    var hint = $('#bHint');
    var total = digits('#bTotal'), tenor = Number($('#bTenor').value) || 0, bunga = dec('#bBunga') || 0;
    if ($('#bJenis').value !== 'Cicilan' || !total || tenor < 1) { show(hint, false); return; }
    var metode = $('#bMetode').value;
    var calc = Math.round(hitungAngsuran(total, bunga, tenor, metode));
    if (!nominalManual) $('#bNominal').value = nf.format(calc);
    var differs = digits('#bNominal') !== calc;
    var rumus = bunga ? rp(total) + ' + bunga ' + bunga + '% (' + metode.toLowerCase() + ') selama ' + tenor + ' bln' : rp(total) + ' ÷ ' + tenor + ' bulan';
    var totalBayar = calc * tenor;
    hint.innerHTML = 'Hitungan sistem: ' + rumus + ' = <b>' + rp(calc) + '</b>/bln' +
      (bunga ? '<br>Total dibayar ' + rp(totalBayar) + ' (bunga ± ' + rp(Math.max(0, totalBayar - total)) + ')' : '') +
      (differs ? '<br><a href="#" id="bReset">pakai hitungan sistem</a>' : '');
    show(hint, true);
  }
  function onBillNominalInput() {
    nominalManual = digits('#bNominal') > 0;
    onCicilanCalc();
  }
  function onBillReset(e) {
    if (!e.target.closest('#bReset')) return;
    e.preventDefault(); nominalManual = false; onCicilanCalc();
  }

  function defaultKategori(jenis) { return jenis === 'Langganan' ? 'Langganan' : 'Kewajiban'; }

  /** Jenis menentukan: kolom cicilan (tenor), pilihan siklus (khusus Langganan), default kategori, dan label nominal. */
  function onBillJenis() {
    var j = $('#bJenis').value;
    show($('#bCicilanWrap'), j === 'Cicilan');
    show($('#bSiklusWrap'), j === 'Langganan');
    if (j !== 'Langganan') $('#bSiklus').value = 'Bulanan';
    var dk = defaultKategori(j);
    if (Array.prototype.some.call($('#bKategori').options, function (o) { return o.value === dk; })) $('#bKategori').value = dk;
    onBillSiklus();
    onCicilanCalc();
  }

  function onBillSiklus() {
    $('#bNominalLabel').textContent = $('#bSiklus').value === 'Tahunan' ? 'Nominal per tahun' : 'Nominal per bulan';
  }

  function onBillSubmit(e) {
    e.preventDefault();
    setErr('#billErr', '');
    var payload = {
      jenis: $('#bJenis').value, nama: $('#bNama').value, pemberi: $('#bPemberi').value,
      nominal: Number($('#bNominal').value.replace(/\D/g, '')), hari: $('#bHari').value,
      mulai: $('#bMulai').value, tenor: $('#bTenor').value, terbayarAwal: $('#bAwal').value, dompet: $('#bDompet').value,
      kategori: $('#bKategori').value, siklus: $('#bSiklus').value,
      pokok: digits('#bTotal'), bunga: dec('#bBunga') || 0, metode: $('#bMetode').value
    };
    if (!payload.nominal) { setErr('#billErr', 'Nominal wajib diisi.'); return; }
    var req = editBillId ? call('apiUpdateTagihan', state.token, state.kasId, editBillId, payload) : call('apiSaveTagihan', state.token, state.kasId, payload);
    req.then(function () {
      closeSheets(); toast(editBillId ? 'Tagihan diperbarui ✓' : 'Tagihan tersimpan ✓');
      return refresh();
    }).catch(function (err) { setErr('#billErr', err.message); });
  }

  var payId = null;
  function openPay(t) {
    payId = t.id;
    $('#payInfo').innerHTML = '<b>' + esc(t.nama) + '</b><br>' + rp(t.nominal) + ' · periode ' + t.periode + ' · kategori ' + esc(t.kategori) +
      (t.tenor > 0 ? ' · cicilan ke-' + (t.terbayar + 1) + '/' + t.tenor : '');
    $('#pTanggal').value = today();
    ensureOption($('#pDompet'), t.dompet); $('#pDompet').value = t.dompet;
    setErr('#payErr', '');
    openSheet('#sheetPay');
  }

  function onPaySubmit(e) {
    e.preventDefault();
    setErr('#payErr', '');
    call('apiPayTagihan', state.token, state.kasId, payId, $('#pDompet').value, $('#pTanggal').value).then(function () {
      closeSheets(); toast('Pembayaran dicatat ✓');
      return refresh();
    }).catch(function (err) { setErr('#payErr', err.message); });
  }

  /* ---------- Deposito ---------- */
  function digits(sel) { return Number($(sel).value.replace(/\D/g, '')) || 0; }
  function dec(sel) { return Number(String($(sel).value).replace(',', '.')); }
  function longDate(iso) { var p = iso.split('-'); return Number(p[2]) + ' ' + BULAN[Number(p[1]) - 1] + ' ' + p[0]; }

  function renderDeposito(d, isAdmin) {
    var dep = d.deposito, r = dep.ringkas;
    $('#depTotal').textContent = rp(r.terblokir);
    $('#depEst').textContent = rp(r.estBunga);
    $('#depBunga').textContent = rp(r.bungaTotal);
    $('#depYear').textContent = rp(r.bungaTahunIni);
    show($('#btnAddDep'), isAdmin);

    var aktif = dep.list.filter(function (x) { return x.status === 'Aktif'; });
    var cair = dep.list.filter(function (x) { return x.status === 'Cair'; });
    $('#depActive').innerHTML = aktif.length ? aktif.map(function (x) { return depItem(x, isAdmin); }).join('')
      : '<li class="empty-list">Belum ada deposito aktif.</li>';
    $('#depReport').innerHTML = r.perInstitusi.length ? r.perInstitusi.map(function (p) {
      return '<li class="due-item"><div><b>' + esc(p.institusi) + '</b><small>' + p.jumlahAktif + ' aktif · ' + p.jumlahCair + ' sudah cair</small></div>' +
        '<div class="bill-amt">' + rp(p.aktif) + '<br><small>bunga diterima ' + rp(p.bunga) + '</small></div></li>';
    }).join('') : '<li class="empty-list">Belum ada data.</li>';
    $('#depHist').innerHTML = cair.length ? cair.map(function (x) {
      var b = x.bungaDiterima;
      return '<li class="due-item"><div><b>' + esc(x.nama) + ' · ' + esc(x.institusi) + '</b><small>Cair ' + longDate(x.tglCair) + ' · pokok ' + rp(x.pokok) +
        (x.lanjutKe ? ' · dibuka ulang di ' + esc(x.lanjutKe) : '') + '</small></div>' +
        '<div class="bill-amt"><span class="' + (b >= 0 ? 'amt-Pemasukan' : 'amt-Pengeluaran') + '">' + (b >= 0 ? '+' : '−') + rp(Math.abs(b)) + '</span><br><small>bunga</small></div></li>';
    }).join('') : '<li class="empty-list">Belum ada deposito yang dicairkan.</li>';
  }

  function depItem(x, isAdmin) {
    var lb = dueLabel(x);
    return '<li class="bill" data-id="' + esc(x.id) + '">' +
      '<div class="bill-top"><div><b>' + esc(x.nama) + '</b><small>' + esc(x.institusi) + ' · ' + x.bunga + '% p.a. · ' + x.tenor + ' bln' + (x.aro ? ' · ARO' : '') + ' · bunga → ' + (x.bungaKe === 'Deposito' ? 'angka deposito' : 'tabungan') + '</small></div>' +
      '<div class="bill-amt">' + rp(x.pokok) + '<br><span class="badge ' + lb.cls + '">' + lb.text + '</span></div></div>' +
      '<div class="bill-meta"><span>' + longDate(x.mulai) + ' → ' + longDate(x.jatuhTempo) + ' · est. bunga ' + rp(x.estBunga) + '</span>' +
      (isAdmin ? '<span class="bill-actions"><button class="btn btn-soft sm" type="button" data-act="cair">Cairkan</button>' +
        '<button class="icon-btn" type="button" data-act="edit" aria-label="Edit">' + IC_EDIT + '</button>' +
        '<button class="icon-btn del" type="button" data-act="del" aria-label="Hapus">' + IC_DEL + '</button></span>' : '') +
      '</div></li>';
  }

  function onDepClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.closest('.bill').dataset.id;
    var x = state.dash.deposito.list.filter(function (v) { return v.id === id; })[0];
    if (!x) return;
    if (btn.dataset.act === 'cair') { openCair(x); return; }
    if (btn.dataset.act === 'edit') { openDepForm(x); return; }
    if (!btn.classList.contains('confirm')) { armDelete(btn); return; }
    call('apiDeleteDeposito', state.token, state.kasId, id)
      .then(function () { toast('Deposito dihapus'); return refresh(); })
      .catch(function (err) { toast(err.message); });
  }

  /** Tanpa argumen = tambah baru; dengan objek deposito = mode edit. */
  function openDepForm(x) {
    editDepId = x ? x.id : null;
    $('#depForm').reset();
    $('#depTitle').textContent = x ? 'Edit Deposito' : 'Tambah Deposito';
    $('#depBtn').textContent = x ? 'Simpan Perubahan' : 'Simpan';
    if (x) {
      $('#dInst').value = x.institusi; $('#dNama').value = x.nama || '';
      $('#dPokok').value = nf.format(x.pokok); $('#dBunga').value = String(x.bunga).replace('.', ',');
      $('#dTenor').value = x.tenor; $('#dMulai').value = x.mulai;
      $('#dAro').value = x.aro ? 'Ya' : 'Tidak'; $('#dBungaKe').value = x.bungaKe;
    } else {
      $('#dMulai').value = today();
    }
    setErr('#depErr', '');
    openSheet('#sheetDep');
  }

  function onDepSubmit(e) {
    e.preventDefault();
    setErr('#depErr', '');
    var payload = {
      institusi: $('#dInst').value, nama: $('#dNama').value, pokok: digits('#dPokok'), bunga: dec('#dBunga'),
      tenor: $('#dTenor').value, mulai: $('#dMulai').value, aro: $('#dAro').value === 'Ya', bungaKe: $('#dBungaKe').value
    };
    if (!payload.pokok) { setErr('#depErr', 'Nominal wajib diisi.'); return; }
    var req = editDepId ? call('apiUpdateDeposito', state.token, state.kasId, editDepId, payload) : call('apiSaveDeposito', state.token, state.kasId, payload);
    req.then(function () {
      closeSheets(); toast(editDepId ? 'Deposito diperbarui ✓' : 'Deposito tersimpan ✓');
      return refresh();
    }).catch(function (err) { setErr('#depErr', err.message); });
  }

  var cairDep = null;
  function openCair(x) {
    cairDep = x;
    $('#cairForm').reset();
    $('#cInfo').innerHTML = '<b>' + esc(x.nama) + '</b> · ' + esc(x.institusi) + '<br>Pokok ' + rp(x.pokok) + ' · estimasi bunga bruto ' + rp(x.estBunga);
    $('#cTanggal').value = today();
    $('#cTotal').value = nf.format(x.pokok + x.estBunga);
    $('#cInst').value = x.institusi;
    $('#cPokok').value = nf.format(x.pokok + x.estBunga);
    $('#cBunga').value = String(x.bunga).replace('.', ',');
    $('#cTenor').value = x.tenor;
    $('#cAro').value = x.aro ? 'Ya' : 'Tidak';
    show($('#cBaruWrap'), false);
    setErr('#cairErr', '');
    openSheet('#sheetCair');
  }

  function onCairSubmit(e) {
    e.preventDefault();
    setErr('#cairErr', '');
    var total = digits('#cTotal');
    if (!total) { setErr('#cairErr', 'Total diterima wajib diisi.'); return; }
    var tanggal = $('#cTanggal').value;
    var baru = null;
    if ($('#cBaru').value === 'ya') {
      baru = { institusi: $('#cInst').value, pokok: digits('#cPokok'), bunga: dec('#cBunga'), tenor: $('#cTenor').value, mulai: tanggal, aro: $('#cAro').value === 'Ya', bungaKe: cairDep.bungaKe };
    }
    call('apiCairkanDeposito', state.token, state.kasId, cairDep.id, tanggal, total, baru).then(function () {
      closeSheets(); toast(baru ? 'Dicairkan, deposito baru dibuat ✓' : 'Deposito dicairkan ✓');
      return refresh();
    }).catch(function (err) { setErr('#cairErr', err.message); });
  }

  /* ---------- Form transaksi ---------- */
  function fillSelect(sel, items) {
    sel.innerHTML = items.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
  }

  /** Nama item aktif (tidak disembunyikan) milik buku kas yang sedang dibuka. `keep` = nilai lama yang tetap dimunculkan saat edit. */
  function activeNames(list, keep) {
    return list.filter(function (x) { return !x.sembunyi || x.nama === keep; }).map(function (x) { return x.nama; });
  }
  /** Pastikan nilai tertentu ada di <select> (mis. dompet/kategori yang kini disembunyikan tetapi dipakai data lama). */
  function ensureOption(sel, v) {
    if (!v) return;
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === v; });
    if (!has) sel.insertAdjacentHTML('beforeend', '<option value="' + esc(v) + '">' + esc(v) + '</option>');
  }
  function opts() {
    var s = (state.dash && state.dash.settings) || { dompet: [], kategoriOut: [], kategoriIn: [] };
    return { dompet: s.dompet, out: s.kategoriOut, inn: s.kategoriIn };
  }
  function kategoriFor(jenis, keep) {
    var o = opts();
    if (jenis === 'Transfer') return state.config.kategoriTransfer;
    return activeNames(jenis === 'Pemasukan' ? o.inn : o.out, keep);
  }

  /** Statis (tidak bergantung buku kas) — dipanggil sekali saat boot. */
  function buildForm() {
    var c = state.config;
    fillSelect($('#tJenis'), c.jenis);
    fillSelect($('#bJenis'), c.jenisTagihan);
    fillSelect($('#bSiklus'), c.siklus);
    fillSelect($('#bMetode'), c.metodeBunga);
    $('#tJenis').value = 'Pengeluaran';
  }

  /** Pilihan dompet & kategori per buku kas — dipanggil setiap data dashboard dimuat. Nilai yang sedang dipilih dipertahankan. */
  function refreshOptions() {
    var o = opts();
    [['#tDompet', 'dompet'], ['#tTujuan', 'dompet'], ['#bDompet', 'dompet'], ['#pDompet', 'dompet']].forEach(function (p) {
      var sel = $(p[0]), cur = sel.value;
      fillSelect(sel, activeNames(o.dompet, cur));
      if (cur) sel.value = cur;
    });
    var kb = $('#bKategori'), kcur = kb.value;
    fillSelect(kb, activeNames(o.out, kcur));
    if (kcur) kb.value = kcur;
    onJenisChange();
  }

  function onJenisChange() {
    var jenis = $('#tJenis').value;
    var sel = $('#tKategori'), cur = sel.value;
    fillSelect(sel, kategoriFor(jenis, cur));
    if (cur) sel.value = cur;
    var isTransfer = jenis === 'Transfer';
    show($('#tTujuanWrap'), isTransfer);
    show($('#rincWrap'), !isTransfer);
    if (isTransfer && readRinc().length) clearRinc();
    $('#tDompetLabel').textContent = isTransfer ? 'Dompet Asal' : 'Dompet';
    var n = $('#tDompet').options.length;
    if (isTransfer && n > 1 && $('#tTujuan').value === $('#tDompet').value) {
      $('#tTujuan').selectedIndex = ($('#tDompet').selectedIndex + 1) % n;
    }
  }

  /* ---------- Pengaturan dompet & kategori (per buku kas) ---------- */
  var setKey = 'dompet'; // tab aktif di sheet Kelola (bukan navigasi tab bawah)
  var SET_TABS = { dompet: { tipe: 'Dompet', key: 'dompet', label: 'dompet' }, out: { tipe: 'Kategori Pengeluaran', key: 'kategoriOut', label: 'kategori pengeluaran' }, inn: { tipe: 'Kategori Pemasukan', key: 'kategoriIn', label: 'kategori pemasukan' } };
  var IC_EYE = '<svg class="ico" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var IC_EYE_OFF = '<svg class="ico" viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 6.2A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 7.7A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.3-1"/></svg>';

  function openSettings() {
    setErr('#setErr', '');
    $('#setNew').value = '';
    renderSettings();
    openSheet('#sheetSet');
  }

  function renderSettings() {
    $$('.set-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.set === setKey); });
    var cfg = SET_TABS[setKey], list = state.dash.settings[cfg.key];
    $('#setNew').placeholder = 'Tambah ' + cfg.label + ' baru';
    $('#setList').innerHTML = list.map(function (x) {
      var note = x.terkunci ? 'bawaan' : x.sembunyi ? 'disembunyikan' : '';
      if (x.dipakai) note += (note ? ' · ' : '') + 'dipakai ' + x.dipakai + 'x';
      var canDelete = !x.terkunci && !x.dipakai;
      return '<li class="set-item' + (x.sembunyi ? ' off' : '') + '" data-n="' + esc(x.nama) + '">' +
        '<div class="set-name"><b>' + esc(x.nama) + '</b>' + (note ? '<small>' + note + '</small>' : '') + '</div>' +
        '<span class="row-actions">' +
        '<button class="icon-btn" type="button" data-sa="rename" data-edit aria-label="Ganti nama">' + IC_EDIT + '</button>' +
        (x.terkunci ? '' : '<button class="icon-btn" type="button" data-sa="hide" aria-label="' + (x.sembunyi ? 'Tampilkan' : 'Sembunyikan') + '">' + (x.sembunyi ? IC_EYE : IC_EYE_OFF) + '</button>') +
        (canDelete ? '<button class="icon-btn del" type="button" data-sa="del" aria-label="Hapus">' + IC_DEL + '</button>' : '') +
        '</span></li>';
    }).join('');
  }

  /** Muat ulang dashboard lalu segarkan daftar Kelola + pilihan form. */
  function reloadSettings() {
    return fetchDash().then(function (d) {
      state.dash = d; render(); renderSettings();
    });
  }

  function onSetClick(e) {
    var tb = e.target.closest('.set-tab');
    if (tb) { setKey = tb.dataset.set; setErr('#setErr', ''); renderSettings(); return; }
    var btn = e.target.closest('[data-sa]');
    if (!btn) return;
    var li = btn.closest('.set-item'), nama = li.dataset.n, tipe = SET_TABS[setKey].tipe;
    setErr('#setErr', '');
    var act = btn.dataset.sa;
    if (act === 'rename') { startRename(li, nama, tipe); return; }
    if (act === 'hide') {
      var item = state.dash.settings[SET_TABS[setKey].key].filter(function (x) { return x.nama === nama; })[0];
      call('apiSetSettingHidden', state.token, state.kasId, tipe, nama, !item.sembunyi)
        .then(reloadSettings).catch(function (err) { setErr('#setErr', err.message); });
      return;
    }
    if (act === 'del') {
      if (!btn.classList.contains('confirm')) { armDelete(btn); return; }
      call('apiDeleteSetting', state.token, state.kasId, tipe, nama)
        .then(function () { toast('Dihapus'); return reloadSettings(); })
        .catch(function (err) { setErr('#setErr', err.message); });
    }
  }

  function startRename(li, nama, tipe) {
    var box = li.querySelector('.set-name');
    box.innerHTML = '<input class="set-edit" type="text" maxlength="30" value="' + esc(nama) + '"><small>Enter untuk simpan · semua data lama ikut diperbarui</small>';
    var inp = box.querySelector('input');
    inp.focus(); inp.select();
    var done = false;
    function commit() {
      if (done) return; done = true;
      var v = inp.value.trim();
      if (!v || v === nama) { renderSettings(); return; }
      call('apiRenameSetting', state.token, state.kasId, tipe, nama, v)
        .then(function (r) { toast('Nama diganti' + (r.diperbarui ? ' · ' + r.diperbarui + ' data diperbarui' : '') + ' ✓'); return reloadSettings(); })
        .catch(function (err) { setErr('#setErr', err.message); renderSettings(); });
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { done = true; renderSettings(); } });
    inp.addEventListener('blur', commit);
  }

  function onSetAdd(e) {
    e.preventDefault();
    setErr('#setErr', '');
    call('apiAddSetting', state.token, state.kasId, SET_TABS[setKey].tipe, $('#setNew').value)
      .then(function () { $('#setNew').value = ''; toast('Ditambahkan ✓'); return reloadSettings(); })
      .catch(function (err) { setErr('#setErr', err.message); });
  }

  function onNominalInput(e) {
    var digits = e.target.value.replace(/\D/g, '').replace(/^0+/, '');
    e.target.value = digits ? nf.format(Number(digits)) : '';
  }

  /* ---------- Rincian belanja (opsional) ---------- */
  function qtyVal(s) { var n = Number(String(s).replace(',', '.')); return isFinite(n) ? Math.round(n * 1000) / 1000 : 0; }

  function rincRow(it) {
    it = it || {};
    return '<div class="rinc-row">' +
      '<input class="r-nama" type="text" maxlength="100" placeholder="Nama barang" value="' + esc(it.nama || '') + '">' +
      '<div class="rinc-nums">' +
      '<input class="r-harga" type="text" inputmode="numeric" placeholder="Harga" autocomplete="off" value="' + (it.harga ? nf.format(it.harga) : '') + '">' +
      '<input class="r-qty" type="text" inputmode="decimal" placeholder="Qty" autocomplete="off" value="' + (it.qty ? fmtQty(it.qty) : '1') + '">' +
      '<input class="r-diskon" type="text" inputmode="numeric" placeholder="Diskon" autocomplete="off" value="' + (it.diskon ? nf.format(it.diskon) : '') + '">' +
      '<button class="icon-btn del" type="button" data-rdel aria-label="Hapus barang">' + IC_DEL + '</button></div>' +
      '<small class="r-sub"></small></div>';
  }

  function rowVals(row) {
    return {
      nama: row.querySelector('.r-nama').value.trim(),
      harga: Number(row.querySelector('.r-harga').value.replace(/\D/g, '')) || 0,
      qty: qtyVal(row.querySelector('.r-qty').value),
      diskon: Number(row.querySelector('.r-diskon').value.replace(/\D/g, '')) || 0
    };
  }

  /** Barang yang terisi (baris kosong diabaikan). */
  function readRinc() {
    return $$('#rincList .rinc-row').map(rowVals).filter(function (it) { return it.nama || it.harga; });
  }

  /** Hitung ulang subtotal, ringkasan, dan nominal transaksi. Nominal dikunci selama ada rincian. */
  function calcRinc() {
    var sub = 0, n = 0;
    $$('#rincList .rinc-row').forEach(function (row) {
      var v = rowVals(row), line = Math.round(v.harga * v.qty) - v.diskon;
      row.querySelector('.r-sub').textContent = v.harga ? '= ' + rp(line) : '';
      if (v.nama || v.harga) { sub += line; n++; }
    });
    var pajak = digits('#rPajak'), add = $('#rPajakMode').value === 'add';
    var total = sub + (add ? pajak : 0);
    var h = '<div><span>Subtotal (' + n + ' barang)</span><span>' + rp(sub) + '</span></div>';
    if (pajak) h += '<div><span>PPN' + (add ? '' : ' (sudah termasuk)') + '</span><span>' + (add ? '+' : '') + rp(pajak) + '</span></div>';
    h += '<div class="tot"><span>Total</span><span>' + rp(total) + '</span></div>';
    $('#rincSum').innerHTML = h;
    $('#rincBtn').textContent = n ? 'Rincian belanja · ' + n + ' barang' : '+ Rincian belanja (opsional)';
    var nom = $('#tNominal');
    nom.readOnly = n > 0;
    if (n > 0) nom.value = total > 0 ? nf.format(total) : '';
  }

  function clearRinc() {
    $('#rincList').innerHTML = '';
    $('#rPajak').value = ''; $('#rPajakMode').value = 'in';
    show($('#rincPanel'), false);
    calcRinc();
  }

  function addRincRow(it) {
    $('#rincList').insertAdjacentHTML('beforeend', rincRow(it));
    return $('#rincList').lastElementChild;
  }

  function onRincToggle() {
    var panel = $('#rincPanel'), open = panel.classList.contains('hidden');
    show(panel, open);
    if (open && !$$('#rincList .rinc-row').length) addRincRow().querySelector('.r-nama').focus();
  }

  function onRincAdd() {
    addRincRow().querySelector('.r-nama').focus();
    calcRinc();
  }

  function onRincInput(e) {
    var c = e.target.classList;
    if (c.contains('r-harga') || c.contains('r-diskon')) onNominalInput(e);
    else if (c.contains('r-qty')) e.target.value = e.target.value.replace(/[^\d.,]/g, '');
    calcRinc();
  }

  function onRincClick(e) {
    var del = e.target.closest('[data-rdel]');
    if (!del) return;
    del.closest('.rinc-row').remove();
    calcRinc();
  }

  /** Tanpa argumen = tambah baru; dengan objek transaksi = mode edit. */
  function openTrxForm(t) {
    editTrxId = t ? t.id : null;
    $('#trxForm').reset();
    $('#rincList').innerHTML = '';
    show($('#rincPanel'), false);
    $('#trxTitle').textContent = t ? 'Edit Transaksi' : 'Tambah Transaksi';
    $('#trxBtn').textContent = t ? 'Simpan Perubahan' : 'Simpan Transaksi';
    if (t) {
      $('#tTanggal').value = t.tanggal;
      $('#tJenis').value = t.jenis;
      onJenisChange();
      var p = String(t.dompet).split(' → ');
      ensureOption($('#tDompet'), p[0]); $('#tDompet').value = p[0];
      if (p[1]) { ensureOption($('#tTujuan'), p[1]); $('#tTujuan').value = p[1]; }
      ensureOption($('#tKategori'), t.kategori); $('#tKategori').value = t.kategori;
      $('#tNama').value = t.nama;
      $('#tNominal').value = nf.format(t.nominal);
      $('#tKet').value = t.keterangan || '';
      if (t.rincian) {
        t.rincian.items.forEach(function (it) { addRincRow(it); });
        if (t.rincian.pajak) {
          $('#rPajak').value = t.rincian.pajak.nominal ? nf.format(t.rincian.pajak.nominal) : '';
          $('#rPajakMode').value = t.rincian.pajak.termasuk ? 'in' : 'add';
        }
      }
    } else {
      $('#tTanggal').value = today();
      $('#tJenis').value = 'Pengeluaran';
      onJenisChange();
    }
    calcRinc();
    setErr('#trxErr', '');
    openSheet('#sheetTrx');
  }

  function onTrxSubmit(e) {
    e.preventDefault();
    setErr('#trxErr', '');
    var payload = {
      tanggal: $('#tTanggal').value,
      jenis: $('#tJenis').value,
      dompet: $('#tDompet').value,
      dompetTujuan: $('#tTujuan').value,
      nama: $('#tNama').value,
      kategori: $('#tKategori').value,
      nominal: Number($('#tNominal').value.replace(/\D/g, '')),
      keterangan: $('#tKet').value
    };
    var items = payload.jenis === 'Transfer' ? [] : readRinc();
    if (items.length) {
      for (var i = 0; i < items.length; i++) {
        if (!items[i].nama) { setErr('#trxErr', 'Nama barang #' + (i + 1) + ' wajib diisi.'); return; }
        if (!items[i].qty) { setErr('#trxErr', 'Qty "' + items[i].nama + '" harus lebih dari 0.'); return; }
      }
      payload.rincian = { items: items, pajak: { nominal: digits('#rPajak'), termasuk: $('#rPajakMode').value === 'in' } };
    }
    if (!payload.nominal) { setErr('#trxErr', 'Nominal wajib diisi.'); return; }
    $('#trxBtn').disabled = true;
    var req = editTrxId ? call('apiUpdateTransaction', state.token, state.kasId, editTrxId, payload) : call('apiAddTransaction', state.token, state.kasId, payload);
    req.then(function () {
      closeSheets();
      toast(editTrxId ? 'Transaksi diperbarui ✓' : 'Transaksi tersimpan ✓');
      var tg = payload.tanggal; // jika di luar periode aktif, lompat ke bulan transaksi agar langsung terlihat
      if ((state.dari && tg < state.dari) || (state.sampai && tg > state.sampai)) {
        state.preset = 'custom';
        state.dari = tg.slice(0, 7) + '-01';
        state.sampai = isoDate(new Date(Number(tg.slice(0, 4)), Number(tg.slice(5, 7)), 0));
      }
      if (!editTrxId) state.halaman = 1; // transaksi baru muncul di halaman pertama
      return refresh();
    }).catch(function (err) { setErr('#trxErr', err.message); })
      .then(function () { $('#trxBtn').disabled = false; });
  }

  /* ---------- Kolaborator ---------- */
  function openCollab() {
    $('#collabForm').reset(); setErr('#collabErr', '');
    $('#members').innerHTML = (state.dash ? state.dash.members : []).map(function (m) {
      return '<li><div>' + esc(m.nama) + '<small>' + esc(m.email) + '</small></div><span class="role">' + esc(m.role) + '</span></li>';
    }).join('');
    openSheet('#sheetCollab');
  }

  function onCollabSubmit(e) {
    e.preventDefault();
    setErr('#collabErr', '');
    call('apiAddCollaborator', state.token, state.kasId, $('#cEmail').value, $('#cRole').value).then(function (r) {
      toast(r.nama + ' ditambahkan sebagai ' + r.role);
      return fetchDash();
    }).then(function (d) { state.dash = d; openCollab(); })
      .catch(function (err) { setErr('#collabErr', err.message); });
  }

  /* ---------- Switch kas ---------- */
  function openKas() {
    $('#kasForm').reset(); setErr('#kasErr', '');
    $('#kasList').innerHTML = state.kasList.map(function (k) {
      return '<li class="kas-item' + (k.id === state.kasId ? ' active' : '') + '" data-id="' + esc(k.id) + '"><span>' + esc(k.nama) + '</span><small>' + esc(k.role) + (k.id === state.kasId ? ' ✓' : '') + '</small></li>';
    }).join('');
    openSheet('#sheetKas');
  }

  function onKasPick(e) {
    var li = e.target.closest('.kas-item');
    if (!li) return;
    state.kasId = li.dataset.id;
    closeSheets();
    refresh();
  }

  function onKasCreate(e) {
    e.preventDefault();
    setErr('#kasErr', '');
    call('apiCreateKas', state.token, $('#kNama').value).then(function (r) {
      state.kasList = r.kasList; state.kasId = r.newId;
      closeSheets(); toast('Buku kas baru dibuat ✓');
      return refresh();
    }).catch(function (err) { setErr('#kasErr', err.message); });
  }

  /* ---------- Init & event binding ---------- */
  function init() {
    $$('.tab[data-mode]').forEach(function (t) { t.addEventListener('click', function () { setMode(t.dataset.mode); }); });
    $('#authForm').addEventListener('submit', onAuthSubmit);
    $('#kasBtn').addEventListener('click', openKas);
    $('#btnAddTrx').addEventListener('click', function () { openTrxForm(); });
    $('#btnAddTrx2').addEventListener('click', function () { openTrxForm(); });
    $('#btnAddCollab').addEventListener('click', openCollab);
    $('#tJenis').addEventListener('change', onJenisChange);
    $('#tDompet').addEventListener('change', onJenisChange);
    $('#tNominal').addEventListener('input', onNominalInput);
    $('#trxForm').addEventListener('submit', onTrxSubmit);
    $('#rincBtn').addEventListener('click', onRincToggle);
    $('#rincAdd').addEventListener('click', onRincAdd);
    $('#rincClear').addEventListener('click', clearRinc);
    $('#rincList').addEventListener('input', onRincInput);
    $('#rincList').addEventListener('click', onRincClick);
    $('#rPajak').addEventListener('input', function (e) { onNominalInput(e); calcRinc(); });
    $('#rPajakMode').addEventListener('change', calcRinc);
    $('#collabForm').addEventListener('submit', onCollabSubmit);
    $('#kasList').addEventListener('click', onKasPick);
    $('#kasForm').addEventListener('submit', onKasCreate);
    $('#btnLogout').addEventListener('click', logout);
    $('#recent').addEventListener('click', onRecentClick);
    $$('.tabbtn').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.tab); }); });
    $('#walletList').addEventListener('click', onWalletPick);
    $('#btnSettings').addEventListener('click', openSettings);
    $('#sheetSet').addEventListener('click', onSetClick);
    $('#setForm').addEventListener('submit', onSetAdd);
    $('#walletForm').addEventListener('submit', onWalletSubmit);
    $('#wNominal').addEventListener('input', onNominalInput);
    $('#btnAddBill').addEventListener('click', function () { openBillForm(); });
    $('#bJenis').addEventListener('change', onBillJenis);
    $('#bSiklus').addEventListener('change', onBillSiklus);
    $('#bNominal').addEventListener('input', onNominalInput);
    $('#bNominal').addEventListener('input', onBillNominalInput);
    $('#bTotal').addEventListener('input', onNominalInput);
    $('#bTotal').addEventListener('input', onCicilanCalc);
    $('#bTenor').addEventListener('input', onCicilanCalc);
    $('#bBunga').addEventListener('input', onCicilanCalc);
    $('#bMetode').addEventListener('change', onCicilanCalc);
    $('#billForm').addEventListener('click', onBillReset);
    $('#billForm').addEventListener('submit', onBillSubmit);
    $('#billList').addEventListener('click', onBillClick);
    $('#payForm').addEventListener('submit', onPaySubmit);
    $('#dueMore').addEventListener('click', function () { setTab('bill'); });
    $('#btnAddDep').addEventListener('click', function () { openDepForm(); });
    $('#depForm').addEventListener('submit', onDepSubmit);
    $('#depActive').addEventListener('click', onDepClick);
    $('#dPokok').addEventListener('input', onNominalInput);
    $('#cTotal').addEventListener('input', onNominalInput);
    $('#cPokok').addEventListener('input', onNominalInput);
    $('#cBaru').addEventListener('change', function (e) { show($('#cBaruWrap'), e.target.value === 'ya'); });
    $('#cairForm').addEventListener('submit', onCairSubmit);
    $('#periodBtn').addEventListener('click', openPeriod);
    $('#periodBtn2').addEventListener('click', openPeriod);
    $('#periodForm').addEventListener('submit', onPeriodSubmit);
    $$('.preset').forEach(function (b) { b.addEventListener('click', function () { setPreset(b.dataset.preset); }); });
    $('#pagePrev').addEventListener('click', function () { gotoPage(state.halaman - 1); });
    $('#pageNext').addEventListener('click', function () { gotoPage(state.halaman + 1); });
    $$('[data-close]').forEach(function (b) { b.addEventListener('click', closeSheets); });
    $$('.backdrop').forEach(function (b) { b.addEventListener('click', function (e) { if (e.target === b) closeSheets(); }); });

    state.token = load(LS_TOKEN);
    if (state.token) boot(); else show($('#authView'), true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
