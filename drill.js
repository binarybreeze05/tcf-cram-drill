(function () {
  /* TCF · 🎯 Drill: the ⚡ Cram card UI, but run as a real exam drill.
     Differences from cram.js:
       · listening cards: the whole recording is loaded in a native <audio controls>
         (scrubber — seek anywhere). Reading cards: no audio bar shown.
       · MCQ options reshuffled on every visit to a card, so you can't memorise
         "the answer is the 3rd one".
       · nothing English — and no transcript/passage-EN — until you hit Reveal.
       · no 10s countdown timer. */
  var ALL = (window.PASSAGES || []).slice();

  /* ---- theme ---- */
  var root = document.documentElement, themeBtn = document.getElementById('theme-toggle');
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function effTheme() { return root.getAttribute('data-theme') || (mq.matches ? 'dark' : 'light'); }
  function paintThemeIcon() { themeBtn.textContent = effTheme() === 'dark' ? '☀︎' : '☾'; }
  themeBtn.addEventListener('click', function () {
    var next = effTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next); localStorage.setItem('theme', next); paintThemeIcon();
  });
  mq.addEventListener('change', function () { if (!localStorage.getItem('theme')) paintThemeIcon(); });
  paintThemeIcon();

  /* ---- settings (persisted, separate from cram's) ---- */
  var S = { subject: 'all', section: 'all', shuffle: false, hidknown: false, autoplay: true };
  try { var saved = JSON.parse(localStorage.getItem('drill-tcf-set') || '{}'); for (var k in saved) if (k in S) S[k] = saved[k]; } catch (e) {}
  function saveSettings() { try { localStorage.setItem('drill-tcf-set', JSON.stringify(S)); } catch (e) {} }

  /* ---- known set (shared with cram) ---- */
  var KNOWN = {};
  try { (JSON.parse(localStorage.getItem('cram-tcf-known') || '[]') || []).forEach(function (q) { KNOWN[q] = 1; }); } catch (e) {}
  function saveKnown() { try { localStorage.setItem('cram-tcf-known', JSON.stringify(Object.keys(KNOWN))); } catch (e) {} }

  /* ---- helpers ---- */
  function qnum(qref) { var m = (qref || '').match(/#Q?(\d+)/); return m ? m[1] : ''; }
  function testNum(p) { return p.testNum || 0; }
  function srcLabel(c) {
    var sub = c.p.subject === 'listening' ? '🎧' : '📖';
    return sub + ' Test ' + testNum(c.p) + ' · §' + (c.p.section || '?') + ' · Q' + qnum(c.q.qref);
  }
  function isLetter(o) { return o && !o.is_img && typeof o.fr === 'string' && o.fr.trim().length <= 2 && (!o.en || o.en.trim() === o.fr.trim()); }

  function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function sameOrder(a, b) { for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  function shuffledDistinct(arr) {
    if (arr.length < 2) return arr.slice();
    var out, tries = 0;
    do { out = shuffleInPlace(arr.slice()); tries++; } while (tries < 16 && sameOrder(out, arr));
    return out;
  }

  /* ---- build the full card list once (every question in the dataset) ---- */
  var CARDS = [];
  ALL.forEach(function (p) {
    (p.questions || []).forEach(function (q, qi) {
      if (!q || !q.options) return;
      CARDS.push({ p: p, q: q, qi: qi, qref: q.qref, subject: p.subject });
    });
  });

  /* ---- ordering / filtering per current settings ---- */
  function inSubject(c) {
    if (S.subject === 'listening') return c.subject === 'listening';
    if (S.subject === 'reading')   return c.subject === 'reading';
    return true;
  }
  function inSection(c) {
    if (S.section === 'all') return true;
    return String(c.p.section) === String(S.section);
  }
  function baseSort(a, b) {
    var sa = a.subject === 'listening' ? 0 : 1, sb = b.subject === 'listening' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    var ta = testNum(a.p), tb = testNum(b.p);
    if (ta !== tb) return ta - tb;
    return (+qnum(a.q.qref) || 0) - (+qnum(b.q.qref) || 0);
  }

  var DECK = [];
  var idx = 0;
  var revealed = false;
  var sess = { right: 0, wrong: 0 };

  function buildDeck(preserveQref) {
    var keep = CARDS.filter(function (c) {
      if (!inSubject(c)) return false;
      if (!inSection(c)) return false;
      if (S.hidknown && KNOWN[c.qref]) return false;
      return true;
    });
    if (S.shuffle) shuffleInPlace(keep); else keep.sort(baseSort);
    DECK = keep;
    var want = preserveQref || localStorage.getItem('drill-tcf-pos');
    idx = 0;
    if (want) { for (var i = 0; i < DECK.length; i++) if (DECK[i].qref === want) { idx = i; break; } }
    if (idx >= DECK.length) idx = 0;
  }

  /* ====================== rendering ====================== */
  var wrap = document.getElementById('card-wrap');
  var primaryBtn = document.getElementById('primary');
  var starBtn = document.getElementById('star');
  var backBtn = document.getElementById('back');
  var stat = document.getElementById('stat');
  var progressFill = document.getElementById('progress-fill');
  var hint = document.getElementById('hint');
  var player = document.getElementById('player');
  var audioBar = document.getElementById('audio-bar');
  var audioLabel = document.getElementById('audio-label');

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  /* The English line is always built but stays hidden by CSS until the card is revealed. */
  function bilingual(host, fr, en, frCls) {
    host.appendChild(el('div', 'cr-fr' + (frCls ? ' ' + frCls : ''), fr));
    if (en) host.appendChild(el('div', 'cr-en', en));
  }

  function setAudio(c) {
    if (c.p.subject !== 'listening' || !c.p.audio) {
      audioBar.style.display = 'none';
      try { player.pause(); } catch (e) {}
      player.removeAttribute('src'); player.dataset.file = '';
      try { player.load(); } catch (e) {}
      return;
    }
    audioBar.style.display = '';
    var src = c.p.audio;
    audioLabel.textContent = '🎧 Test ' + testNum(c.p) + ' · §' + (c.p.section || '?') + ' · Q' + qnum(c.q.qref);
    if (player.dataset.file === src) return;
    player.dataset.file = src;
    player.src = src;
    try { player.load(); } catch (e) {}
    if (S.autoplay) { var pr = player.play(); if (pr && pr.catch) pr.catch(function () {}); }
  }

  function renderCard() {
    wrap.innerHTML = '';
    if (!DECK.length) { renderEmpty(); return; }
    var c = DECK[idx];
    revealed = false;

    var card = el('div', 'cram-card drill-card');

    // meta line
    var meta = el('div', 'cr-meta');
    meta.appendChild(el('span', 'cr-src', srcLabel(c)));
    var knownBadge = el('span', 'cr-known', '★ known');
    knownBadge.style.display = KNOWN[c.qref] ? '' : 'none';
    meta.appendChild(knownBadge);
    card.appendChild(meta);

    // instruction (the question stem) — FR now, EN on reveal
    var stem = el('div', 'cr-stem');
    bilingual(stem, c.q.instruction.fr, c.q.instruction.en);
    card.appendChild(stem);

    // consigne (secondary prompt), if present
    if (c.q.consigne && c.q.consigne.fr) {
      var cons = el('div', 'cr-consigne');
      cons.appendChild(el('span', 'cr-consigne-lbl', 'Consigne'));
      bilingual(cons, c.q.consigne.fr, c.q.consigne.en);
      card.appendChild(cons);
    }

    // reading passage — VISIBLE upfront (you need it to answer). Listening transcript stays hidden.
    if (c.p.subject === 'reading' && c.p.transcript && c.p.transcript.length) {
      var passage = el('div', 'drill-passage');
      c.p.transcript.forEach(function (s) {
        var line = el('div', 'cr-fr', s.fr);
        passage.appendChild(line);
        if (s.en) {
          var lineEn = el('div', 'cr-en drill-only-reveal', s.en);
          passage.appendChild(lineEn);
        }
      });
      card.appendChild(passage);
    }

    // question-level images (Section 1 A/B/C/D drawings for listening, or reading stimulus images)
    (c.q.images || []).forEach(function (im) {
      var img = el('img', 'cr-img'); img.loading = 'lazy'; img.src = 'img/' + im; card.appendChild(img);
    });

    // options — reshuffled every visit, except A/B/C/D letter sets that index into images
    var opts = (c.q.options || []).filter(function (o) { return o && (o.fr || o.en || (o.is_img && o.img)); });
    var letterSet = opts.length > 0 && opts.every(isLetter);
    var ordered = letterSet ? opts.slice() : shuffledDistinct(opts);
    var ul = el('ul', 'cr-opts');
    ordered.forEach(function (o) {
      var li = el('li', 'cr-opt');
      li.dataset.correct = o.correct ? '1' : '0';
      if (o.is_img && o.img) {
        var im2 = el('img', 'cr-img'); im2.src = 'img/' + o.img; im2.loading = 'lazy'; li.appendChild(im2);
      } else if (isLetter(o)) {
        li.classList.add('cr-opt-letter');
        li.appendChild(el('span', 'cr-opt-fr', o.fr.trim()));
      } else {
        bilingual(li, o.fr, o.en, 'cr-opt-fr');
      }
      li.addEventListener('click', function (ev) { ev.stopPropagation(); onOption(li); });
      ul.appendChild(li);
    });
    card.appendChild(ul);

    // listening transcript — hidden until reveal (this is the whole point of drilling)
    if (c.p.subject === 'listening' && c.p.transcript && c.p.transcript.length) {
      var tr = el('div', 'cr-peek drill-only-reveal');
      tr.appendChild(el('div', 'drill-peek-head', '🎧 Transcript'));
      var body = el('div', 'cr-peek-body');
      c.p.transcript.forEach(function (s) { bilingual(body, s.fr, s.en); });
      tr.appendChild(body);
      card.appendChild(tr);
    }

    // rationale — hidden until reveal
    if (c.q.rationale && (c.q.rationale.fr || c.q.rationale.en)) {
      var why = el('div', 'cr-peek drill-only-reveal');
      why.appendChild(el('div', 'drill-peek-head', '💡 Why'));
      var wbody = el('div', 'cr-peek-body');
      bilingual(wbody, c.q.rationale.fr || '', c.q.rationale.en || '');
      why.appendChild(wbody);
      card.appendChild(why);
    }

    wrap.appendChild(card);
    wrap.scrollTop = 0;
    setAudio(c);
    paintReveal();
    paintChrome();
    try { localStorage.setItem('drill-tcf-pos', c.qref); } catch (e) {}
  }

  function renderEmpty() {
    var box = el('div', 'cram-empty');
    box.appendChild(el('div', 'cram-empty-big', '✓'));
    box.appendChild(el('div', null, S.hidknown
      ? 'Nothing left in this set — everything here is marked ‘Got it’.'
      : 'No cards in this set.'));
    var b = el('button', 'cram-act primary', S.hidknown ? 'Show known again' : 'Reset');
    b.addEventListener('click', function () {
      if (S.hidknown) { S.hidknown = false; saveSettings(); syncToggles(); }
      buildDeck(); renderCard();
    });
    box.appendChild(b);
    wrap.innerHTML = ''; wrap.appendChild(box);
    paintChrome();
  }

  function paintReveal() {
    var card = wrap.querySelector('.drill-card'); if (!card) return;
    card.classList.toggle('revealed', revealed);
    var lis = card.querySelectorAll('.cr-opt');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i], correct = li.dataset.correct === '1';
      li.classList.toggle('correct', revealed && correct);
      li.classList.toggle('wrong', revealed && !correct && li.classList.contains('chosen'));
    }
    primaryBtn.textContent = revealed ? 'Next ›' : '👁 Reveal';
    primaryBtn.classList.toggle('go', revealed);
  }

  function paintChrome() {
    var n = DECK.length, pos = n ? idx + 1 : 0;
    progressFill.style.width = n ? (100 * pos / n) + '%' : '0%';
    var tally = (sess.right || sess.wrong) ? '  ·  ✓' + sess.right + ' ✗' + sess.wrong : '';
    stat.textContent = n ? (pos + ' / ' + n + tally) : '0 / 0';
    var c = DECK[idx];
    var known = c && KNOWN[c.qref];
    starBtn.classList.toggle('on', !!known);
    starBtn.textContent = known ? '★ Known' : '☆ Got it';
    backBtn.disabled = !DECK.length || idx <= 0;
  }

  /* ====================== interaction ====================== */
  function doReveal() {
    if (revealed) return;
    revealed = true;
    paintReveal(); paintChrome();
  }
  function onOption(li) {
    if (revealed) return;
    li.classList.add('chosen');
    if (li.dataset.correct === '1') sess.right++; else sess.wrong++;
    doReveal();
  }
  function primaryAction() { if (!revealed) doReveal(); else next(); }
  function next() {
    if (!DECK.length) return;
    if (idx + 1 >= DECK.length) { renderDone(); return; }
    idx++; renderCard();
  }
  function prev() {
    if (!DECK.length || idx === 0) return;
    idx--; renderCard();
  }
  function toggleKnown() {
    var c = DECK[idx]; if (!c) return;
    if (KNOWN[c.qref]) delete KNOWN[c.qref]; else KNOWN[c.qref] = 1;
    saveKnown();
    if (S.hidknown && KNOWN[c.qref]) { var q = (DECK[idx + 1] || DECK[idx - 1] || {}).qref; buildDeck(q); renderCard(); return; }
    var badge = wrap.querySelector('.cr-known');
    if (badge) badge.style.display = KNOWN[c.qref] ? '' : 'none';
    paintChrome();
  }

  function renderDone() {
    try { player.pause(); } catch (e) {}
    var reviewed = DECK.length;
    var box = el('div', 'cram-empty');
    box.appendChild(el('div', 'cram-empty-big', '🏁'));
    box.appendChild(el('div', null, 'End of this set — ' + reviewed + ' card' + (reviewed === 1 ? '' : 's') + '.'
      + ((sess.right || sess.wrong) ? '  You answered ✓' + sess.right + ' / ✗' + sess.wrong + '.' : '')));
    var row = el('div', 'cram-empty-row');
    var again = el('button', 'cram-act primary', S.shuffle ? '🔀 Shuffle again' : '↺ Restart');
    again.addEventListener('click', function () { sess = { right: 0, wrong: 0 }; buildDeck(); idx = 0; renderCard(); });
    row.appendChild(again);
    box.appendChild(row);
    wrap.innerHTML = ''; wrap.appendChild(box);
    progressFill.style.width = '100%';
    stat.textContent = reviewed + ' / ' + reviewed + ((sess.right || sess.wrong) ? '  ·  ✓' + sess.right + ' ✗' + sess.wrong : '');
  }

  document.getElementById('stage').addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest && (t.closest('.cr-opt') || t.closest('details') || t.closest('a') ||
      t.closest('button') || t.closest('.cram-empty'))) return;
    primaryAction();
  });
  primaryBtn.addEventListener('click', function (e) { e.stopPropagation(); primaryAction(); });
  starBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleKnown(); });
  backBtn.addEventListener('click', function (e) { e.stopPropagation(); prev(); });
  document.getElementById('prev').addEventListener('click', function (e) { e.stopPropagation(); prev(); });
  document.getElementById('next-arrow').addEventListener('click', function (e) { e.stopPropagation(); next(); });
  document.getElementById('reset').addEventListener('click', function () { sess = { right: 0, wrong: 0 }; buildDeck(); idx = 0; renderCard(); });

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'audio') return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); primaryAction(); }
    else if (e.key === ' ') { e.preventDefault(); if (player.paused) { var pr = player.play(); if (pr && pr.catch) pr.catch(function () {}); } else player.pause(); }
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); prev(); }
    else if (e.key === 'r' || e.key === 'R') { doReveal(); }
    else if (e.key === 'k' || e.key === 'K') { toggleKnown(); }
    else if (e.key === 's' || e.key === 'S') { setToggle('shuffle', !S.shuffle); }
  });

  // swipe (touch): left = next, right = prev
  var tsx = 0, tsy = 0, tst = 0;
  var stage = document.getElementById('stage');
  stage.addEventListener('touchstart', function (e) { var t = e.changedTouches[0]; tsx = t.clientX; tsy = t.clientY; tst = Date.now(); }, { passive: true });
  stage.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0], dx = t.clientX - tsx, dy = t.clientY - tsy;
    if (Date.now() - tst < 600 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      if (dx < 0) next(); else prev();
    }
  }, { passive: true });

  /* ====================== controls ====================== */
  var scopeEl = document.getElementById('scope');
  var SCOPES = [['all', 'All'], ['listening', '🎧 Listening'], ['reading', '📖 Reading']];
  function renderScope() {
    scopeEl.innerHTML = '';
    SCOPES.forEach(function (d) {
      var counts = CARDS.filter(function (c) { return d[0] === 'all' ? true : c.subject === d[0]; }).length;
      var b = el('button', 'chip' + (S.subject === d[0] ? ' on' : ''), d[1] + ' ' + counts);
      b.addEventListener('click', function () { if (S.subject === d[0]) return; S.subject = d[0]; S.section = 'all'; saveSettings(); renderScope(); renderSections(); buildDeck(); idx = 0; sess = { right: 0, wrong: 0 }; renderCard(); });
      scopeEl.appendChild(b);
    });
  }

  var cefrEl = document.getElementById('cefr');
  function sectionsForSubject() {
    var subj = S.subject === 'all' ? null : S.subject;
    var secs = {};
    CARDS.forEach(function (c) {
      if (subj && c.subject !== subj) return;
      var s = c.p.section; if (s == null) return;
      secs[s] = (secs[s] || 0) + 1;
    });
    return Object.keys(secs).sort(function (a, b) { return +a - +b; }).map(function (k) { return [k, +secs[k]]; });
  }
  function renderSections() {
    var sc = CARDS.filter(inSubject);
    cefrEl.innerHTML = '';
    cefrEl.appendChild(el('span', 'cram-row-lbl', 'Section'));
    var buttons = [['all', 'All ' + sc.length]].concat(sectionsForSubject().map(function (d) { return [String(d[0]), 'Section ' + d[0] + ' · ' + d[1]]; }));
    buttons.forEach(function (d) {
      var b = el('button', 'chip' + (String(S.section) === d[0] ? ' on' : ''), d[1]);
      b.addEventListener('click', function () {
        if (String(S.section) === d[0]) return;
        S.section = d[0]; saveSettings(); renderSections();
        buildDeck(); idx = 0; sess = { right: 0, wrong: 0 }; renderCard();
      });
      cefrEl.appendChild(b);
    });
  }
  function bindToggle(id, key) {
    var el2 = document.getElementById(id);
    if (!el2) return;
    el2.addEventListener('click', function () { setToggle(key, !S[key]); });
  }
  function setToggle(key, val) {
    S[key] = val; saveSettings(); syncToggles();
    if (key === 'autoplay') return;
    var q = DECK.length ? DECK[idx].qref : null;
    buildDeck(q); renderCard();
  }
  function syncToggles() {
    var ids = ['t-shuffle','t-hidknown','t-autoplay'];
    var keys = ['shuffle','hidknown','autoplay'];
    ids.forEach(function (id, i) { var el2 = document.getElementById(id); if (el2) el2.classList.toggle('on', !!S[keys[i]]); });
    renderScope();
    renderSections();
  }
  bindToggle('t-shuffle', 'shuffle');
  bindToggle('t-hidknown', 'hidknown');
  bindToggle('t-autoplay', 'autoplay');

  var hintDone = localStorage.getItem('drill-tcf-hint') === '1';
  if (hintDone) hint.style.display = 'none';
  function killHint() { if (hintDone) return; hintDone = true; localStorage.setItem('drill-tcf-hint', '1'); hint.style.display = 'none'; }
  document.getElementById('stage').addEventListener('click', killHint);
  primaryBtn.addEventListener('click', killHint);

  /* ====================== boot ====================== */
  syncToggles();
  buildDeck();
  renderCard();
})();
