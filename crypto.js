// Motor de cifrado de CifrAudio (version web).
//
// Mismo esquema que la app Android/Windows:
//   - Clave: Argon2id (128 MB, 4 iteraciones, paralelismo 1, 32 bytes)
//   - Cifrado: AES-256-GCM (Web Crypto API del navegador)
//   - Archivo .dat: "CFA1" | tipo(1) | salt(16) | nonce(12) | largo(4, big-endian) | cifrado+tag
// Todo ocurre dentro del telefono; nada se envia a ningun servidor.
'use strict';

const CFA = (() => {
  const MAGIC = [0x43, 0x46, 0x41, 0x31]; // "CFA1"
  const TYPE_TEXT = 0x01;
  const TYPE_AUDIO = 0x02;
  const HEADER = 4 + 1 + 16 + 12 + 4;

  const te = new TextEncoder();
  const td = new TextDecoder('utf-8', { fatal: true });

  class CfaError extends Error {}

  function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  function concat(...parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function supported() {
    return !!(window.crypto && crypto.subtle && window.Worker && window.WebAssembly);
  }

  // Argon2id en un Worker nuevo para cada calculo; al terminar se destruye
  // para liberar los 128 MB de memoria.
  function deriveRaw(password, salt) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker('kdf-worker.js');
      } catch (e) {
        reject(new CfaError('Tu navegador no puede ejecutar el cifrado.'));
        return;
      }
      const finish = (fn, v) => {
        worker.terminate();
        fn(v);
      };
      worker.onmessage = (e) => {
        if (e.data && e.data.key) finish(resolve, new Uint8Array(e.data.key));
        else finish(reject, new CfaError('No se pudo calcular la clave.'));
      };
      worker.onerror = () => finish(reject, new CfaError('No se pudo calcular la clave.'));
      worker.postMessage({ password: te.encode(password), salt: salt });
    });
  }

  async function importKey(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function deriveKey(password, salt) {
    const raw = await deriveRaw(password, salt);
    const key = await importKey(raw);
    raw.fill(0);
    return key;
  }

  // ----- archivos .dat -----

  function buildContainer(contentType, salt, nonce, cipherWithTag) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, cipherWithTag.length, false);
    return concat(new Uint8Array(MAGIC), new Uint8Array([contentType]), salt, nonce, len, cipherWithTag);
  }

  function parseContainer(bytes) {
    if (bytes.length < HEADER) throw new CfaError('Archivo inválido o corrupto.');
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw new CfaError('Este archivo no es un contenedor CifrAudio válido.');
    }
    let off = 4;
    const contentType = bytes[off];
    off += 1;
    const salt = bytes.slice(off, off + 16);
    off += 16;
    const nonce = bytes.slice(off, off + 12);
    off += 12;
    const len = new DataView(bytes.buffer, bytes.byteOffset + off, 4).getUint32(0, false);
    off += 4;
    if (bytes.length < off + len) throw new CfaError('Archivo incompleto o corrupto.');
    return { contentType, salt, nonce, cipherWithTag: bytes.slice(off, off + len) };
  }

  async function encryptFile(plain, password, contentType) {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = await deriveKey(password, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
    return buildContainer(contentType, salt, nonce, ct);
  }

  async function decryptFile(bytes, password) {
    const p = parseContainer(bytes);
    const key = await deriveKey(password, p.salt);
    let clear;
    try {
      clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.nonce }, key, p.cipherWithTag));
    } catch (e) {
      throw new CfaError('Contraseña incorrecta o archivo inválido.');
    }
    return { contentType: p.contentType, clear };
  }

  function suggestFileName() {
    const r = Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
    return 'CFA_' + r + '.dat';
  }

  // ----- clave de sesion del chat -----
  // Misma logica que PasswordVerifier de la app: una clave derivada una vez,
  // mensajes con formato  nonce(12) | cifrado | tag(16).
  class ChatCrypto {
    constructor() {
      this.salt = null;
      this.key = null;
      this.canary = null;
    }

    async setup(password, salt) {
      this.salt = salt ? new Uint8Array(salt) : randomBytes(16);
      this.key = await deriveKey(password, this.salt);
      this.canary = await this.encrypt(te.encode('CFA-CHAT-OK'));
    }

    // Comprueba la contrasena sin guardarla: deriva de nuevo y prueba abrir el marcador.
    async verify(password) {
      if (!this.salt || !this.canary) return false;
      try {
        const k = await deriveKey(password, this.salt);
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.canary.slice(0, 12) }, k, this.canary.slice(12));
        return true;
      } catch (e) {
        return false;
      }
    }

    async encrypt(plain) {
      if (!this.key) throw new CfaError('Sesión sin clave.');
      const nonce = randomBytes(12);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, this.key, plain));
      return concat(nonce, ct);
    }

    async decrypt(data) {
      if (!this.key) throw new CfaError('Sesión sin clave.');
      if (data.length < 12 + 16) throw new CfaError('Datos cortos.');
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, this.key, data.slice(12))
      );
    }

    wipe() {
      this.salt = null;
      this.key = null;
      this.canary = null;
    }
  }

  return {
    TYPE_TEXT, TYPE_AUDIO, CfaError, ChatCrypto,
    supported, randomBytes, encryptFile, decryptFile, suggestFileName,
    utf8: { encode: (s) => te.encode(s), decode: (b) => td.decode(b) },
  };
})();
