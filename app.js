/*
 * Car Karaoke: synced lyrics for the Tesla in-car browser.
 *
 * Three ways to follow a song:
 *   1. Manual (always works): search LRCLIB, then tap the line being sung
 *      (or press Start when the song begins). Nudge with the two arrow buttons.
 *   2. Spotify (hands-free): reads your account's "currently playing" track and
 *      position every few seconds and keeps the lyrics locked to it.
 *   3. Listen: records a short clip with the cabin mic, identifies the song and
 *      its position with AudD, then jumps the lyrics there.
 *
 * Plain JavaScript, no build step, no server. Settings live in this browser.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  var VERSION = '1.0.0';
  var LRCLIB = 'https://lrclib.net';
  var LRCLIB_CLIENT = 'CarKaraoke/' + VERSION + ' (' + location.origin + ')';
  var SPOTIFY_SCOPES = 'user-read-currently-playing';
  var TAP_LAG = 0.3;      // seconds: people tap a line a little after it starts
  var LEAD = 0.15;        // seconds: highlight a line slightly early so your eye gets there first
  var NUDGE = 0.5;        // seconds per nudge button press
  var SIZES = { M: 44, L: 56, XL: 68, XXL: 84 };
  var CACHE_MAX = 40;

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtOffset(o) {
    var r = Math.round(o * 10) / 10;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1) + ' s';
  }
  function norm(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/['’`]/g, '')
      .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('ck.' + k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('ck.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del: function (k) { try { localStorage.removeItem('ck.' + k); } catch (e) { /* ignore */ } },
    works: function () {
      try { localStorage.setItem('ck.t', '1'); localStorage.removeItem('ck.t'); return true; }
      catch (e) { return false; }
    }
  };

  function fetchWithTimeout(url, opts, ms) {
    opts = opts || {};
    if (!window.AbortController) return fetch(url, opts);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 12000);
    opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  var defaults = {
    textSize: 'L',
    showBar: true,
    spotifyClientId: '',
    followSpotify: true,
    spotifyOffset: 0,
    auddToken: '',
    auddProxy: '',
    clipSeconds: 8,
    autoListen: false
  };
  var settings = Object.assign({}, defaults, store.get('settings', {}));
  function saveSettings() { store.set('settings', settings); }

  // A Client ID can also come from the address, so a car bookmark can restore it
  // even if the browser forgets saved settings: .../#cid=YOUR_CLIENT_ID
  (function readCidFromUrl() {
    var m = (location.hash + '&' + location.search).match(/[#?&]cid=([A-Za-z0-9]{16,64})/);
    if (m && m[1] !== settings.spotifyClientId) { settings.spotifyClientId = m[1]; saveSettings(); }
  })();

  // ------------------------------------------------------------------
  // Playback clock: where we think the song is, in seconds
  // ------------------------------------------------------------------
  var clock = {
    running: false,
    anchorPos: 0,
    anchorAt: 0,
    pos: function () {
      return this.running ? this.anchorPos + (performance.now() - this.anchorAt) / 1000 : this.anchorPos;
    },
    set: function (p, run) {
      this.anchorPos = Math.max(0, p);
      this.anchorAt = performance.now();
      if (run !== undefined) this.running = !!run;
    },
    play: function () { if (!this.running) { this.anchorAt = performance.now(); this.running = true; } },
    pause: function () { if (this.running) { this.anchorPos = this.pos(); this.running = false; } }
  };

  // ------------------------------------------------------------------
  // Song state
  // ------------------------------------------------------------------
  function newSong(o) {
    return {
      key: o.key || null,
      title: o.title || '',
      artist: o.artist || '',
      album: o.album || '',
      duration: o.duration || 0,
      source: o.source || 'manual',  // manual | spotify | listen
      lines: [],                       // [{t, text, gap, el}]
      synced: false,
      instrumental: false,
      loading: false,
      anchors: [],                     // plain lyrics only: [{i, t}]
      offset: 0                        // per-song nudge (manual + listen)
    };
  }
  var song = newSong({});
  var loadSeq = 0;
  var activeIdx = -2;

  function currentOffset() {
    return song.source === 'spotify' ? settings.spotifyOffset : song.offset;
  }
  function displayPos() { return clock.pos() + currentOffset(); }

  // ------------------------------------------------------------------
  // LRC parsing and plain-lyrics timing
  // ------------------------------------------------------------------
  var TS = '\\[(\\d{1,3}):(\\d{1,2}(?:[.:]\\d{1,3})?)\\]';
  var LEAD_TAGS = new RegExp('^\\s*(?:' + TS + '\\s*)+');
  var ONE_TAG = new RegExp(TS, 'g');

  function hasTimestamps(text) {
    return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text || '');
  }

  function parseLRC(raw) {
    var out = [];
    var offsetMs = 0;
    String(raw || '').replace(/\r/g, '').split('\n').forEach(function (line) {
      var meta = line.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (meta) { offsetMs = parseInt(meta[1], 10) || 0; return; }
      var lead = line.match(LEAD_TAGS);
      if (!lead) return;
      var tags = lead[0];
      var text = line.slice(tags.length)
        .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')   // word-level tags, if any
        .replace(/\s+/g, ' ').trim();
      var m;
      ONE_TAG.lastIndex = 0;
      while ((m = ONE_TAG.exec(tags))) {
        var t = parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'));
        if (isFinite(t)) out.push({ t: t, text: text });
      }
    });
    out.sort(function (a, b) { return a.t - b.t; });
    if (offsetMs) out.forEach(function (l) { l.t = Math.max(0, l.t - offsetMs / 1000); });
    return out;
  }

  // Turn parsed LRC into display lines: blank lines become gap markers,
  // repeated gaps collapse, and a long intro gets its own marker.
  function buildSyncedLines(parsed) {
    var lines = [];
    parsed.forEach(function (p) {
      var gap = p.text === '';
      if (gap && lines.length && lines[lines.length - 1].gap) return;
      lines.push({ t: p.t, text: gap ? '• • •' : p.text, gap: gap });
    });
    while (lines.length && lines[0].gap && lines.length > 1 && lines[1].gap) lines.shift();
    if (lines.length && !lines[0].gap && lines[0].t > 4) lines.unshift({ t: 0, text: '• • •', gap: true });
    return lines;
  }

  function buildPlainLines(text) {
    return String(text || '').replace(/\r/g, '').split('\n')
      .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(function (s) { return s.length > 0; })
      .map(function (s) { return { t: 0, text: s, gap: false }; });
  }

  // Plain lyrics have no times. Spread lines evenly over the song, then bend
  // that estimate to fit every line you tap (piecewise-linear between taps).
  function retimePlain() {
    var n = song.lines.length;
    if (!n) return;
    var dur = song.duration || 0;
    var start = dur ? Math.min(15, dur * 0.08) : 8;
    var defStep = dur ? Math.max(2, (dur * 0.88 - start) / n) : 3.5;
    var a = song.anchors.slice().sort(function (x, y) { return x.i - y.i; });
    var step = defStep;
    if (a.length >= 2 && a[a.length - 1].i > a[0].i) {
      step = Math.max(1, (a[a.length - 1].t - a[0].t) / (a[a.length - 1].i - a[0].i));
    }
    for (var i = 0; i < n; i++) {
      var t;
      if (!a.length) t = start + i * defStep;
      else if (i <= a[0].i) t = a[0].t - (a[0].i - i) * step;
      else if (i >= a[a.length - 1].i) t = a[a.length - 1].t + (i - a[a.length - 1].i) * step;
      else {
        var j = 0;
        while (a[j + 1].i < i) j++;
        var p = a[j], q = a[j + 1];
        t = p.t + (q.t - p.t) * (i - p.i) / (q.i - p.i);
      }
      song.lines[i].t = Math.max(0, t);
    }
  }

  function addPlainAnchor(i, t) {
    song.anchors = song.anchors.filter(function (a) {
      if (a.i === i) return false;
      if (a.i < i && a.t >= t) return false;   // would run backwards
      if (a.i > i && a.t <= t) return false;
      return true;
    });
    song.anchors.push({ i: i, t: t });
    retimePlain();
  }

  // Index of the line to highlight at position p (−1 = before the first line)
  function lineIndexAt(p) {
    var lines = song.lines;
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // ------------------------------------------------------------------
  // LRCLIB lyrics lookup (free, no key, browser-friendly)
  // ------------------------------------------------------------------
  var lrclibUseHeader = true;
  var memMisses = {};

  function lrclibGet(path) {
    var opts = { headers: lrclibUseHeader ? { 'Lrclib-Client': LRCLIB_CLIENT } : {} };
    return fetchWithTimeout(LRCLIB + path, opts, 12000).then(function (res) {
      if (res.status === 404) return null;
      if (res.status === 429) throw new Error('Lyrics server is busy, try again in a few seconds');
      if (!res.ok) throw new Error('Lyrics server error (' + res.status + ')');
      return res.json();
    }, function (e) {
      // If the browser refused our identification header, retry once without it.
      if (lrclibUseHeader && e && e.name !== 'AbortError') { lrclibUseHeader = false; return lrclibGet(path); }
      throw new Error(e && e.name === 'AbortError' ? 'Lyrics server timed out' : 'Could not reach the lyrics server');
    });
  }

  function cleanTitle(t) {
    var c = String(t || '')
      .replace(/\s*[\(\[](?:feat\.?|ft\.?|with)\s[^\)\]]*[\)\]]/ig, '')
      .replace(/\s*[\(\[][^\)\]]*(?:remaster|version|edit|live|mono|stereo|mix)[^\)\]]*[\)\]]/ig, '')
      .replace(/\s+-\s+.*(?:remaster|version|edit|mix|live|mono|stereo|from|feat).*$/i, '')
      .trim();
    return c || String(t || '');
  }

  function cacheKey(meta) { return norm(meta.artist) + '|' + norm(cleanTitle(meta.title)); }
  function cacheGet(k) {
    var c = store.get('cache', {});
    return c[k] ? c[k].r : null;
  }
  function cachePut(k, rec) {
    var c = store.get('cache', {});
    c[k] = {
      at: Date.now(),
      r: {
        id: rec.id, trackName: rec.trackName, artistName: rec.artistName, albumName: rec.albumName,
        duration: rec.duration, instrumental: rec.instrumental,
        syncedLyrics: rec.syncedLyrics, plainLyrics: rec.plainLyrics
      }
    };
    var keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      keys.sort(function (a, b) { return c[a].at - c[b].at; });
      keys.slice(0, keys.length - CACHE_MAX).forEach(function (x) { delete c[x]; });
    }
    store.set('cache', c);
  }

  function pickBest(list, meta) {
    if (!list || !list.length) return null;
    var wantTitle = norm(cleanTitle(meta.title));
    var wantArtist = norm(meta.artist);
    var best = null, bestScore = Infinity;
    list.forEach(function (r) {
      var score = 0;
      var rt = norm(cleanTitle(r.trackName)), ra = norm(r.artistName);
      if (wantTitle && rt.indexOf(wantTitle) < 0 && wantTitle.indexOf(rt) < 0) score += 100;
      if (wantArtist && ra.indexOf(wantArtist) < 0 && wantArtist.indexOf(ra) < 0) score += 25;
      if (!r.syncedLyrics) score += 15;
      if (!r.syncedLyrics && !r.plainLyrics) score += 60;
      if (meta.duration && r.duration) score += Math.min(30, Math.abs(r.duration - meta.duration));
      if (score < bestScore) { bestScore = score; best = r; }
    });
    return bestScore < 70 ? best : null;
  }

  // Find lyrics for {title, artist, album?, duration?}. Resolves to a record or null.
  function findLyrics(meta) {
    var key = cacheKey(meta);
    var cached = cacheGet(key);
    if (cached) return Promise.resolve(cached);
    if (memMisses[key] && Date.now() - memMisses[key] < 10 * 60 * 1000) return Promise.resolve(null);

    var q = '?track_name=' + encodeURIComponent(meta.title) + '&artist_name=' + encodeURIComponent(meta.artist);
    if (meta.album) q += '&album_name=' + encodeURIComponent(meta.album);
    if (meta.duration) q += '&duration=' + Math.round(meta.duration);

    return lrclibGet('/api/get' + q).then(function (rec) {
      if (rec && (rec.syncedLyrics || rec.plainLyrics || rec.instrumental)) return rec;
      var q2 = '?track_name=' + encodeURIComponent(cleanTitle(meta.title)) +
               '&artist_name=' + encodeURIComponent(meta.artist);
      return lrclibGet('/api/search' + q2).then(function (list) {
        var best = pickBest(list, meta);
        if (best) return best;
        return lrclibGet('/api/search?q=' + encodeURIComponent(cleanTitle(meta.title) + ' ' + meta.artist))
          .then(function (list2) { return pickBest(list2, meta); });
      });
    }).then(function (rec) {
      if (rec) cachePut(key, rec); else memMisses[key] = Date.now();
      return rec;
    });
  }

  // Fill the current song from an LRCLIB record (or pasted text).
  function applyRecord(rec) {
    song.instrumental = !!rec.instrumental;
    if (!song.duration && rec.duration) song.duration = rec.duration;
    if (rec.syncedLyrics && hasTimestamps(rec.syncedLyrics)) {
      song.lines = buildSyncedLines(parseLRC(rec.syncedLyrics));
      song.synced = song.lines.length > 0;
    }
    if (!song.synced) {
      song.lines = buildPlainLines(rec.plainLyrics || '');
      song.anchors = [];
      retimePlain();
    }
  }

  // ------------------------------------------------------------------
  // Loading songs
  // ------------------------------------------------------------------
  // From a search result: you start the timing yourself.
  function loadManualRecord(rec) {
    loadSeq++;
    setFollow(false, true);
    song = newSong({
      key: 'lr:' + rec.id, title: rec.trackName, artist: rec.artistName,
      album: rec.albumName, duration: rec.duration, source: 'manual'
    });
    applyRecord(rec);
    clock.set(0, false);
    renderAll();
    if (song.instrumental) setBanner('Instrumental, no lyrics');
    else setBanner(song.synced
      ? 'Tap the line being sung, or press Start when the song begins'
      : 'Plain lyrics (no timing). Tap the line being sung to sync, tap again later to fine-tune');
  }

  // From Spotify or Listen: we already know the position, so the clock starts
  // right away and the lyrics drop in when they arrive.
  function loadForMeta(meta, source, o) {
    var id = ++loadSeq;
    song = newSong({
      key: o.key, title: meta.title, artist: meta.artist, album: meta.album,
      duration: meta.duration, source: source
    });
    song.loading = true;
    clock.set(o.pos || 0, !!o.playing);
    renderAll();
    setBanner('Finding lyrics…');
    return findLyrics(meta).then(function (rec) { return { rec: rec }; },
      function (err) { return { err: err }; })
      .then(function (r) {
        if (id !== loadSeq) return;   // another song took over meanwhile
        song.loading = false;
        if (r.rec) {
          applyRecord(r.rec);
          renderAll();
          if (song.instrumental) setBanner('Instrumental, no lyrics');
          else if (!song.synced) setBanner('Plain lyrics only. Tap the line being sung to sync');
          else setBanner('');
        } else {
          renderAll();
          setBanner(r.err ? r.err.message : 'No lyrics found for “' + meta.title + '”');
        }
      });
  }

  function loadPasted(title, text) {
    loadSeq++;
    setFollow(false, true);
    song = newSong({ key: 'paste:' + Date.now(), title: title || 'Pasted lyrics', artist: '', source: 'manual' });
    applyRecord({ syncedLyrics: hasTimestamps(text) ? text : null, plainLyrics: text });
    clock.set(0, false);
    renderAll();
    setBanner('Tap the line being sung, or press Start when the song begins');
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  var lyricsEl = $('lyrics');
  var userScrollUntil = 0;

  function renderAll() {
    renderHeader();
    renderLyrics();
    renderControls();
  }

  function renderHeader() {
    $('songTitle').textContent = song.title || 'No song loaded';
    $('songArtist').textContent = song.title
      ? [song.artist, song.album].filter(Boolean).join(' · ') || ' '
      : 'Search a song, tap Listen, or connect Spotify in Settings';
    renderChip();
    renderOffset();
  }

  function renderChip() {
    var chip = $('modeChip');
    chip.className = 'chip';
    if (spotify.connected()) {
      if (settings.followSpotify) {
        chip.className = 'chip spotify';
        chip.textContent = spotify.statusText || 'Spotify';
      } else {
        chip.className = 'chip spotify paused';
        chip.textContent = 'Spotify off · tap to follow';
      }
      return;
    }
    if (song.source === 'listen') { chip.className = 'chip listen'; chip.textContent = 'Mic sync'; return; }
    chip.textContent = song.title ? (song.synced ? 'Manual' : 'Manual · estimated') : 'Manual';
  }

  function renderOffset() {
    var o = currentOffset();
    $('offsetReadout').textContent = Math.abs(o) >= 0.05 ? 'timing ' + fmtOffset(o) : '';
  }

  function renderLyrics() {
    lyricsEl.innerHTML = '';
    lyricsEl.classList.toggle('estimated', !song.synced);
    lyricsEl.classList.toggle('loading', song.loading);
    var frag = document.createDocumentFragment();
    song.lines.forEach(function (ln, i) {
      var d = document.createElement('div');
      d.className = 'line' + (ln.gap ? ' gap' : '');
      d.textContent = ln.text;
      d.setAttribute('data-i', i);
      ln.el = d;
      frag.appendChild(d);
    });
    lyricsEl.appendChild(frag);
    $('emptyState').classList.toggle('hidden', !!song.title);
    activeIdx = -2;
    lyricsEl.scrollTop = 0;
  }

  function renderControls() {
    var spotifyDriving = song.source === 'spotify' && settings.followSpotify && spotify.connected();
    var icon = 'i-play', label = 'Start';
    if (spotifyDriving) { icon = 'i-sync'; label = 'Sync'; }
    else if (clock.running) { icon = 'i-pause'; label = 'Pause'; }
    else if (clock.pos() > 0.5) { label = 'Resume'; }
    $('playIcon').setAttribute('href', '#' + icon);
    $('playLabel').textContent = label;
  }

  function setActive(idx) {
    var lines = song.lines;
    for (var i = 0; i < lines.length; i++) {
      var el = lines[i].el;
      if (!el) continue;
      var cls = 'line' + (lines[i].gap ? ' gap' : '');
      if (i < idx) cls += ' past';
      else if (i === idx) cls += ' active';
      else if (i === idx + 1) cls += ' next';
      if (el.className !== cls) el.className = cls;
    }
    var smooth = activeIdx !== -2;   // jump straight there after a reload or a tap
    activeIdx = idx;
    scrollToActive(smooth);
  }

  function scrollToActive(smooth) {
    if (Date.now() < userScrollUntil) return;
    var target = 0;
    var ln = song.lines[activeIdx];
    if (ln && ln.el) {
      target = ln.el.offsetTop - lyricsEl.clientHeight * 0.38 + ln.el.offsetHeight / 2;
    } else if (song.lines[0] && song.lines[0].el) {
      target = song.lines[0].el.offsetTop - lyricsEl.clientHeight * 0.38;
    }
    target = Math.max(0, target);
    if (smooth && lyricsEl.scrollTo) lyricsEl.scrollTo({ top: target, behavior: 'smooth' });
    else lyricsEl.scrollTop = target;
  }

  // Let you scroll the lyrics by hand to find a line; auto-scroll resumes after a few seconds.
  ['touchstart', 'wheel', 'mousedown'].forEach(function (ev) {
    lyricsEl.addEventListener(ev, function () { userScrollUntil = Date.now() + 5000; }, { passive: true });
  });

  var bannerTimer = null;
  function setBanner(text) {
    var b = $('banner');
    clearTimeout(bannerTimer);
    if (!text) { b.classList.add('hidden'); return; }
    b.textContent = text;
    b.classList.remove('hidden');
  }
  function flashBanner(text, ms) {
    setBanner(text);
    bannerTimer = setTimeout(function () { setBanner(''); }, ms || 6000);
  }

  var toastTimer = null;
  function toast(text, ms) {
    var t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 3500);
  }

  // ------------------------------------------------------------------
  // Animation loop
  // ------------------------------------------------------------------
  var lastSecond = -1;
  var lastProgress = -1;

  function frame() {
    var p = displayPos();

    if (song.lines.length) {
      var idx = lineIndexAt(p + LEAD);
      if (idx !== activeIdx) setActive(idx);

      if (settings.showBar && idx >= 0) {
        var ln = song.lines[idx];
        var next = song.lines[idx + 1];
        var end = next ? next.t : (song.duration && song.duration > ln.t ? song.duration : ln.t + 5);
        var frac = clamp((p + LEAD - ln.t) / Math.max(0.5, end - ln.t), 0, 1);
        if (ln.el) ln.el.style.setProperty('--p', frac.toFixed(3));
      }
    }

    var sec = Math.floor(p);
    if (sec !== lastSecond) {
      lastSecond = sec;
      $('timeReadout').textContent = song.duration
        ? fmtTime(p) + ' / ' + fmtTime(song.duration)
        : fmtTime(p);
    }
    var prog = song.duration ? clamp(p / song.duration, 0, 1) : 0;
    if (Math.abs(prog - lastProgress) > 0.001) {
      lastProgress = prog;
      $('progressFill').style.transform = 'scaleX(' + prog.toFixed(4) + ')';
    }

    maybeAutoListen(p);
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------
  // Taps, nudges, play/pause
  // ------------------------------------------------------------------
  function onLineTap(i) {
    var line = song.lines[i];
    if (!line) return;
    userScrollUntil = 0;
    var spotifyDriving = song.source === 'spotify' && settings.followSpotify && spotify.connected() && clock.running;

    if (!song.synced) {
      // Plain lyrics: this line started a moment ago. Bend the estimate to fit.
      if (!clock.running && !spotifyDriving) {
        clock.set(line.t + TAP_LAG - currentOffset(), true);
        addPlainAnchor(i, line.t);
      } else {
        addPlainAnchor(i, Math.max(0, displayPos() - TAP_LAG));
      }
      activeIdx = -2;
      setBanner('');
      renderControls();
      return;
    }

    var target = line.t + TAP_LAG;
    if (spotifyDriving) {
      // Spotify knows the real position; store the difference as a correction.
      settings.spotifyOffset = clamp(target - clock.pos(), -15, 15);
      saveSettings();
      renderOffset();
      toast('Timing set to ' + fmtOffset(settings.spotifyOffset) + ' (remembered for Spotify)');
    } else {
      clock.set(target - currentOffset(), true);
    }
    activeIdx = -2;
    setBanner('');
    renderControls();
  }

  lyricsEl.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.line') : null;
    if (el) onLineTap(parseInt(el.getAttribute('data-i'), 10));
  });

  function nudge(delta) {
    if (!song.title) return;
    if (song.source === 'spotify') {
      settings.spotifyOffset = clamp(settings.spotifyOffset + delta, -15, 15);
      saveSettings();
    } else {
      song.offset = clamp(song.offset + delta, -30, 30);
    }
    renderOffset();
    activeIdx = -2;
  }

  function togglePlay() {
    if (song.source === 'spotify' && settings.followSpotify && spotify.connected()) {
      spotify.pollNow();
      toast('Syncing with Spotify…', 1500);
      return;
    }
    if (!song.title) { openSheet('searchSheet'); return; }
    if (clock.running) clock.pause();
    else {
      clock.play();
      setBanner('');
    }
    renderControls();
  }

  // ------------------------------------------------------------------
  // Spotify (Authorization Code with PKCE: no secret, no server)
  // ------------------------------------------------------------------
  var spotify = {
    token: store.get('sp.token', null),   // {access, refresh, exp}
    trackId: null,
    playing: false,
    statusText: 'Spotify',
    timer: null,
    inflight: false,
    backoffUntil: 0,
    refreshing: null,
    lastPos: 0,
    lastAt: 0,
    duration: 0,
    connected: function () { return !!(this.token && this.token.refresh); },
    pollNow: function () { clearTimeout(this.timer); spPoll(); }
  };

  function redirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  function randString(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    var a = new Uint8Array(len);
    crypto.getRandomValues(a);
    var s = '';
    for (var i = 0; i < len; i++) s += chars[a[i] % chars.length];
    return s;
  }

  function sha256base64url(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      var bytes = new Uint8Array(buf), bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });
  }

  function spConnect() {
    var cid = (settings.spotifyClientId || '').trim();
    if (!cid) { toast('Paste your Spotify Client ID first'); return; }
    if (!window.crypto || !crypto.subtle) { toast('Open this page over https to connect Spotify'); return; }
    var verifier = randString(64);
    var state = randString(16);
    store.set('sp.pkce', { verifier: verifier, state: state, cid: cid });
    sha256base64url(verifier).then(function (challenge) {
      var p = new URLSearchParams({
        response_type: 'code',
        client_id: cid,
        scope: SPOTIFY_SCOPES,
        redirect_uri: redirectUri(),
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state: state
      });
      location.href = 'https://accounts.spotify.com/authorize?' + p.toString();
    });
  }

  function spSaveToken(j) {
    var prev = spotify.token || {};
    spotify.token = {
      access: j.access_token,
      refresh: j.refresh_token || prev.refresh,
      exp: Date.now() + (j.expires_in || 3600) * 1000
    };
    store.set('sp.token', spotify.token);
  }

  function spTokenRequest(params) {
    return fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
    });
  }

  // Finish the login when Spotify sends us back with ?code=...
  function spHandleRedirect() {
    var q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return Promise.resolve();
    var saved = store.get('sp.pkce', null);
    history.replaceState(null, '', redirectUri() + location.hash);
    store.del('sp.pkce');
    if (q.get('error')) { toast('Spotify login cancelled (' + q.get('error') + ')'); return Promise.resolve(); }
    if (!saved || saved.state !== q.get('state')) { toast('Spotify login expired, tap Connect again'); return Promise.resolve(); }
    return spTokenRequest({
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: redirectUri(),
      client_id: saved.cid,
      code_verifier: saved.verifier
    }).then(function (r) {
      if (!r.ok) { toast('Spotify login failed: ' + (r.j.error_description || r.j.error || r.status), 6000); return; }
      spSaveToken(r.j);
      settings.followSpotify = true;
      saveSettings();
      toast('Spotify connected');
    }).catch(function () { toast('Could not reach Spotify to finish login'); });
  }

  function spAccess() {
    var t = spotify.token;
    if (!t) return Promise.resolve(null);
    if (t.access && Date.now() < t.exp - 60000) return Promise.resolve(t.access);
    if (!t.refresh) return Promise.resolve(null);
    if (spotify.refreshing) return spotify.refreshing;
    spotify.refreshing = spTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t.refresh,
      client_id: (settings.spotifyClientId || '').trim()
    }).then(function (r) {
      spotify.refreshing = null;
      if (!r.ok) {
        if (r.status === 400 || r.status === 401) {
          spDisconnect(true);
          toast('Spotify sign-in expired, reconnect in Settings', 6000);
        }
        return null;
      }
      spSaveToken(r.j);
      return spotify.token.access;
    }, function () { spotify.refreshing = null; return null; });
    return spotify.refreshing;
  }

  function spDisconnect(quiet) {
    spotify.token = null;
    spotify.trackId = null;
    store.del('sp.token');
    clearTimeout(spotify.timer);
    if (song.source === 'spotify') { song.source = 'manual'; clock.pause(); }
    renderAll();
    renderSettings();
    if (!quiet) toast('Spotify disconnected');
  }

  function spSchedule() {
    clearTimeout(spotify.timer);
    if (!spotify.connected() || !settings.followSpotify) return;
    var wait = 5000;
    if (document.hidden) wait = 15000;
    else if (spotify.playing) {
      wait = 4000;
      var left = spotify.duration - (spotify.lastPos + (performance.now() - spotify.lastAt) / 1000);
      if (spotify.duration && left < 6) wait = 1500;    // catch the next track quickly
    }
    var back = spotify.backoffUntil - Date.now();
    if (back > wait) wait = back;
    spotify.timer = setTimeout(spPoll, wait);
  }

  function setSpStatus(text) {
    spotify.statusText = text;
    renderChip();
    var el = $('spStatus');
    if (el) {
      el.textContent = spotify.connected() ? text : 'Not connected';
      el.className = 'pill ' + (spotify.connected() ? 'ok' : '');
    }
  }

  function spPoll() {
    if (spotify.inflight || !spotify.connected() || !settings.followSpotify) { spSchedule(); return; }
    spotify.inflight = true;
    var t0 = 0;
    spAccess().then(function (access) {
      if (!access) { setSpStatus('Spotify: sign-in needed'); return; }
      t0 = performance.now();
      return fetchWithTimeout('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: 'Bearer ' + access }
      }, 8000).then(function (res) {
        var mid = (t0 + performance.now()) / 2;
        if (res.status === 204) { spNothing('Nothing playing on Spotify'); return; }
        if (res.status === 401) { spotify.token.exp = 0; return; }
        if (res.status === 403) {
          spotify.backoffUntil = Date.now() + 60000;
          setSpStatus('Spotify refused (403)');
          flashBanner('Spotify said no (403). Check your account is added under User Management and Premium is active', 9000);
          return;
        }
        if (res.status === 429) {
          var ra = parseInt(res.headers.get('Retry-After') || '30', 10);
          spotify.backoffUntil = Date.now() + clamp(ra, 5, 600) * 1000;
          setSpStatus('Spotify: slowing down');
          return;
        }
        if (!res.ok) { setSpStatus('Spotify error ' + res.status); return; }
        return res.json().then(function (j) { spApply(j, mid); });
      });
    }).catch(function () {
      setSpStatus('Spotify unreachable');
    }).then(function () {
      spotify.inflight = false;
      spSchedule();
    });
  }

  function spNothing(msg) {
    spotify.playing = false;
    setSpStatus('Spotify · idle');
    if (song.source === 'spotify') {
      clock.pause();
      renderControls();
      setBanner(msg);
    }
  }

  function spApply(j, sampledAt) {
    var type = j.currently_playing_type;
    if (type === 'ad') {
      spotify.playing = false;
      setSpStatus('Spotify · ad');
      if (song.source === 'spotify') { clock.pause(); setBanner('Ad playing, lyrics resume after'); }
      return;
    }
    var item = j.item;
    if (!item || type !== 'track') {
      spNothing(type === 'episode' ? 'Podcast playing, no lyrics' : 'Nothing playing on Spotify');
      return;
    }
    var playing = !!j.is_playing;
    var pos = (j.progress_ms || 0) / 1000;
    if (playing) pos += (performance.now() - sampledAt) / 1000;

    spotify.playing = playing;
    spotify.lastPos = pos;
    spotify.lastAt = performance.now();
    spotify.duration = (item.duration_ms || 0) / 1000;
    setSpStatus(playing ? 'Spotify · live' : 'Spotify · paused');

    if (item.id !== spotify.trackId || song.source !== 'spotify') {
      spotify.trackId = item.id;
      var artists = (item.artists || []).map(function (a) { return a.name; });
      loadForMeta({
        title: item.name,
        artist: artists[0] || '',
        album: item.album ? item.album.name : '',
        duration: spotify.duration
      }, 'spotify', { pos: pos, playing: playing, key: 'sp:' + item.id });
      renderControls();
      return;
    }

    // Same track: keep our clock locked to Spotify's.
    if (!playing) { clock.set(pos, false); setBanner('Paused on Spotify'); }
    else if (!clock.running) { clock.set(pos, true); setBanner(''); }
    else {
      var drift = pos - clock.pos();
      if (Math.abs(drift) > 1.0) clock.set(pos, true);                    // seek or skip
      else if (Math.abs(drift) > 0.15) clock.set(clock.pos() + drift * 0.5, true); // gentle correction
      if (!song.loading && document.getElementById('banner').textContent === 'Paused on Spotify') setBanner('');
    }
    renderControls();
  }

  function setFollow(on, quiet) {
    if (!spotify.connected()) return;
    if (settings.followSpotify === on) return;
    settings.followSpotify = on;
    saveSettings();
    if (on) {
      spotify.trackId = null;
      spotify.pollNow();
      if (!quiet) toast('Following Spotify');
    } else {
      clearTimeout(spotify.timer);
      if (!quiet) toast('Stopped following Spotify');
    }
    renderChip();
    renderControls();
    var f = $('optFollow');
    if (f) f.checked = settings.followSpotify;
  }

  // ------------------------------------------------------------------
  // Listen: microphone clip → AudD → song + position
  // ------------------------------------------------------------------
  var mic = { stream: null, ctx: null, analyser: null, testing: false };
  var listenState = { busy: false, nextAutoAt: 0 };

  function getMic() {
    if (mic.stream && mic.stream.active) return Promise.resolve(mic.stream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('This browser has no microphone access. Tesla added it in software 2026.26 (AMD Ryzen cars).'));
    }
    // Raw audio: echo cancellation and noise suppression would try to remove the music.
    var raw = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } };
    return navigator.mediaDevices.getUserMedia(raw).catch(function (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'TypeError')) {
        return navigator.mediaDevices.getUserMedia({ audio: true });
      }
      throw e;
    }).then(function (s) { mic.stream = s; return s; });
  }

  function releaseMic() {
    stopMicTest();
    if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); });
    mic.stream = null;
  }

  function micErrorText(e) {
    if (!e) return 'Something went wrong';
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') return 'Microphone permission was denied';
    if (e.name === 'NotFoundError') return 'No microphone found';
    if (e.name === 'NotReadableError') return 'The microphone is busy (a call or voice command?)';
    return e.message || String(e);
  }

  function recorderMime() {
    if (!window.MediaRecorder) return null;
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  function recordClip(stream, secs) {
    var mime = recorderMime();
    if (mime === null) return recordWav(stream, secs);
    return new Promise(function (resolve, reject) {
      var rec;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { recordWav(stream, secs).then(resolve, reject); return; }
      var chunks = [];
      var startedAt = 0;
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstart = function () { startedAt = performance.now(); };
      rec.onerror = function (e) { reject((e && e.error) || new Error('Recording failed')); };
      rec.onstop = function () {
        var type = rec.mimeType || mime || 'audio/webm';
        var ext = type.indexOf('mp4') >= 0 ? 'm4a' : type.indexOf('ogg') >= 0 ? 'ogg' : 'webm';
        resolve({
          blob: new Blob(chunks, { type: type }),
          name: 'clip.' + ext,
          startedAt: startedAt || performance.now() - secs * 1000
        });
      };
      rec.start();
      setTimeout(function () { try { rec.stop(); } catch (e) { /* already stopped */ } }, secs * 1000);
    });
  }

  // Fallback when MediaRecorder is missing: capture raw samples, write a WAV file.
  function recordWav(stream, secs) {
    return new Promise(function (resolve, reject) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { reject(new Error('This browser cannot record audio')); return; }
      var ctx = new AC();
      var src = ctx.createMediaStreamSource(stream);
      var proc = ctx.createScriptProcessor(4096, 1, 1);
      var bufs = [], n = 0;
      var startedAt = performance.now();
      proc.onaudioprocess = function (e) {
        var d = e.inputBuffer.getChannelData(0);
        bufs.push(new Float32Array(d));
        n += d.length;
      };
      src.connect(proc);
      proc.connect(ctx.destination);   // outputs silence; needed so the node runs
      if (ctx.resume) ctx.resume();
      setTimeout(function () {
        src.disconnect(); proc.disconnect();
        var rate = ctx.sampleRate;
        if (ctx.close) ctx.close();
        resolve({ blob: encodeWav(bufs, n, rate), name: 'clip.wav', startedAt: startedAt });
      }, secs * 1000);
    });
  }

  function encodeWav(bufs, n, rate) {
    var buffer = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buffer);
    function w(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    var o = 44;
    bufs.forEach(function (b) {
      for (var i = 0; i < b.length; i++, o += 2) {
        var s = Math.max(-1, Math.min(1, b[i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    });
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function parseTimecode(tc) {
    var parts = String(tc || '0').split(':').map(function (x) { return parseFloat(x) || 0; });
    var s = 0;
    parts.forEach(function (p) { s = s * 60 + p; });
    return s;
  }

  function auddIdentify(clip) {
    var fd = new FormData();
    fd.append('file', clip.blob, clip.name);
    var url = 'https://api.audd.io/';
    var proxy = (settings.auddProxy || '').trim();
    if (proxy) url = proxy;
    else {
      var token = (settings.auddToken || '').trim();
      if (!token) return Promise.reject(new Error('Add your AudD token in Settings first'));
      fd.append('api_token', token);
    }
    return fetchWithTimeout(url, { method: 'POST', body: fd }, 25000).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (j) {
        if (!j) throw new Error('Song-ID service sent an unreadable reply (' + res.status + ')');
        if (j.status === 'error') {
          var code = j.error && j.error.error_code;
          var msg = j.error && j.error.error_message;
          if (code === 900) throw new Error('Your AudD token is not valid');
          if (code === 901) throw new Error('AudD free limit reached, add your own token');
          if (code === 300) throw new Error('Clip too quiet or too short, try a longer clip');
          throw new Error('Song-ID error: ' + (msg || code));
        }
        return j.result || null;
      });
    }, function (e) {
      if (e && e.name === 'AbortError') throw new Error('Song ID timed out (weak signal?)');
      throw new Error('Could not reach the song-ID service. If this keeps happening, set up the proxy (README step 5).');
    });
  }

  function sameSong(meta) {
    if (!song.title) return false;
    var a = norm(cleanTitle(song.title)), b = norm(cleanTitle(meta.title));
    var x = norm(song.artist), y = norm(meta.artist);
    var titleOk = a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
    var artistOk = !x || !y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
    return titleOk && artistOk;
  }

  function setListenUI(busy, text) {
    $('btnListen').classList.toggle('busy', busy);
    $('listenLabel').textContent = busy ? text : 'Listen';
  }

  function listen(auto) {
    if (listenState.busy) return;
    if (!(settings.auddToken || '').trim() && !(settings.auddProxy || '').trim()) {
      toast('Add an AudD token in Settings to use Listen');
      openSheet('settingsSheet');
      return;
    }
    listenState.busy = true;
    setListenUI(true, 'Listening…');
    if (!auto) setBanner('Listening for ' + settings.clipSeconds + ' seconds…');

    getMic().then(function (stream) {
      return recordClip(stream, settings.clipSeconds);
    }).then(function (clip) {
      setListenUI(true, 'Identifying…');
      setBanner('Identifying…');
      return auddIdentify(clip).then(function (r) { return { r: r, clip: clip }; });
    }).then(function (res) {
      var r = res.r;
      if (!r) { flashBanner('Couldn’t recognise it. Try again during a louder part', 5000); return; }
      // AudD's timecode is where the clip sits in the song (whole seconds).
      var tc = parseTimecode(r.timecode);
      var posNow = function () { return tc + (performance.now() - res.clip.startedAt) / 1000; };
      var meta = { title: r.title, artist: r.artist, album: r.album };
      setFollow(false, true);   // Listening means the music isn't coming from Spotify
      if (sameSong(meta) && song.lines.length) {
        song.source = 'listen';
        song.offset = 0;
        clock.set(posNow(), true);
        activeIdx = -2;
        setBanner('');
        renderAll();
        toast('Re-synced “' + r.title + '”');
      } else {
        loadForMeta(meta, 'listen', { pos: posNow(), playing: true, key: 'au:' + norm(r.artist) + '|' + norm(r.title) });
      }
    }).catch(function (e) {
      flashBanner(micErrorText(e), 7000);
    }).then(function () {
      listenState.busy = false;
      listenState.nextAutoAt = Date.now() + 20000;
      setListenUI(false);
      renderControls();
    });
  }

  function maybeAutoListen(p) {
    if (!settings.autoListen || listenState.busy || song.source !== 'listen' || !clock.running) return;
    if (Date.now() < listenState.nextAutoAt) return;
    var last = song.lines.length ? song.lines[song.lines.length - 1].t : 0;
    var end = song.duration ? song.duration + 2 : last + 25;
    if (end > 0 && p > end) listen(true);
  }

  // Microphone test meter (Settings)
  function startMicTest() {
    getMic().then(function (stream) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { $('micReadout').textContent = 'Web Audio is not available'; return; }
      mic.ctx = new AC();
      if (mic.ctx.resume) mic.ctx.resume();
      var src = mic.ctx.createMediaStreamSource(stream);
      mic.analyser = mic.ctx.createAnalyser();
      mic.analyser.fftSize = 2048;
      src.connect(mic.analyser);
      mic.testing = true;
      $('micTest').textContent = 'Stop test';
      var data = new Float32Array(mic.analyser.fftSize);
      var peak = 0;
      (function tick() {
        if (!mic.testing) return;
        if (mic.analyser.getFloatTimeDomainData) mic.analyser.getFloatTimeDomainData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
        var rms = Math.sqrt(sum / data.length);
        var db = rms > 0 ? 20 * Math.log10(rms) : -100;
        peak = Math.max(db, peak - 0.4);
        var level = clamp((db + 60) / 60, 0, 1);
        $('micMeter').style.transform = 'scaleX(' + level.toFixed(3) + ')';
        var verdict = peak > -25 ? 'strong, good for song ID' : peak > -40 ? 'okay, song ID should work' : 'very quiet, turn the music up or try a longer clip';
        $('micReadout').textContent = 'Level ' + db.toFixed(0) + ' dB · peak ' + peak.toFixed(0) + ' dB · ' + verdict;
        requestAnimationFrame(tick);
      })();
    }).catch(function (e) { $('micReadout').textContent = micErrorText(e); });
  }

  function stopMicTest() {
    mic.testing = false;
    if (mic.ctx && mic.ctx.close) mic.ctx.close();
    mic.ctx = null;
    var b = $('micTest');
    if (b) b.textContent = 'Start test';
    var m = $('micMeter');
    if (m) m.style.transform = 'scaleX(0)';
  }

  // ------------------------------------------------------------------
  // Search sheet
  // ------------------------------------------------------------------
  var searchSeq = 0;

  function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    var id = ++searchSeq;
    $('searchStatus').textContent = 'Searching…';
    $('results').innerHTML = '';
    lrclibGet('/api/search?q=' + encodeURIComponent(q)).then(function (list) {
      if (id !== searchSeq) return;
      list = (list || []).slice();
      // Synced lyrics first, keep LRCLIB's relevance order otherwise.
      list.sort(function (a, b) { return (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0); });
      $('searchStatus').textContent = list.length
        ? list.length + ' result' + (list.length === 1 ? '' : 's') + '. “Synced” means timed lyrics'
        : 'No results. Try fewer words, or just the song title';
      renderResults(list.slice(0, 20));
    }).catch(function (e) {
      if (id !== searchSeq) return;
      $('searchStatus').textContent = e.message;
    });
  }

  function renderResults(list) {
    var ul = $('results');
    ul.innerHTML = '';
    list.forEach(function (r) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      var main = document.createElement('div');
      main.className = 'result-main';
      var t = document.createElement('div');
      t.className = 'result-title';
      t.textContent = r.trackName;
      var s = document.createElement('div');
      s.className = 'result-sub';
      s.textContent = [r.artistName, r.albumName, r.duration ? fmtTime(r.duration) : ''].filter(Boolean).join(' · ');
      main.appendChild(t);
      main.appendChild(s);
      var badge = document.createElement('span');
      badge.className = 'badge' + (r.syncedLyrics ? ' synced' : '');
      badge.textContent = r.instrumental ? 'Instrumental' : r.syncedLyrics ? 'Synced' : r.plainLyrics ? 'Plain' : 'Empty';
      b.appendChild(main);
      b.appendChild(badge);
      b.addEventListener('click', function () {
        closeSheets();
        loadManualRecord(r);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------------
  // Settings sheet
  // ------------------------------------------------------------------
  function applyDisplaySettings() {
    document.documentElement.style.setProperty('--lyric-size', (SIZES[settings.textSize] || SIZES.L) + 'px');
    document.body.classList.toggle('no-bar', !settings.showBar);
  }

  function renderSettings() {
    Array.prototype.forEach.call(document.querySelectorAll('#sizeSeg button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-size') === settings.textSize);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#clipSeg button'), function (b) {
      b.classList.toggle('on', parseInt(b.getAttribute('data-clip'), 10) === settings.clipSeconds);
    });
    $('optBar').checked = settings.showBar;
    $('optFollow').checked = settings.followSpotify;
    $('optAutoListen').checked = settings.autoListen;
    $('spClientId').value = settings.spotifyClientId;
    $('spRedirect').textContent = redirectUri();
    $('auddToken').value = settings.auddToken;
    $('auddProxy').value = settings.auddProxy;
    $('spOffsetVal').textContent = fmtOffset(settings.spotifyOffset);
    $('spDisconnect').disabled = !spotify.connected();
    setSpStatus(spotify.statusText);
    renderDiagnostics();
  }

  function renderDiagnostics() {
    var ua = navigator.userAgent;
    var chrome = ua.match(/Chrom(?:e|ium)\/([\d.]+)/);
    var qt = ua.match(/QtWebEngine\/([\d.]+)/);
    var hasGum = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    var mime = recorderMime();
    var rows = [
      ['Engine', chrome ? 'Chromium ' + chrome[1] + (qt ? ' (QtWebEngine ' + qt[1] + ')' : '') : 'Unknown'],
      ['Secure page (https)', !!window.isSecureContext],
      ['Microphone API', hasGum],
      ['Audio recorder', mime === null ? 'none (WAV fallback)' : (mime || 'default format')],
      ['Speech recognition', !!(window.SpeechRecognition || window.webkitSpeechRecognition)],
      ['Media Session API', 'mediaSession' in navigator ? 'present (only sees audio this page plays)' : false],
      ['Web Audio', !!(window.AudioContext || window.webkitAudioContext)],
      ['Settings saved between visits', store.works()],
      ['Window', innerWidth + ' × ' + innerHeight + ' px at ' + (window.devicePixelRatio || 1) + '×'],
      ['App version', VERSION],
      ['User agent', ua]
    ];
    var dl = $('diag');
    dl.innerHTML = '';
    rows.forEach(function (r) {
      var dt = document.createElement('dt');
      dt.textContent = r[0];
      var dd = document.createElement('dd');
      if (r[1] === true) { dd.textContent = 'Yes'; dd.className = 'yes'; }
      else if (r[1] === false) { dd.textContent = 'No'; dd.className = 'no'; }
      else dd.textContent = r[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
  }

  // ------------------------------------------------------------------
  // Sheets open/close
  // ------------------------------------------------------------------
  function openSheet(id) {
    closeSheets();
    $(id).classList.remove('hidden');
    if (id === 'settingsSheet') renderSettings();
    if (id === 'searchSheet') {
      var input = $('searchInput');
      if (!input.value && song.title) input.value = song.title + (song.artist ? ' ' + song.artist : '');
      setTimeout(function () { input.focus(); input.select(); }, 50);
    }
  }
  function closeSheets() {
    $('searchSheet').classList.add('hidden');
    $('settingsSheet').classList.add('hidden');
    stopMicTest();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // ------------------------------------------------------------------
  // Wire up the UI
  // ------------------------------------------------------------------
  function bind() {
    $('btnBack').addEventListener('click', function () { nudge(-NUDGE); });
    $('btnFwd').addEventListener('click', function () { nudge(NUDGE); });
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnListen').addEventListener('click', function () { listen(false); });
    $('btnSong').addEventListener('click', function () { openSheet('searchSheet'); });
    $('btnSettings').addEventListener('click', function () { openSheet('settingsSheet'); });

    $('modeChip').addEventListener('click', function () {
      if (spotify.connected()) setFollow(!settings.followSpotify);
      else openSheet('settingsSheet');
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-action');
        if (a === 'search') openSheet('searchSheet');
        if (a === 'listen') listen(false);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
      b.addEventListener('click', closeSheets);
    });

    // Search sheet
    $('searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      $('searchInput').blur();
      doSearch($('searchInput').value);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () {
        var which = t.getAttribute('data-tab');
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.toggle('active', x === t); });
        $('paneFind').classList.toggle('hidden', which !== 'find');
        $('panePaste').classList.toggle('hidden', which !== 'paste');
      });
    });
    $('pasteLoad').addEventListener('click', function () {
      var text = $('pasteText').value;
      if (!text.trim()) { toast('Paste some lyrics first'); return; }
      closeSheets();
      loadPasted($('pasteTitle').value.trim(), text);
    });

    // Settings sheet
    Array.prototype.forEach.call(document.querySelectorAll('#sizeSeg button'), function (b) {
      b.addEventListener('click', function () {
        settings.textSize = b.getAttribute('data-size');
        saveSettings(); applyDisplaySettings(); renderSettings();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#clipSeg button'), function (b) {
      b.addEventListener('click', function () {
        settings.clipSeconds = parseInt(b.getAttribute('data-clip'), 10);
        saveSettings(); renderSettings();
      });
    });
    $('optBar').addEventListener('change', function (e) { settings.showBar = e.target.checked; saveSettings(); applyDisplaySettings(); });
    $('optFollow').addEventListener('change', function (e) { setFollow(e.target.checked); });
    $('optAutoListen').addEventListener('change', function (e) { settings.autoListen = e.target.checked; saveSettings(); });
    $('spClientId').addEventListener('input', function (e) {
      settings.spotifyClientId = e.target.value.trim();
      saveSettings();
    });
    $('auddToken').addEventListener('input', function (e) { settings.auddToken = e.target.value.trim(); saveSettings(); });
    $('auddProxy').addEventListener('input', function (e) { settings.auddProxy = e.target.value.trim(); saveSettings(); });
    $('spConnect').addEventListener('click', function () {
      settings.spotifyClientId = $('spClientId').value.trim();
      saveSettings();
      spConnect();
    });
    $('spDisconnect').addEventListener('click', function () { spDisconnect(false); });
    $('spOffsetReset').addEventListener('click', function () {
      settings.spotifyOffset = 0; saveSettings(); renderSettings(); renderOffset();
    });
    $('micTest').addEventListener('click', function () { if (mic.testing) stopMicTest(); else startMicTest(); });
    $('micRelease').addEventListener('click', function () { releaseMic(); $('micReadout').textContent = 'Microphone released'; });

    // Keyboard shortcuts for testing on a computer
    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea|button/i.test(e.target.tagName)) {
        if (e.key === 'Escape') closeSheets();
        return;
      }
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') nudge(-NUDGE);
      else if (e.key === 'ArrowRight') nudge(NUDGE);
      else if (e.key === 'Escape') closeSheets();
      else if (e.key === '/') { e.preventDefault(); openSheet('searchSheet'); }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && spotify.connected() && settings.followSpotify) spotify.pollNow();
    });
    window.addEventListener('resize', function () { scrollToActive(false); });
  }

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  function boot() {
    applyDisplaySettings();
    bind();
    renderAll();
    requestAnimationFrame(frame);
    spHandleRedirect().then(function () {
      renderChip();
      if (spotify.connected() && settings.followSpotify) spPoll();
    });
  }

  // Exposed for tests in Node; harmless in the browser.
  window.CarKaraoke = {
    parseLRC: parseLRC, buildSyncedLines: buildSyncedLines, buildPlainLines: buildPlainLines,
    cleanTitle: cleanTitle, pickBest: pickBest, parseTimecode: parseTimecode, norm: norm,
    _song: function () { return song; }, _clock: clock,
    _setSong: function (s) { song = s; }, retimePlain: retimePlain, addPlainAnchor: addPlainAnchor,
    lineIndexAt: lineIndexAt, newSong: newSong
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
