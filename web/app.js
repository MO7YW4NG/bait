/* Bait B2 — no framework, no build step. API money values are USDC atomic-unit strings (6 decimals). */
(function () {
  'use strict';

  var API_TIMEOUT_MS = 8000;
  var REFRESH_DELAY_MS = 200;
  var MAX_EVENTS = 80;
  var KNOWN_TYPES = [
    'run_started', 'quote', 'payment_settled', 'flag_raised', 'judge_note',
    'guard_blocked', 'guard_allowed', 'wasted', 'injection_exposed',
    'run_finished', 'reset'
  ];
  var FIXTURE = new URLSearchParams(window.location.search).get('fixture') === '1';
  var state = {
    merchants: null,
    stats: null,
    events: [],
    seenEvents: new Set(),
    eventKeys: [],
    stream: null,
    streamStatus: 'connecting',
    errors: {},
    refreshTimer: null,
    refreshSequence: 0,
    pendingRequests: [],
    hasLoaded: false
  };

  function byId(id) { return document.getElementById(id); }
  function write(id, value) { byId(id).textContent = value; }
  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  }
  function append(parent) {
    for (var i = 1; i < arguments.length; i++) {
      if (arguments[i]) parent.appendChild(arguments[i]);
    }
    return parent;
  }
  function safeText(value, fallback) {
    return value === undefined || value === null || value === '' ? (fallback || '—') : String(value);
  }
  function amountAtomic(input) {
    if (typeof input === 'bigint') return input;
    if (typeof input === 'string') {
      var s = input.trim();
      if (/^-?\d+$/.test(s)) return BigInt(s); // API contract: integer strings are atomic USDC
      if (/^-?\d+\.\d{1,6}$/.test(s)) return decimalToAtomic(s);
      return null;
    }
    // Compatibility: numeric JSON money is treated as a decimal USDC value, never a counter.
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
      return decimalToAtomic(input.toFixed(6));
    }
    return null;
  }
  function decimalToAtomic(value) {
    var negative = value.charAt(0) === '-';
    var plain = negative ? value.slice(1) : value;
    var parts = plain.split('.');
    var whole = BigInt(parts[0]);
    var fraction = BigInt(((parts[1] || '') + '000000').slice(0, 6));
    var total = whole * 1000000n + fraction;
    return negative ? -total : total;
  }
  function printAtomic(atomic) {
    if (atomic === null || atomic === undefined) return '—';
    var negative = atomic < 0n;
    var value = negative ? -atomic : atomic;
    var whole = value / 1000000n;
    var remainder = (value % 1000000n).toString().padStart(6, '0');
    var decimals = remainder.replace(/0+$/, '');
    if (decimals.length < 3) decimals = decimals.padEnd(3, '0');
    return (negative ? '-' : '') + whole.toString() + '.' + decimals;
  }
  function formatMoney(value) { return printAtomic(amountAtomic(value)); }
  function metric(mode, field) {
    return state.stats && state.stats[mode] ? amountAtomic(state.stats[mode][field]) : null;
  }
  function formatClock(time) {
    if (time === undefined || time === null || time === '') return '—';
    var parsed;
    if (typeof time === 'number' || /^\d+$/.test(String(time))) {
      var n = Number(time);
      parsed = new Date(n < 1e12 ? n * 1000 : n);
    } else {
      parsed = new Date(time);
    }
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function textOrZero(input) {
    var n = Number(input);
    return Number.isSafeInteger(n) && n >= 0 ? String(n) : '—';
  }
  function displayConnection() {
    var element = byId('stream-indicator');
    var label = 'CONNECTING';
    var kind = state.streamStatus;
    if (FIXTURE) { kind = 'fixture'; label = 'FIXTURE MODE'; }
    else if (state.errors.merchants && state.errors.stats) { kind = 'offline'; label = 'API OFFLINE'; }
    else if (kind === 'live') label = 'STREAM LIVE';
    else if (kind === 'reconnecting') label = 'RECONNECTING';
    else if (kind === 'offline') label = 'STREAM OFFLINE';
    element.className = 'connection connection-' + (kind === 'connecting' ? 'pending' : kind);
    write('stream-label', label);
    var messages = Object.values(state.errors);
    var alert = byId('api-alert');
    alert.hidden = FIXTURE || messages.length === 0;
    if (messages.length) alert.textContent = 'Feed API: ' + messages.join(' · ') + '. Data may be incomplete. Retry when the service is available.';
  }
  function renderStats() {
    var wastedOff = metric('off', 'wasted');
    var wastedOn = metric('on', 'wasted');
    var blocked = state.stats && state.stats.on ? state.stats.on.blocked : undefined;
    write('wasted-off', printAtomic(wastedOff));
    write('wasted-on', printAtomic(wastedOn));
    write('blocked-count', blocked === undefined || blocked === null ? '—' : textOrZero(blocked));
    write('compare-off-number', printAtomic(wastedOff) + ' USDC wasted');
    write('compare-on-number', printAtomic(wastedOn) + ' USDC wasted');
    var valid = wastedOff !== null && wastedOn !== null;
    var largest = valid ? (wastedOff > wastedOn ? wastedOff : wastedOn) : 0n;
    var offWidth = valid && largest > 0n ? Number(wastedOff * 100n / largest) : 0;
    var onWidth = valid && largest > 0n ? Number(wastedOn * 100n / largest) : 0;
    byId('compare-off-bar').style.width = Math.max(0, Math.min(100, offWidth)) + '%';
    byId('compare-on-bar').style.width = Math.max(0, Math.min(100, onWidth)) + '%';
    if (!valid) {
      write('saved-value', '—');
      write('saved-caption', 'Waiting for comparable guard runs');
      write('comparison-note', 'A comparison appears after both runs report their totals.');
      return;
    }
    var difference = wastedOff - wastedOn;
    write('saved-value', printAtomic(difference));
    if (difference > 0n) {
      write('saved-caption', 'Observed reduction in wasted spend');
      write('comparison-note', 'Guard ON avoided ' + printAtomic(difference) + ' USDC of observed waste compared with Guard OFF.');
    } else if (difference === 0n) {
      write('saved-caption', 'No measured difference between runs');
      write('comparison-note', 'The latest Guard OFF and ON runs report equal wasted amounts.');
    } else {
      write('saved-caption', 'Negative savings — investigate Guard ON');
      write('comparison-note', 'Guard ON wasted ' + printAtomic(-difference) + ' USDC more. Review event evidence.');
    }
  }
  function verdictOf(merchant) {
    var value = safeText(merchant.verdict, 'unknown').toLowerCase();
    return value === 'ok' || value === 'risky' ? value : 'unknown';
  }
  function evidenceOf(merchant) {
    var source = merchant.latestEvidence || merchant.latest_evidence || merchant.evidence;
    if (Array.isArray(source)) {
      if (!source.length) return null;
      return source.slice().sort(function (a, b) { return Number(b.ts || 0) - Number(a.ts || 0); })[0];
    }
    return source && typeof source === 'object' ? source : null;
  }
  function scoreOf(merchant) {
    var score = Number(merchant.score);
    return merchant.score === null || merchant.score === undefined || !Number.isFinite(score) || score < 0 || score > 1 ? null : score;
  }
  function flagsOf(merchant) {
    var flags = merchant.flags;
    if (!Array.isArray(flags)) return [];
    return flags.map(function (flag) {
      return typeof flag === 'string' ? { name: flag, by: 'rule' } :
        { name: safeText(flag && (flag.flag || flag.name), ''), by: flag && flag.by === 'judge' ? 'judge' : 'rule' };
    }).filter(function (flag) { return flag.name; });
  }
  function transactionLink(evidence) {
    var hash = String(evidence.txHash || evidence.tx_hash || '');
    var url = String(evidence.explorerUrl || evidence.explorer_url || '');
    var simulated = evidence.simulated === true || /^0xmock/i.test(hash);
    if (simulated) return node('span', 'tx-tag', 'SIMULATED · NO CHAIN TX');
    // Never trust arbitrary URLs from evidence as navigation destinations.
    var linkUrl = '';
    try {
      var parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'sepolia.basescan.org' &&
          /^\/tx\/0x[a-f0-9]{64}\/?$/i.test(parsed.pathname) &&
          (!hash || parsed.pathname.toLowerCase().includes(hash.toLowerCase()))) {
        linkUrl = parsed.href;
      }
    } catch (error) { /* Missing or invalid link: render no link. */ }
    if (linkUrl) {
      var anchor = node('a', 'tx-link', 'VIEW ON BASESCAN ↗');
      anchor.href = linkUrl;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.setAttribute('aria-label', 'View transaction on Base Sepolia Basescan');
      return anchor;
    }
    return node('span', 'muted', hash ? 'No explorer proof' : 'No transaction');
  }
  function readableEvidence(evidence) {
    if (!evidence) return { main: 'No payment evidence yet', detail: 'Awaiting decoy observations' };
    var quoted = evidence.quoted !== undefined ? evidence.quoted : evidence.quotedAtomic;
    var charged = evidence.charged !== undefined ? evidence.charged : evidence.chargedAtomic;
    var quotedText = formatMoney(quoted);
    var chargedText = formatMoney(charged);
    var showAmounts = quotedText !== '—' || chargedText !== '—';
    var flagName = safeText(evidence.flag, 'OBSERVATION');
    var main = showAmounts ? 'Quoted ' + quotedText + ' → charged ' + chargedText + ' USDC' : safeText(evidence.detail, flagName);
    var detail = showAmounts ? safeText(evidence.detail, flagName) : (evidence.by === 'judge' ? 'AI judge observation' : 'Decoy observation');
    return { main: main, detail: detail };
  }
  function renderMerchants() {
    var table = byId('merchant-rows');
    table.replaceChildren();
    var merchants = state.merchants;
    write('merchant-count', Array.isArray(merchants) ? String(merchants.length) : '0');
    if (!Array.isArray(merchants) || merchants.length === 0) {
      var placeholder = node('td', 'table-placeholder', !state.hasLoaded ? 'Loading merchant evidence…' : state.errors.merchants ? 'Cannot load merchants from the Feed API. Retry the connection.' : 'No merchant evidence recorded. Run the decoy to populate the feed.');
      placeholder.colSpan = 6;
      append(table, append(node('tr'), placeholder));
      return;
    }
    merchants.forEach(function (merchant) {
      if (!merchant || typeof merchant !== 'object') return;
      var tr = node('tr');
      var nameCell = node('td', 'merchant-cell');
      var name = safeText(merchant.name || merchant.id || merchant.merchantId, 'Unknown merchant');
      var id = safeText(merchant.id || merchant.merchantId, 'unregistered');
      append(nameCell, node('strong', '', name), node('small', '', 'ID / ' + id));
      var scoreCell = node('td');
      var score = scoreOf(merchant);
      var verdict = verdictOf(merchant);
      var scoreClass = score === null ? 'score-unknown' : (verdict === 'risky' ? 'score-risky' : verdict === 'ok' ? 'score-ok' : 'score-unknown');
      var wrap = node('div', 'score-wrapper');
      var number = node('span', 'score-number ' + scoreClass, score === null ? '—' : Math.round(score * 100) + '%');
      var track = node('div', 'score-track');
      var fill = node('span', scoreClass);
      fill.style.width = score === null ? '0%' : String(Math.round(score * 100)) + '%';
      append(track, fill); append(scoreCell, append(wrap, number, track));
      var verdictCell = append(node('td'), node('span', 'verdict verdict-' + verdict, verdict.toUpperCase()));
      var flagCell = node('td');
      var flagList = node('div', 'flag-list');
      var flags = flagsOf(merchant);
      if (!flags.length) append(flagList, node('span', 'muted', 'No flags recorded'));
      flags.forEach(function (flag) {
        append(flagList, node('span', 'flag' + (flag.by === 'judge' ? ' flag-judge' : ''), flag.name + (flag.by === 'judge' ? ' · AI judge' : '')));
      });
      append(flagCell, flagList);
      var evidence = evidenceOf(merchant);
      var description = readableEvidence(evidence);
      var evidenceCell = node('td', 'evidence');
      append(evidenceCell, node('span', 'evidence-detail', description.main), node('span', 'evidence-sub', description.detail));
      var txCell = node('td');
      append(txCell, evidence ? transactionLink(evidence) : node('span', 'muted', 'No transaction'));
      append(table, append(tr, nameCell, scoreCell, verdictCell, flagCell, evidenceCell, txCell));
    });
  }
  function eventKey(value) {
    return value.id !== undefined && value.id !== null ? 'id:' + String(value.id) : null;
  }
  function addEvent(value) {
    var key = eventKey(value);
    if (key && state.seenEvents.has(key)) return;
    if (key) {
      state.seenEvents.add(key); state.eventKeys.push(key);
      if (state.eventKeys.length > 300) state.seenEvents.delete(state.eventKeys.shift());
    }
    state.events.unshift(value);
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
    renderEvents();
  }
  function eventMessage(event) {
    var payload = event.payload || {};
    var reason = payload.reason || payload.blockReason || payload.guardBlockReason;
    var result = payload.paymentResult || payload.result || payload.status;
    switch (event.type) {
      case 'guard_blocked': return 'BLOCKED before signing' + (reason ? ' · ' + reason : '');
      case 'guard_allowed': return 'Guard allowed payment' + (reason ? ' · ' + reason : '');
      case 'payment_settled':
        return (payload.simulated || /^0xmock/i.test(String(payload.txHash || '')) ? 'Simulated settlement' : 'Settlement reported') +
          (payload.txHash ? ' · ' + String(payload.txHash).slice(0, 14) + '…' : '');
      case 'flag_raised': return 'Evidence flagged · ' + safeText(payload.flag || payload.reason, 'See merchant monitor');
      case 'quote': return 'Merchant price quoted' + (payload.priceUsdc ? ' · ' + payload.priceUsdc + ' USDC' : '');
      case 'wasted': return 'Wasted payment recorded' + (payload.wastedAtomic !== undefined ? ' · ' + formatMoney(payload.wastedAtomic) + ' USDC' : '');
      case 'injection_exposed': return 'Prompt injection content observed';
      case 'run_started': return 'Execution started' + (payload.runId ? ' · ' + payload.runId : '');
      case 'run_finished': return 'Execution finished' + (payload.runId ? ' · ' + payload.runId : '');
      case 'reset': return 'Feed reset · previous observations cleared';
      case 'judge_note': return 'AI judge note · ' + safeText(payload.reason, 'advisory only');
      default: return safeText(reason || result || payload.message || event.message, 'Event received');
    }
  }
  function renderEvents() {
    var list = byId('event-list');
    list.replaceChildren();
    write('event-count', String(state.events.length) + ' EVENTS');
    if (!state.events.length) {
      append(list, node('li', 'log-empty', FIXTURE ? 'Fixture has no events.' : 'Waiting for events from /events…'));
      return;
    }
    state.events.forEach(function (event) {
      var cls = event.type === 'guard_blocked' ? 'event-block' :
        (event.type === 'flag_raised' || event.type === 'injection_exposed') ? 'event-alert' :
        event.type === 'reset' ? 'event-reset' : '';
      var li = node('li', cls);
      var actor = node('div');
      append(actor, node('span', 'log-actor', safeText(event.actor, 'SYSTEM').toUpperCase()), node('span', 'log-type', safeText(event.type, 'event').replace(/_/g, ' ').toUpperCase()));
      append(li, node('span', 'log-time', formatClock(event.ts)), actor,
        node('span', 'log-merchant', safeText(event.merchantId, '—')),
        node('span', 'log-message', eventMessage(event)));
      append(list, li);
    });
  }
  function normalizeEvent(raw, type, lastEventId) {
    if (!raw || typeof raw !== 'object') return null;
    var payload = raw.payload || {};
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (error) { payload = { message: payload }; }
    }
    if (!payload || typeof payload !== 'object') payload = {};
    var actualType = raw.type || (type !== 'message' ? type : '') || payload.type || 'event';
    return {
      id: raw.id !== undefined ? raw.id : (lastEventId || null),
      ts: raw.ts || raw.timestamp || Date.now(),
      actor: raw.actor || payload.actor || 'feed',
      type: String(actualType),
      merchantId: raw.merchantId || raw.merchant_id || payload.merchantId || payload.merchant_id || null,
      payload: payload,
      message: raw.message || ''
    };
  }
  function applyReset() {
    state.refreshSequence++;
    state.pendingRequests.forEach(function (controller) { controller.abort(); });
    state.pendingRequests = [];
    state.merchants = [];
    state.stats = null;
    state.events = [];
    state.seenEvents.clear();
    state.eventKeys = [];
    state.hasLoaded = true;
    renderStats(); renderMerchants(); renderEvents();
  }
  function handleStreamEvent(message) {
    var raw;
    try { raw = JSON.parse(message.data); } catch (error) {
      if (message.type !== 'reset') return;
      raw = { type: 'reset' };
    }
    if (Array.isArray(raw)) {
      raw.forEach(function (item) {
        var evt = normalizeEvent(item, message.type, null);
        if (evt) processEvent(evt);
      });
      return;
    }
    var event = normalizeEvent(raw, message.type, message.lastEventId);
    if (event) processEvent(event);
  }
  function processEvent(event) {
    var key = eventKey(event);
    if (key && state.seenEvents.has(key)) return;
    if (event.type === 'reset') applyReset();
    addEvent(event);
    queueRefresh();
  }
  function clearPending() {
    state.pendingRequests.forEach(function (controller) { controller.abort(); });
    state.pendingRequests = [];
  }
  async function fetchJson(path, controller) {
    var timeout = setTimeout(function () { controller.abort(); }, API_TIMEOUT_MS);
    try {
      var response = await fetch(path, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function refreshData() {
    if (FIXTURE) return;
    var sequence = ++state.refreshSequence;
    clearPending();
    var merchantsController = new AbortController();
    var statsController = new AbortController();
    state.pendingRequests = [merchantsController, statsController];
    var results = await Promise.allSettled([fetchJson('/merchants', merchantsController), fetchJson('/stats', statsController)]);
    if (sequence !== state.refreshSequence) return;
    state.pendingRequests = [];
    var merchantResult = results[0];
    var statsResult = results[1];
    if (merchantResult.status === 'fulfilled') {
      var data = merchantResult.value;
      if (Array.isArray(data) || (data && Array.isArray(data.merchants))) {
        state.merchants = Array.isArray(data) ? data : data.merchants;
        delete state.errors.merchants;
      } else { state.errors.merchants = '/merchants sent an invalid response'; state.merchants = []; }
    } else {
      state.errors.merchants = safeText(merchantResult.reason && merchantResult.reason.message, '/merchants unavailable');
      if (state.merchants === null) state.merchants = [];
    }
    if (statsResult.status === 'fulfilled') {
      var stats = statsResult.value;
      if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
        state.stats = stats;
        delete state.errors.stats;
      } else { state.errors.stats = '/stats sent an invalid response'; state.stats = null; }
    } else {
      state.errors.stats = safeText(statsResult.reason && statsResult.reason.message, '/stats unavailable');
    }
    state.hasLoaded = true;
    renderStats(); renderMerchants(); displayConnection();
  }
  function queueRefresh() {
    if (FIXTURE) return;
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(function () { state.refreshTimer = null; refreshData(); }, REFRESH_DELAY_MS);
  }
  function connectEvents() {
    if (FIXTURE) return;
    if (state.stream) state.stream.close();
    if (!('EventSource' in window)) {
      state.streamStatus = 'offline';
      state.errors.events = 'This browser does not support EventSource';
      displayConnection();
      return;
    }
    state.streamStatus = 'connecting';
    displayConnection();
    var source = new EventSource('/events');
    state.stream = source;
    source.onopen = function () {
      if (state.stream !== source) return;
      state.streamStatus = 'live';
      delete state.errors.events;
      displayConnection();
      queueRefresh();
    };
    source.onerror = function () {
      if (state.stream !== source) return;
      state.streamStatus = source.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting';
      displayConnection();
      // EventSource automatically retries with Last-Event-ID when the server supports it.
    };
    source.onmessage = handleStreamEvent;
    KNOWN_TYPES.forEach(function (type) { source.addEventListener(type, handleStreamEvent); });
  }
  function showFixture() {
    byId('fixture-banner').hidden = false;
    state.hasLoaded = true;
    state.streamStatus = 'fixture';
    state.merchants = [
      { id: 'honest', name: 'Honest Data', score: 0.86, verdict: 'ok', flags: [], latestEvidence: { detail: 'Weather report delivered', txHash: '0xmock001', simulated: true, quoted: '10000', charged: '10000' } },
      { id: 'price-switch', name: 'Price Switch', score: 0.14, verdict: 'risky', flags: ['PRICE_CHANGE'], latestEvidence: { flag: 'PRICE_CHANGE', detail: 'Price changed after quote', txHash: '0xmock002', simulated: true, quoted: '10000', charged: '50000' } },
      { id: 'ghost', name: 'Ghost Merchant', score: 0.14, verdict: 'risky', flags: ['NON_DELIVERY'], latestEvidence: { flag: 'NON_DELIVERY', detail: 'Empty response after payment', txHash: '0xmock003', simulated: true, quoted: '10000', charged: '10000' } },
      { id: 'double', name: 'Double Charge', score: 0.14, verdict: 'risky', flags: ['DOUBLE_CHARGE'], latestEvidence: { flag: 'DOUBLE_CHARGE', detail: 'Same request ID settled twice', txHash: '0xmock004', simulated: true, quoted: '10000', charged: '20000' } },
      { id: 'injector', name: 'Prompt Injector', score: 0.14, verdict: 'risky', flags: ['PROMPT_INJECTION'], latestEvidence: { flag: 'PROMPT_INJECTION', detail: 'Response contained instruction override', txHash: '0xmock005', simulated: true, quoted: '10000', charged: '10000' } },
      { id: 'unknown', name: 'Unobserved Merchant', verdict: 'unknown', flags: [], evidence: [] }
    ];
    state.stats = { off: { spent: '100000', wasted: '60000', injections: 1 }, on: { spent: '10000', wasted: '0', blocked: 4 } };
    var now = Date.now();
    [
      { id: 'f1', ts: now - 14000, actor: 'decoy', type: 'flag_raised', merchantId: 'price-switch', payload: { flag: 'PRICE_CHANGE' } },
      { id: 'f2', ts: now - 10000, actor: 'decoy', type: 'flag_raised', merchantId: 'ghost', payload: { flag: 'NON_DELIVERY' } },
      { id: 'f3', ts: now - 7000, actor: 'customer', type: 'wasted', merchantId: 'double', payload: { wastedAtomic: '10000' } },
      { id: 'f4', ts: now - 4000, actor: 'guard', type: 'guard_blocked', merchantId: 'price-switch', payload: { reason: 'PRICE_CHANGE before signing' } },
      { id: 'f5', ts: now - 2000, actor: 'guard', type: 'guard_blocked', merchantId: 'injector', payload: { reason: 'PROMPT_INJECTION risk feed' } }
    ].forEach(addEvent);
    renderStats(); renderMerchants(); displayConnection();
  }
  byId('retry-button').addEventListener('click', function () {
    if (FIXTURE) return;
    delete state.errors.events;
    refreshData();
    connectEvents();
  });
  if (FIXTURE) showFixture();
  else { renderStats(); renderMerchants(); renderEvents(); refreshData(); connectEvents(); }
})();
