// Chat por internet a traves del servidor de enlace (mismo protocolo que
// relay_session.dart de la app). El servidor solo reenvia mensajes que ya
// van cifrados de extremo a extremo; no puede leerlos ni los guarda.
'use strict';

const RELAY_URL = 'wss://cifraudio-relay.onrender.com/ws';

class RelayError extends Error {}

// Cola de eventos de un WebSocket: permite esperar el siguiente mensaje.
class Inbox {
  constructor(ws) {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      this._push(typeof ev.data === 'string' ? { text: ev.data } : { bin: new Uint8Array(ev.data) });
    });
    ws.addEventListener('close', () => this._close());
    ws.addEventListener('error', () => this._close());
  }

  _push(m) {
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(m);
    } else {
      this.queue.push(m);
    }
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters = [];
  }

  // Devuelve el siguiente evento, null si se cerro la conexion, o lanza
  // RelayError('timeout') si pasan [ms] milisegundos (0 = sin limite).
  next(ms) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const w = { resolve, timer: null };
      if (ms) {
        w.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new RelayError('timeout'));
        }, ms);
      }
      this.waiters.push(w);
    });
  }
}

function parseJson(text) {
  try {
    const m = JSON.parse(text);
    return m && typeof m === 'object' ? m : null;
  } catch (e) {
    return null;
  }
}

class RelaySession {
  constructor(code, chatCrypto) {
    this.code = code;
    this.crypto = chatCrypto;
    this.isHost = false;
    this.closed = false;
    this.connected = false;
    this.ws = null;
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.sendChain = Promise.resolve();
    this.backlog = [];
    this.onMessage = null;
    this.onConnected = null;
    this.onDisconnected = null;
  }

  listen(onMessage, onConnected, onDisconnected) {
    this.onMessage = onMessage;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    for (const t of this.backlog) onMessage(t, new Date());
    this.backlog = [];
  }

