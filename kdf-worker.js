// Calcula la clave con Argon2id en un hilo aparte para no congelar la pantalla.
// Parametros identicos a la app Android/Windows (crypto_service.dart):
//   Argon2id, 128 MB (131072 KiB), 4 iteraciones, paralelismo 1, clave de 32 bytes.
importScripts('argon2-bundled.min.js');

self.onmessage = async (e) => {
  try {
    const r = await argon2.hash({
      pass: e.data.password,
      salt: e.data.salt,
      time: 4,
      mem: 131072,
      hashLen: 32,
      parallelism: 1,
      type: argon2.ArgonType.Argon2id,
    });
    const key = new Uint8Array(r.hash);
    self.postMessage({ key: key.buffer }, [key.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
