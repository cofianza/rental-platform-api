/**
 * Diagnostico rapido: verificar que AUCO_PRIVATE_KEY y AUCO_PUBLIC_KEY estan
 * activas y vinculadas a una cuenta valida. Llama a un endpoint de read
 * (lista de procesos) que solo requiere autenticacion.
 */

import 'dotenv/config';

async function main() {
  const apiUrl = process.env.AUCO_API_URL;
  const publicKey = process.env.AUCO_PUBLIC_KEY;
  const privateKey = process.env.AUCO_PRIVATE_KEY;

  console.log('---- Auco keys diagnostic ----');
  console.log('API URL:', apiUrl);
  console.log('Private key prefix:', privateKey?.slice(0, 12) + '...');
  console.log('Public key prefix:', publicKey?.slice(0, 12) + '...');

  // Probar varios endpoints con cada llave para ver cual responde.
  const endpoints = [
    { path: '/document/manager', method: 'GET', auth: 'private', desc: 'lista de procesos (private)' },
    { path: '/process', method: 'GET', auth: 'private', desc: 'lista alterna /process' },
    { path: '/document', method: 'GET', auth: 'public', desc: 'document fetch (public)' },
  ];

  for (const ep of endpoints) {
    const key = ep.auth === 'private' ? privateKey : publicKey;
    const url = `${apiUrl}${ep.path}`;
    console.log(`\n→ ${ep.method} ${url}  [${ep.auth} key]`);
    try {
      const res = await fetch(url, {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: key as string,
        },
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch {}
      console.log(`   Status: ${res.status}`);
      const preview = typeof parsed === 'string'
        ? parsed.slice(0, 200)
        : JSON.stringify(parsed ?? text).slice(0, 300);
      console.log(`   Body: ${preview}${preview.length >= 300 ? '…' : ''}`);
    } catch (err) {
      console.log(`   Error: ${err}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