  async _tag() {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', CFA.utf8.encode('cfa-room:' + this.code)));
    return Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  _connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(RELAY_URL);
      } catch (e) {
        reject(new RelayError('No se pudo contactar el servidor.'));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const fail = () => {
        clearTimeout(timer);
        try { ws.close(); } catch (e) { /* nada */ }
        reject(new RelayError('No se pudo contactar el servidor. Si estaba dormido, intenta de nuevo en un minuto.'));
      };
      const timer = setTimeout(fail, 45000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        ws.removeEventListener('error', fail);
        resolve(ws);
      });
      ws.addEventListener('error', fail, { once: true });
    });
  }

  // ---------- anfitrion ----------
  async host() {
    this.isHost = true;
    const tag = await this._tag();
    const ws = await this._connect();
    this.ws = ws;
    const inbox = new Inbox(ws);
    ws.send(JSON.stringify({ t: 'host', g: tag }));
    try {
      const ev = await inbox.next(20000);
      const m = ev && ev.text ? parseJson(ev.text) : null;
      if (!m) throw new RelayError('El servidor no respondió.');
      if (m.t === 'err') throw new RelayError(String(m.m || 'Error del servidor.'));
      if (m.t !== 'hosted') throw new RelayError('Respuesta inválida del servidor.');
    } catch (e) {
      ws.close();
      if (e instanceof RelayError) {
        throw new RelayError(e.message === 'timeout' ? 'El servidor no respondió.' : e.message);
      }
      throw new RelayError('No se pudo crear el chat.');
    }
    this._hostLoop(inbox);
  }

  async _hostLoop(inbox) {
    const ws = this.ws;
    let authed = false;
    try {
      for (;;) {
        const ev = await inbox.next(0);
        if (!ev) break;
        if (ev.text !== undefined) {
          const m = parseJson(ev.text);
          if (!m) continue;
          if (m.t === 'peer' && !authed) ws.send(this.crypto.salt);
          else if (m.t === 'gone' && authed) break;
        } else if (!authed) {
          if (await this._checkAuth(ev.bin)) {
            authed = true;
            this.connected = true;
            await this._send({ t: 'ok' });
            ws.send(JSON.stringify({ t: 'lock' }));
            if (this.onConnected) this.onConnected();
          } else {
            ws.send(JSON.stringify({ t: 'kick' }));
          }
        } else {
          await this._handle(ev.bin);
        }
      }
    } catch (e) { /* conexion caida */ }
    this._peerLost();
  }

  async _checkAuth(frame) {
    try {
      const m = await this._open(frame);
      return m.t === 'auth';
    } catch (e) {
      return false;
    }
  }

  // ---------- quien se une ----------
  async join(password) {
    this.isHost = false;
    const tag = await this._tag();
    const ws = await this._connect();
    this.ws = ws;
    const inbox = new Inbox(ws);
    ws.send(JSON.stringify({ t: 'join', g: tag }));
    try {
      let ev = await inbox.next(30000);
      const m1 = ev && ev.text ? parseJson(ev.text) : null;
      if (!m1) throw new RelayError('El servidor no respondió.');
      if (m1.t === 'err') throw new RelayError(String(m1.m || 'Error del servidor.'));
      if (m1.t !== 'joined') throw new RelayError('Respuesta inválida del servidor.');

      ev = await inbox.next(60000);
      if (!ev || !ev.bin || ev.bin.length !== 16) throw new RelayError('El otro teléfono no respondió.');
      await this.crypto.setup(password, ev.bin);

      await this._send({ t: 'auth' });
      ev = await inbox.next(30000);
      if (!ev || !ev.bin) throw new RelayError('Contraseña incorrecta o código equivocado.');
      const m2 = await this._open(ev.bin);
      if (m2.t !== 'ok') throw new RelayError('Respuesta inválida del otro teléfono.');
    } catch (e) {
      ws.close();
      if (e instanceof RelayError) {
        throw new RelayError(e.message === 'timeout' ? 'El otro teléfono no respondió.' : e.message);
      }
      throw new RelayError('No se pudo establecer la conexión segura.');
    }
    this.connected = true;
    (async () => {
      try {
        for (;;) {
          const ev = await inbox.next(0);
          if (!ev) break;
          if (ev.bin) await this._handle(ev.bin);
        }
      } catch (e) { /* conexion caida */ }
      this._peerLost();
    })();
  }

  // ---------- mensajes ----------
  async _seal(m) {
    m.d = this.isHost ? 'h' : 'j';
    m.s = ++this.sendSeq;
    return this.crypto.encrypt(CFA.utf8.encode(JSON.stringify(m)));
  }

  async _open(data) {
    const clear = await this.crypto.decrypt(data);
    const m = JSON.parse(CFA.utf8.decode(clear));
    const peerRole = this.isHost ? 'j' : 'h';
    if (m.d !== peerRole) throw new RelayError('Dirección.');
    if (!Number.isInteger(m.s) || m.s <= this.recvSeq) throw new RelayError('Repetido.');
    this.recvSeq = m.s;
    return m;
  }

  // Los envios se encadenan para que el numero de secuencia salga en orden.
  _send(m) {
    const run = this.sendChain.then(async () => {
      if (!this.ws) throw new RelayError('No hay otro teléfono conectado.');
      this.ws.send(await this._seal(m));
    });
    this.sendChain = run.catch(() => {});
    return run;
  }

  sendText(text) {
    if (!this.connected || this.closed) return Promise.reject(new RelayError('No hay otro teléfono conectado.'));
    return this._send({ t: 'msg', x: text });
  }

  async _handle(frame) {
    try {
      const m = await this._open(frame);
      if (m.t === 'msg' && typeof m.x === 'string') {
        if (this.onMessage) this.onMessage(m.x, new Date());
        else this.backlog.push(m.x);
      }
    } catch (e) { /* trama invalida o repetida: se ignora */ }
  }

  _peerLost() {
    if (this.closed) return;
    this.connected = false;
    if (this.onDisconnected) this.onDisconnected();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    try { if (this.ws) this.ws.close(); } catch (e) { /* nada */ }
    this.ws = null;
    this.backlog = [];
  }
}
