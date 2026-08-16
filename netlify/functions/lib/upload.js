'use strict';

const crypto = require('node:crypto');

const BUCKET = 'tnzone-images';
const FOLDER = 'tnzone';
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    const err = new Error(
      'Upload de imagem não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente.'
    );
    err.status = 500;
    throw err;
  }
  return { url, key };
}

function objectUrl(baseUrl, objectPath) {
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl}/storage/v1/object/public/${BUCKET}/${encodedPath}`;
}

function objectApiUrl(baseUrl, objectPath) {
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl}/storage/v1/object/${BUCKET}/${encodedPath}`;
}

// Espera dataUrl no formato "data:image/png;base64,AAAA..."
async function saveBase64Image(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    const err = new Error('Formato de imagem inválido. Envie um data URL base64.');
    err.status = 400;
    throw err;
  }

  const mime = match[1].toLowerCase();
  if (!ALLOWED[mime]) {
    const err = new Error('Tipo de arquivo não permitido. Use PNG, JPG, WEBP ou GIF.');
    err.status = 400;
    throw err;
  }

  const data = Buffer.from(match[2], 'base64');
  if (data.length > MAX_BYTES) {
    const err = new Error('Imagem excede o limite de 8MB.');
    err.status = 400;
    throw err;
  }

  const { url, key } = supabaseConfig();
  const objectPath = `${FOLDER}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ALLOWED[mime]}`;
  const response = await fetch(objectApiUrl(url, objectPath), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': mime,
      'Cache-Control': '31536000',
      'x-upsert': 'false',
    },
    body: data,
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`Falha ao enviar imagem para o Supabase Storage: ${body.slice(0, 240)}`);
    err.status = 502;
    throw err;
  }

  return { url: objectUrl(url, objectPath), publicId: objectPath };
}

function objectPathFromUrl(value) {
  const raw = String(value || '');
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const index = raw.indexOf(marker);
  if (index >= 0) return decodeURIComponent(raw.slice(index + marker.length));
  return raw.startsWith(`${FOLDER}/`) ? raw : null;
}

// Best-effort: apagar a imagem no Storage não bloqueia a operação principal.
async function deleteImage(urlOrPublicId) {
  try {
    if (!urlOrPublicId) return;
    const objectPath = objectPathFromUrl(urlOrPublicId);
    if (!objectPath) return;
    const { url, key } = supabaseConfig();
    await fetch(objectApiUrl(url, objectPath), {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
    });
  } catch {
    // Best-effort: uma falha de limpeza não impede excluir o produto.
  }
}

module.exports = { saveBase64Image, deleteImage };