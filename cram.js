(function () {
  /* TCF · ⚡ Cram: full-screen flashcard stack for fast recognition memorisation.
     One question per card (stem + MCQ options), correct option lit green.
     Default flow: tap → reveal → tap → next. Optional self-test by tapping the
     option you think is right. Subject/section/shuffle/FR-only/known toggles.
     Reads data.js (window.PASSAGES). Listening cards get a ▶ button for the
     per-question clip; reading cards show the passage or image up-front. No
     dupes, no CEFR — TCF doesn't publish one. */
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

  /* ---- settings (persisted) ---- */
  var S = { subject: 'all', section: 'all', level: 'all', shuffle: false, reveal: false, fr: false, hidknown: false, timer: true };
  try { var saved = JSON.parse(localStorage.getItem('cram-tcf-set') || '{}'); for (var k in saved) if (k in S) S[k] = saved[k]; } catch (e) {}
  function saveSettings() { try { localStorage.setItem('cram-tcf-set', JSON.stringify(S)); } catch (e) {} }

  /* ---- known set (qref -> 1) ---- */
  var KNOWN = {};
  try { (JSON.parse(localStorage.getItem('cram-tcf-known') || '[]') || []).forEach(function (q) { KNOWN[q] = 1; }); } catch (e) {}
  function saveKnown() { try { localStorage.setItem('cram-tcf-known', JSON.stringify(Object.keys(KNOWN))); } catch (e) {} }
  /* ---- repeated questions were merged into one card: move saved marks onto the kept card ---- */
  var ALIAS = window.QREF_ALIAS || {};
  (function () { var moved = false; for (var q in KNOWN) if (ALIAS[q]) { KNOWN[ALIAS[q]] = 1; delete KNOWN[q]; moved = true; } if (moved) saveKnown(); })();

  /* ---- helpers ---- */
  function qnum(qref) { var m = (qref || '').match(/#Q?(\d+)/); return m ? m[1] : ''; }
  function testNum(p) { return p.testNum || 0; }
  function testName(p) { return p.testLabel || ('Test ' + testNum(p)); }
  function srcLabel(c) {
    var sub = c.p.subject === 'listening' ? '🎧' : '📖';
    return sub + ' ' + testName(c.p) + ' · §' + (c.p.section || '?') + ' · Q' + qnum(c.q.qref) + (c.p.seenIn > 1 ? ' · in ' + c.p.seenIn + ' tests' : '');
  }
  function isLetter(o) { return o && !o.is_img && typeof o.fr === 'string' && o.fr.trim().length <= 2 && (!o.en || o.en.trim() === o.fr.trim()); }

  /* ---- one shared audio element for the ▶ clip button ---- */
  var audio = new Audio(); audio.preload = 'none';
  function stopAudio() { try { audio.pause(); } catch (e) {} }

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
  function inLevel(c) { return S.level === 'all' || c.p.cefr === S.level; }
  function baseSort(a, b) {
    // listening first, then reading; within each, test # then Q #
    var sa = a.subject === 'listening' ? 0 : 1, sb = b.subject === 'listening' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    var ta = testNum(a.p), tb = testNum(b.p);
    if (ta !== tb) return ta - tb;
    return (+qnum(a.q.qref) || 0) - (+qnum(b.q.qref) || 0);
  }
  function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }

  var DECK = [];        // current ordered/filtered list of cards
  var idx = 0;          // position in DECK
  var revealed = false;
  var guessed = null;   // option index the user tapped, or null
  var sess = { right: 0, wrong: 0 };
  var autoTimer = null; // 10s auto-advance timeout handle

  function buildDeck(preserveQref) {
    var keep = CARDS.filter(function (c) {
      if (!inSubject(c)) return false;
      if (!inSection(c)) return false;
      if (!inLevel(c)) return false;
      if (S.hidknown && KNOWN[c.qref]) return false;
      return true;
    });
    if (S.shuffle) shuffleInPlace(keep); else keep.sort(baseSort);
    DECK = keep;
    var want = preserveQref || localStorage.getItem('cram-tcf-pos');
    if (want && ALIAS[want]) want = ALIAS[want];
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
  var timerbar = document.getElementById('timerbar');
  var timerfill = document.getElementById('timerfill');
  var hint = document.getElementById('hint');

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function bilingual(host, fr, en, frCls) {
    var f = el('div', 'cr-fr' + (frCls ? ' ' + frCls : ''), fr); host.appendChild(f);
    if (!S.fr && en) host.appendChild(el('div', 'cr-en', en));
  }

  /* ---- 10s auto-advance timer + depleting countdown bar ---- */
  var AUTO_MS = 10000;
  function hideTimerBar() {
    timerbar.style.display = 'none';
    timerfill.style.transition = 'none';
    timerfill.style.width = '100%';
  }
  function runTimerBar() {
    timerbar.style.display = '';
    timerbar.classList.toggle('phase2', revealed);
    timerfill.style.transition = 'none';
    timerfill.style.width = '100%';
    void timerfill.offsetWidth;
    timerfill.style.transition = 'width ' + (AUTO_MS / 1000) + 's linear';
    timerfill.style.width = '0%';
  }
  function clearTimer() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
  function stopTimer() { clearTimer(); hideTimerBar(); }
  function startTimer() {
    clearTimer();
    if (!S.timer || !DECK.length) { hideTimerBar(); return; }
    runTimerBar();
    autoTimer = setTimeout(function () {
      autoTimer = null;
      if (!revealed) doReveal();
      else next();
    }, AUTO_MS);
  }

  function renderCard() {
    stopAudio();
    clearTimer();
    wrap.innerHTML = '';
    if (!DECK.length) { renderEmpty(); hideTimerBar(); return; }
    var c = DECK[idx];
    revealed = S.reveal; guessed = null;

    var card = el('div', 'cram-card');
    card.classList.toggle('revealed', revealed);

    // meta line
    var meta = el('div', 'cr-meta');
    if (c.p.cefr) meta.appendChild(el('span', 'cr-cefr', c.p.cefr));
    meta.appendChild(el('span', 'cr-src', srcLabel(c)));
    if (KNOWN[c.qref]) meta.appendChild(el('span', 'cr-known', '★ known'));
    card.appendChild(meta);

    // instruction (the question stem)
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

    // audio (listening only). One clip per question in TCF.
    if (c.p.audio && c.p.subject === 'listening') {
      var ab = el('div', 'cr-audiobar');
      var pb = el('button', 'cr-audiobtn', '▶ Play clip');
      var playClip = function (restart) {
        if (audio.dataset.file !== c.p.audio) { audio.src = c.p.audio; audio.dataset.file = c.p.audio; }
        else if (restart) { try { audio.currentTime = 0; } catch (e) {} }
        var pr = audio.play(); if (pr && pr.catch) pr.catch(function () {});
      };
      pb.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!audio.paused && audio.dataset.file === c.p.audio) audio.pause();
        else playClip(audio.ended);
      });
      audio.onplay = function () { pb.textContent = '⏸ Pause'; };
      audio.onpause = function () { pb.textContent = '▶ Play clip'; };
      audio.onended = function () { pb.textContent = '↻ Replay clip'; };
      ab.appendChild(pb);
      card.appendChild(ab);
      if (!revealed) playClip(true);
    }

    // question-level images (Section 1 A/B/C/D listening drawings, or reading passage images)
    (c.q.images || []).forEach(function (im) {
      var img = el('img', 'cr-img'); img.loading = 'lazy'; img.src = 'img/' + im; card.appendChild(img);
    });

    // transcript (listening) / passage (reading) — shown open by default, collapsible
    if (c.p.transcript && c.p.transcript.length) {
      var det = el('details', 'cr-peek');
      if (localStorage.getItem('cram-tcf-peektr') !== '0') det.open = true;
      det.addEventListener('toggle', function () { localStorage.setItem('cram-tcf-peektr', det.open ? '1' : '0'); });
      var label = c.p.subject === 'listening' ? '🎧 Transcript' : '📖 Passage';
      det.appendChild(el('summary', null, label));
      var body = el('div', 'cr-peek-body');
      c.p.transcript.forEach(function (s) { bilingual(body, s.fr, s.en); });
      det.appendChild(body); card.appendChild(det);
    }

    // options
    var opts = (c.q.options || []).filter(function (o) { return o && (o.fr || o.en || (o.is_img && o.img)); });
    var ul = el('ul', 'cr-opts');
    opts.forEach(function (o) {
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

    // rationale — hidden until reveal (like a "💡 Why" collapsible)
    if (c.q.rationale && (c.q.rationale.fr || c.q.rationale.en)) {
      var why = el('details', 'cr-why');
      why.open = true;
      why.appendChild(el('summary', null, '💡 Why'));
      var wbody = el('div', 'cr-peek-body');
      bilingual(wbody, c.q.rationale.fr || '', c.q.rationale.en || '');
      why.appendChild(wbody);
      card.appendChild(why);
    }

    wrap.appendChild(card);
    wrap.scrollTop = 0;
    paintReveal();
    paintChrome();
    startTimer();
    try { localStorage.setItem('cram-tcf-pos', c.qref); } catch (e) {}
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
    var card = wrap.querySelector('.cram-card'); if (!card) return;
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
    stopAudio();
    paintReveal(); paintChrome();
    startTimer();
  }
  function onOption(li) {
    if (revealed) return;
    li.classList.add('chosen');
    if (li.dataset.correct === '1') sess.right++; else sess.wrong++;
    doReveal();
  }
  function primaryAction() {
    if (!revealed) doReveal();
    else next();
  }
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
    if (S.hidknown && KNOWN[c.qref]) { var q = (DECK[idx + 1] || DECK[idx - 1] || {}).qref; buildDeck(q); renderCard(); }
    else { paintChrome(); var card = wrap.querySelector('.cram-card'); if (card) renderCard(); }
  }

  function renderDone() {
    stopAudio();
    stopTimer();
    var reviewed = DECK.length;
    var box = el('div', 'cram-empty');
    box.appendChild(el('div', 'cram-empty-big', '🏁'));
    box.appendChild(el('div', null, 'End of this set — ' + reviewed + ' card' + (reviewed === 1 ? '' : 's') + '.'
      + ((sess.right || sess.wrong) ? '  You guessed ✓' + sess.right + ' / ✗' + sess.wrong + '.' : '')));
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
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); primaryAction(); }
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
      b.addEventListener('click', function () { if (S.subject === d[0]) return; S.subject = d[0]; S.section = 'all'; saveSettings(); renderScope(); renderSections(); renderLevels(); buildDeck(); idx = 0; sess = { right: 0, wrong: 0 }; renderCard(); });
      scopeEl.appendChild(b);
    });
  }

  // Section filter — counts reflect the current subject
  var cefrEl = document.getElementById('cefr');
  function sectionsForSubject() {
    var subj = S.subject === 'all' ? null : S.subject;
    var secs = {};
    CARDS.forEach(function (c) {
      if (subj && c.subject !== subj) return;
      var s = c.p.section; if (s == null) return;
      if (!(s in secs)) secs[s] = 0;   // keep every section chip, even at 0 for this level
      if (inLevel(c)) secs[s]++;
    });
    return Object.keys(secs).sort(function (a, b) { return +a - +b; }).map(function (k) { return [k, +secs[k]]; });
  }
  function renderSections() {
    var sc = CARDS.filter(function (c) { return inSubject(c) && inLevel(c); });
    cefrEl.innerHTML = '';
    cefrEl.appendChild(el('span', 'cram-row-lbl', 'Section'));
    var buttons = [['all', 'All ' + sc.length]].concat(sectionsForSubject().map(function (d) { return [String(d[0]), 'Section ' + d[0] + ' · ' + d[1]]; }));
    buttons.forEach(function (d) {
      var b = el('button', 'chip' + (String(S.section) === d[0] ? ' on' : ''), d[1]);
      b.addEventListener('click', function () {
        if (String(S.section) === d[0]) return;
        S.section = d[0]; saveSettings(); renderSections(); renderLevels();
        buildDeck(); idx = 0; sess = { right: 0, wrong: 0 }; renderCard();
      });
      cefrEl.appendChild(b);
    });
  }

  // CEFR level filter (A1-C2, from the source data) — counts reflect subject + section
  var levelEl = document.getElementById('level');
  var BANDS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  function renderLevels() {
    if (!levelEl) return;
    var sc = CARDS.filter(function (c) { return inSubject(c) && inSection(c); });
    var counts = {}; BANDS.forEach(function (b) { counts[b] = 0; });
    sc.forEach(function (c) { if (counts[c.p.cefr] != null) counts[c.p.cefr]++; });
    levelEl.innerHTML = '';
    levelEl.appendChild(el('span', 'cram-row-lbl', 'Level'));
    [['all', 'All ' + sc.length]].concat(BANDS.map(function (b) { return [b, b + ' ' + counts[b]]; })).forEach(function (d) {
      var b = el('button', 'chip' + (S.level === d[0] ? ' on' : ''), d[1]);
      b.addEventListener('click', function () {
        if (S.level === d[0]) return;
        S.level = d[0]; saveSettings(); renderLevels(); renderSections();
        buildDeck(); idx = 0; sess = { right: 0, wrong: 0 }; renderCard();
      });
      levelEl.appendChild(b);
    });
  }
  function bindToggle(id, key) {
    var b = document.getElementById(id);
    if (!b) return;
    b.addEventListener('click', function () { setToggle(key, !S[key]); });
  }
  function setToggle(key, val) {
    S[key] = val; saveSettings(); syncToggles();
    if (key === 'timer') {
      if (S.timer) startTimer(); else stopTimer();
    } else if (key === 'reveal' || key === 'fr') {
      if (key === 'reveal') { revealed = S.reveal; }
      renderCard();
    } else {
      var q = DECK.length ? DECK[idx].qref : null;
      buildDeck(q); renderCard();
    }
  }
  function syncToggles() {
    var ids = ['t-reveal','t-timer','t-shuffle','t-fr','t-hidknown'];
    var keys = ['reveal','timer','shuffle','fr','hidknown'];
    ids.forEach(function (id, i) { var el2 = document.getElementById(id); if (el2) el2.classList.toggle('on', !!S[keys[i]]); });
    renderScope();
    renderLevels();
    renderSections();
  }
  bindToggle('t-reveal', 'reveal');
  bindToggle('t-timer', 'timer');
  bindToggle('t-shuffle', 'shuffle');
  bindToggle('t-fr', 'fr');
  bindToggle('t-hidknown', 'hidknown');

  var hintDone = localStorage.getItem('cram-tcf-hint') === '1';
  if (hintDone) hint.style.display = 'none';
  function killHint() { if (hintDone) return; hintDone = true; localStorage.setItem('cram-tcf-hint', '1'); hint.style.display = 'none'; }
  document.getElementById('stage').addEventListener('click', killHint);
  primaryBtn.addEventListener('click', killHint);

  /* ====================== boot ====================== */
  syncToggles();
  buildDeck();
  renderCard();
})();
