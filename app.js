// Interfaz de CifrAudio (version web). No guarda nada en el telefono:
// sin localStorage, sin cookies, sin base de datos. Todo vive en memoria.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids) if (c) e.append(c);
    return e;
  }

  function show(node, on) { node.classList.toggle('hidden', !on); }
  function setText(node, text) { node.textContent = text || ''; show(node, !!text); }

  // ------------------------------------------------------------------
  // Campo de contrasena (8 caracteres, solo letras y numeros)
  // ------------------------------------------------------------------
  function passField(label) {
    const input = el('input', {
      type: 'password', maxlength: '8', placeholder: label, autocomplete: 'off',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', 'aria-label': label,
    });
    input.addEventListener('input', () => {
      const clean = input.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
      if (clean !== input.value) input.value = clean;
    });
    const eye = el('button', { type: 'button', class: 'eye', 'aria-label': 'Mostrar u ocultar' }, '\u{1F441}');
    eye.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; });
    const wrap = el('div', { class: 'pw' }, input, eye);
    return { wrap, input };
  }

  function mountPass(slotId, label) {
    const f = passField(label);
    $(slotId).append(f.wrap);
    return f.input;
  }

  // ------------------------------------------------------------------
  // Ventanas emergentes
  // ------------------------------------------------------------------
  function openModal(title, bodyNodes, actions) {
    const root = $('modal-root');
    const box = el('div', { class: 'modal' }, el('h3', { text: title }), ...bodyNodes);
    const row = el('div', { class: 'row end' });
    for (const a of actions) row.append(a);
    box.append(row);
    const overlay = el('div', { class: 'overlay' }, box);
    root.append(overlay);
    return () => overlay.remove();
  }

  function spinnerBtn(btn, busy, label) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Espere…' : label;
  }

  // Pide la contrasena de la sesion. Devuelve true si es correcta.
  function promptPassword(title, message, cancelLabel, verify) {
    return new Promise((resolve) => {
      const f = passField('Contraseña');
      const err = el('p', { class: 'error hidden' });
      const ok = el('button', { class: 'btn primary', text: 'Aceptar' });
      const cancel = el('button', { class: 'btn outline', text: cancelLabel });
      const close = openModal(title, [el('p', { class: 'muted', text: message }), f.wrap, err], [cancel, ok]);
      cancel.addEventListener('click', () => { close(); resolve(false); });
      ok.addEventListener('click', async () => {
        if (f.input.value.length !== 8) { setText(err, 'La contraseña debe tener 8 caracteres.'); return; }
        setText(err, '');
        spinnerBtn(ok, true, 'Aceptar');
        cancel.disabled = true;
        const good = await verify(f.input.value);
        if (good) { close(); resolve(true); return; }
        f.input.value = '';
        cancel.disabled = false;
        spinnerBtn(ok, false, 'Aceptar');
        setText(err, 'Contraseña incorrecta.');
      });
    });
  }

  // ------------------------------------------------------------------
  // Navegacion
  // ------------------------------------------------------------------
  const SCREENS = ['home', 'encrypt', 'decrypt', 'live', 'chat'];
  const TITLES = { home: 'CifrAudio', encrypt: 'Cifrar', decrypt: 'Descifrar', live: 'Mensajería en vivo', chat: 'Chat' };
  let current = 'home';

  function go(name) {
    if (current === 'encrypt' && name !== 'encrypt') resetEncrypt();
    if (current === 'decrypt' && name !== 'decrypt') resetDecrypt();
    current = name;
    for (const s of SCREENS) show($('screen-' + s), s === name);
    $('title').textContent = TITLES[name];
    show($('btn-back'), name === 'encrypt' || name === 'decrypt' || name === 'live');
    show($('btn-close-chat'), name === 'chat');
    document.body.classList.toggle('in-chat', name === 'chat');
    window.scrollTo(0, 0);
  }

  $('btn-back').addEventListener('click', () => go(current === 'live' ? 'home' : 'home'));
  $('go-encrypt').addEventListener('click', () => go('encrypt'));
  $('go-decrypt').addEventListener('click', () => go('decrypt'));
  $('go-live').addEventListener('click', () => go('live'));

  // ------------------------------------------------------------------
  // CIFRAR
  // ------------------------------------------------------------------
  const enc = { mode: 'text', recorder: null, recording: false, audio: null, timer: null, started: 0, result: null };
  const encPass1 = mountPass('enc-pw1', 'Contraseña');
  const encPass2 = mountPass('enc-pw2', 'Confirmar contraseña');

  function setMode(mode) {
    if (enc.recording) return;
    enc.mode = mode;
    $('mode-text').classList.toggle('active', mode === 'text');
    $('mode-audio').classList.toggle('active', mode === 'audio');
    show($('enc-text-block'), mode === 'text');
    show($('enc-audio-block'), mode === 'audio');
  }
  $('mode-text').addEventListener('click', () => setMode('text'));
  $('mode-audio').addEventListener('click', () => setMode('audio'));

  function pickMime() {
    if (!window.MediaRecorder) return '';
    const options = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
    return options.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function updateRecUi() {
    const rec = enc.recording;
    $('btn-record').textContent = rec ? 'Detener' : 'Grabar';
    show($('btn-discard'), !rec && !!enc.audio);
    if (rec) $('rec-status').textContent = 'Grabando… ' + fmtTime(Date.now() - enc.started);
    else if (enc.audio) $('rec-status').textContent = 'Audio listo para cifrar';
    else $('rec-status').textContent = 'Sin grabar';
  }

  $('btn-record').addEventListener('click', async () => {
    setText($('enc-error'), '');
    if (enc.recording) { enc.recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setText($('enc-error'), 'Este navegador no permite grabar audio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(enc.timer);
        enc.recording = false;
        enc.audio = new Blob(chunks, { type: rec.mimeType || mime || 'audio/mp4' });
        updateRecUi();
      };
      enc.recorder = rec;
      enc.audio = null;
      enc.recording = true;
      enc.started = Date.now();
      enc.timer = setInterval(updateRecUi, 500);
      rec.start();
      updateRecUi();
    } catch (e) {
      enc.recording = false;
      setText($('enc-error'), 'No se pudo acceder al micrófono. Revisa el permiso en Ajustes de Safari.');
      updateRecUi();
    }
  });

  $('btn-discard').addEventListener('click', () => { enc.audio = null; updateRecUi(); });

  $('btn-encrypt').addEventListener('click', async () => {
    setText($('enc-error'), '');
    const p1 = encPass1.value;
    if (p1.length !== 8 || p1 !== encPass2.value) {
      setText($('enc-error'), 'La contraseña debe tener 8 caracteres y coincidir en ambos campos.');
      return;
    }
    let plain, type;
    if (enc.mode === 'text') {
      const t = $('enc-text').value;
      if (!t.trim()) { setText($('enc-error'), 'Escribe un mensaje antes de cifrar.'); return; }
      plain = CFA.utf8.encode(t);
      type = CFA.TYPE_TEXT;
    } else {
      if (!enc.audio) { setText($('enc-error'), 'Graba un audio antes de cifrar.'); return; }
      plain = new Uint8Array(await enc.audio.arrayBuffer());
      type = CFA.TYPE_AUDIO;
    }
    const btn = $('btn-encrypt');
    spinnerBtn(btn, true, 'Cifrar');
    setText($('enc-status'), 'Cifrando… puede tardar unos segundos.');
    try {
      const bytes = await CFA.encryptFile(plain, p1, type);
      const name = CFA.suggestFileName();
      enc.result = new File([bytes], name, { type: 'application/octet-stream' });
      $('enc-filename').textContent = name;
      show($('enc-result'), true);
      show(btn, false);
      encPass1.value = '';
      encPass2.value = '';
      $('enc-text').value = '';
      enc.audio = null;
      updateRecUi();
    } catch (e) {
      setText($('enc-error'), 'No se pudo cifrar. ' + (e.message || ''));
    }
    setText($('enc-status'), '');
    spinnerBtn(btn, false, 'Cifrar');
  });

  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  $('btn-share').addEventListener('click', async () => {
    const f = enc.result;
    if (!f) return;
    try {
      if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] });
      else downloadFile(f);
    } catch (e) {
      if (e && e.name !== 'AbortError') downloadFile(f);
    }
  });
  $('btn-save').addEventListener('click', () => { if (enc.result) downloadFile(enc.result); });
  $('btn-enc-again').addEventListener('click', resetEncrypt);

  function resetEncrypt() {
    if (enc.recording && enc.recorder) { try { enc.recorder.stop(); } catch (e) { /* nada */ } }
    enc.result = null;
    enc.audio = null;
    $('enc-text').value = '';
    encPass1.value = '';
    encPass2.value = '';
    setText($('enc-error'), '');
    setText($('enc-status'), '');
    show($('enc-result'), false);
    show($('btn-encrypt'), true);
    setMode('text');
    updateRecUi();
  }

  // ------------------------------------------------------------------
  // DESCIFRAR
  // ------------------------------------------------------------------
  const dec = { bytes: null, audioUrl: null };
  const decPass = mountPass('dec-pw', 'Contraseña');

  $('dec-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setText($('dec-error'), '');
    try {
      dec.bytes = new Uint8Array(await f.arrayBuffer());
      $('dec-filename').textContent = f.name;
    } catch (err) {
      dec.bytes = null;
      setText($('dec-error'), 'No se pudo leer el archivo.');
    }
  });

  function sniffAudioType(b) {
    if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
    return 'audio/mp4';
  }

  function clearDecrypted() {
    if (dec.audioUrl) URL.revokeObjectURL(dec.audioUrl);
    dec.audioUrl = null;
    const a = $('dec-audio');
    a.pause();
    a.removeAttribute('src');
    a.load();
    $('dec-text').textContent = '';
    show($('dec-text-card'), false);
    show($('dec-audio-card'), false);
  }

  $('btn-decrypt').addEventListener('click', async () => {
    setText($('dec-error'), '');
    clearDecrypted();
    if (!dec.bytes) { setText($('dec-error'), 'Selecciona primero un archivo cifrado.'); return; }
    if (decPass.value.length !== 8) { setText($('dec-error'), 'Introduce la contraseña de 8 caracteres.'); return; }
    const btn = $('btn-decrypt');
    spinnerBtn(btn, true, 'Descifrar');
    setText($('dec-status'), 'Descifrando… puede tardar unos segundos.');
    try {
      const r = await CFA.decryptFile(dec.bytes, decPass.value);
      if (r.contentType === CFA.TYPE_TEXT) {
        $('dec-text').textContent = CFA.utf8.decode(r.clear);
        show($('dec-text-card'), true);
      } else {
        dec.audioUrl = URL.createObjectURL(new Blob([r.clear], { type: sniffAudioType(r.clear) }));
        $('dec-audio').src = dec.audioUrl;
        show($('dec-audio-card'), true);
      }
      decPass.value = '';
    } catch (e) {
      setText($('dec-error'), e instanceof CFA.CfaError ? e.message : 'Contraseña incorrecta o archivo inválido.');
    }
    setText($('dec-status'), '');
    spinnerBtn(btn, false, 'Descifrar');
  });

  function resetDecrypt() {
    clearDecrypted();
    dec.bytes = null;
    $('dec-file').value = '';
    $('dec-filename').textContent = 'Seleccionar archivo cifrado';
    decPass.value = '';
    setText($('dec-error'), '');
    setText($('dec-status'), '');
  }

  // ------------------------------------------------------------------
  // MENSAJERIA EN VIVO
  // ------------------------------------------------------------------
  const LOCK_AFTER_MS = 5 * 60 * 1000;
  const LIFETIME_MS = 24 * 60 * 60 * 1000;
  let chat = null;

  function generateCode() {
    let out = '';
    while (out.length < 6) {
      const b = CFA.randomBytes(1)[0];
      if (b < 252) out += ALPHABET[b % 36]; // 252 = 36 * 7, sin sesgo
    }
    return out;
  }

  $('live-host').addEventListener('click', () => {
    const code = generateCode();
    const p1 = passField('Contraseña');
    const p2 = passField('Confirmar contraseña');
    const err = el('p', { class: 'error hidden' });
    const status = el('p', { class: 'muted hidden' });
    const create = el('button', { class: 'btn primary', text: 'Crear chat' });
    const cancel = el('button', { class: 'btn outline', text: 'Cancelar' });
    const close = openModal('Nuevo chat', [
      el('p', { class: 'muted', text: 'Código para compartir:' }),
      el('p', { class: 'code', text: code }),
      el('p', { class: 'muted', text: 'Crea la contraseña de 8 caracteres (letras y números) de este chat.' }),
      p1.wrap, p2.wrap, status, err,
    ], [cancel, create]);
    cancel.addEventListener('click', close);
    create.addEventListener('click', async () => {
      setText(err, '');
      if (p1.input.value.length !== 8) { setText(err, 'La contraseña debe tener 8 caracteres.'); return; }
      if (p1.input.value !== p2.input.value) { setText(err, 'Las contraseñas no coinciden.'); return; }
      spinnerBtn(create, true, 'Crear chat');
      cancel.disabled = true;
      setText(status, 'Preparando la clave de seguridad…');
      const cc = new CFA.ChatCrypto();
      const session = new RelaySession(code, cc);
      try {
        await cc.setup(p1.input.value);
        setText(status, 'Conectando con el servidor…');
        await session.host();
      } catch (e) {
        session.close();
        cc.wipe();
        setText(status, '');
        setText(err, e.message || 'No se pudo abrir el chat. Revisa tu conexión.');
        spinnerBtn(create, false, 'Crear chat');
        cancel.disabled = false;
        return;
      }
      close();
      openChat(code, cc, session, true);
    });
  });

  $('live-join').addEventListener('click', () => {
    const codeInput = el('input', {
      type: 'text', maxlength: '6', placeholder: 'Código de 6 caracteres', autocomplete: 'off',
      autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', class: 'codeinput',
    });
    codeInput.addEventListener('input', () => {
      const clean = codeInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
      if (clean !== codeInput.value) codeInput.value = clean;
    });
    const pw = passField('Contraseña del chat');
    const err = el('p', { class: 'error hidden' });
    const status = el('p', { class: 'muted hidden' });
    const join = el('button', { class: 'btn primary', text: 'Unirse' });
    const cancel = el('button', { class: 'btn outline', text: 'Cancelar' });
    let session = null;
    let cancelled = false;
    const close = openModal('Unirse a un chat', [codeInput, pw.wrap, status, err], [cancel, join]);
    cancel.addEventListener('click', () => { cancelled = true; if (session) session.close(); close(); });
    join.addEventListener('click', async () => {
      setText(err, '');
      const code = codeInput.value;
      if (code.length !== 6) { setText(err, 'El código tiene 6 caracteres.'); return; }
      if (pw.input.value.length !== 8) { setText(err, 'La contraseña debe tener 8 caracteres.'); return; }
      spinnerBtn(join, true, 'Unirse');
      setText(status, 'Conectando con el servidor…');
      const cc = new CFA.ChatCrypto();
      session = new RelaySession(code, cc);
      try {
        await session.join(pw.input.value);
      } catch (e) {
        session.close();
        cc.wipe();
        if (cancelled) return;
        setText(status, '');
        setText(err, e.message || 'No se pudo conectar.');
        spinnerBtn(join, false, 'Unirse');
        return;
      }
      if (cancelled) { session.close(); cc.wipe(); return; }
      close();
      openChat(code, cc, session, false);
    });
  });

  function openChat(code, cc, session, isHost) {
    chat = {
      code, cc, session, isHost,
      messages: [], locked: false, promptOpen: false, everConnected: session.connected, lost: false,
      lockTimer: null, purgeTimer: null,
    };
    $('title').textContent = 'Chat ' + code;
    go('chat');
    $('title').textContent = 'Chat · ' + code;
    session.listen(
      (text, at) => { if (!chat) return; chat.messages.push({ text, mine: false, at }); renderChat(true); },
      () => { if (!chat) return; chat.everConnected = true; chat.lost = false; renderChat(false); },
      () => { if (!chat) return; chat.lost = true; renderChat(false); }
    );
    chat.lockTimer = setTimeout(lockNow, LOCK_AFTER_MS);
    chat.purgeTimer = setInterval(purgeExpired, 30000);
    renderChat(false);
  }

  function purgeExpired() {
    if (!chat) return;
    const limit = Date.now() - LIFETIME_MS;
    const before = chat.messages.length;
    chat.messages = chat.messages.filter((m) => m.at.getTime() >= limit);
    if (chat.messages.length !== before) renderChat(false);
  }

  function chatStatusText() {
    if (chat.lost) return 'Se perdió la conexión con el chat.';
    if (chat.session.connected || chat.everConnected) {
      return 'Conectado. Mensajes cifrados de extremo a extremo; se borran a las 24 horas.';
    }
    if (chat.isHost) return 'Esperando que otro teléfono se una con el código (por internet).';
    return 'Conectando…';
  }

  function hhmm(d) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function renderChat(scroll) {
    if (!chat) return;
    const status = $('chat-status');
    status.textContent = chatStatusText();
    status.classList.toggle('bad', chat.lost);
    show($('chat-locked'), chat.locked);
    show($('chat-body'), !chat.locked);
    const list = $('chat-list');
    list.replaceChildren();
    for (const m of chat.messages) {
      list.append(el('div', { class: 'bubble ' + (m.mine ? 'mine' : 'theirs') },
        el('div', { class: 'btext', text: m.text }),
        el('div', { class: 'btime', text: hhmm(m.at) })));
    }
    if (scroll) list.scrollTop = list.scrollHeight;
  }

  async function lockNow() {
    if (!chat) return;
    if (chat.promptOpen) { chat.lockTimer = setTimeout(lockNow, 10000); return; }
    chat.locked = true;
    chat.promptOpen = true;
    renderChat(false);
    const ok = await promptPassword('Verificación', 'Han pasado 5 minutos. Ingresa la contraseña para continuar.',
      'Cerrar chat', (p) => chat.cc.verify(p));
    if (!chat) return;
    chat.promptOpen = false;
    if (ok) { chat.locked = false; renderChat(false); } else finishChat();
  }

  async function requestClose() {
    if (!chat || chat.promptOpen) return;
    chat.promptOpen = true;
    const ok = await promptPassword('Cerrar chat', 'Ingresa la contraseña para cerrar y borrar la conversación.',
      'Seguir en el chat', (p) => chat.cc.verify(p));
    if (!chat) return;
    chat.promptOpen = false;
    if (ok) finishChat();
  }

  function finishChat() {
    if (!chat) return;
    clearTimeout(chat.lockTimer);
    clearInterval(chat.purgeTimer);
    chat.session.close();
    chat.cc.wipe();
    chat.messages = [];
    chat = null;
    $('chat-list').replaceChildren();
    $('chat-text').value = '';
    go('home');
  }

  $('btn-close-chat').addEventListener('click', requestClose);

  async function sendChat() {
    if (!chat) return;
    const box = $('chat-text');
    const text = box.value.trim();
    if (!text) return;
    if (!chat.session.connected) { chat.lost = chat.everConnected; renderChat(false); return; }
    try {
      await chat.session.sendText(text);
    } catch (e) {
      return;
    }
    if (!chat) return;
    chat.messages.push({ text, mine: true, at: new Date() });
    box.value = '';
    renderChat(true);
  }
  $('chat-send').addEventListener('click', sendChat);

  // ------------------------------------------------------------------
  // Privacidad: tapar la pantalla cuando la app pasa a segundo plano
  // (evita que el selector de apps de iOS muestre la conversacion).
  // ------------------------------------------------------------------
  function cover(on) { show($('cover'), on); }
  document.addEventListener('visibilitychange', () => cover(document.visibilityState !== 'visible'));
  window.addEventListener('pagehide', () => cover(true));
  window.addEventListener('pageshow', () => cover(document.visibilityState !== 'visible'));
  window.addEventListener('blur', () => { if (chat) cover(true); });
  window.addEventListener('focus', () => cover(false));
  $('cover').addEventListener('click', () => cover(false));

  // ------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------
  if (!CFA.supported()) {
    document.querySelector('main').prepend(el('p', {
      class: 'error', text: 'Este navegador no es compatible. Abre la página en Safari (iOS 16 o superior).',
    }));
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  go('home');
  updateRecUi();
})();
