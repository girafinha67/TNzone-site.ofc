'use strict';

const crypto = require('node:crypto');

const BUCKET = 'rshoes-images';
const FOLDER = 'rshoes';
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

  await ensureBucket(BUCKET, MAX_BYTES, Object.keys(ALLOWED));
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
    // Falha de limpeza não impede excluir o produto.
  }
}


// ===================== Feedbacks (foto/vídeo enviados por clientes) =====================
// O arquivo NÃO passa pela function (limite de ~6MB do Netlify): o servidor só
// gera uma URL assinada e o navegador envia direto para o Supabase Storage.
const FEEDBACK_BUCKET = 'rshoes-feedbacks';
const FEEDBACK_IMAGE_MAX = 8 * 1024 * 1024;
const FEEDBACK_VIDEO_MAX = 50 * 1024 * 1024;
const FEEDBACK_ALLOWED = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
};

function feedbackPublicPrefix() {
  const { url } = supabaseConfig();
  return `${url}/storage/v1/object/public/${FEEDBACK_BUCKET}/`;
}

// Cria o bucket público se ele ainda não existir (projeto Supabase novo). Memoizado
// por container, então só custa uma chamada na primeira vez.
const bucketsReady = new Set();
async function ensureBucket(id, fileSizeLimit, allowedMimeTypes) {
  if (bucketsReady.has(id)) return;
  const { url, key } = supabaseConfig();
  const create = (withLimit) =>
    fetch(`${url}/storage/v1/bucket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name: id,
        public: true,
        ...(withLimit ? { file_size_limit: fileSizeLimit, allowed_mime_types: allowedMimeTypes } : {}),
      }),
    });
  let res = await create(true);
  // Se o plano do Supabase tiver limite global menor, cria sem limite próprio.
  if (res.status === 413) res = await create(false);
  // 200 = criado; 400/409 = já existe. Qualquer outro erro é problema de configuração.
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    const body = await res.text();
    const err = new Error(`Não foi possível preparar o armazenamento (${id}): ${body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  bucketsReady.add(id);
}

function ensureFeedbackBucket() {
  return ensureBucket(FEEDBACK_BUCKET, FEEDBACK_VIDEO_MAX, Object.keys(FEEDBACK_ALLOWED));
}

// Valida tipo/tamanho e devolve { signedUrl, publicUrl, kind }.
async function createFeedbackSignedUpload(mime, size) {
  const info = FEEDBACK_ALLOWED[String(mime || '').toLowerCase()];
  if (!info) {
    const err = new Error('Formato não permitido. Envie foto (JPG, PNG, WEBP, GIF) ou vídeo (MP4, MOV, WEBM).');
    err.status = 400;
    throw err;
  }
  const bytes = Number(size) || 0;
  const max = info.kind === 'video' ? FEEDBACK_VIDEO_MAX : FEEDBACK_IMAGE_MAX;
  if (bytes <= 0 || bytes > max) {
    const err = new Error(info.kind === 'video' ? 'O vídeo pode ter no máximo 50 MB.' : 'A foto pode ter no máximo 8 MB.');
    err.status = 400;
    throw err;
  }

  await ensureFeedbackBucket();
  const { url, key } = supabaseConfig();
  const objectPath = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${info.ext}`;
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${url}/storage/v1/object/upload/sign/${FEEDBACK_BUCKET}/${encoded}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Falha ao liberar o envio: ${body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  let signed = String(data.url || '');
  if (signed.startsWith('/object/')) signed = `${url}/storage/v1${signed}`;
  else if (signed.startsWith('/storage/')) signed = `${url}${signed}`;
  if (!signed.startsWith('http')) {
    const err = new Error('Resposta inesperada do armazenamento.');
    err.status = 502;
    throw err;
  }
  return { signedUrl: signed, publicUrl: `${feedbackPublicPrefix()}${encoded}`, kind: info.kind };
}

// Best-effort, igual deleteImage.
async function deleteFeedbackMedia(publicUrl) {
  try {
    const prefix = feedbackPublicPrefix();
    const raw = String(publicUrl || '');
    if (!raw.startsWith(prefix)) return;
    const { url, key } = supabaseConfig();
    await fetch(`${url}/storage/v1/object/${FEEDBACK_BUCKET}/${raw.slice(prefix.length)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
  } catch {
    // Falha de limpeza não impede excluir o feedback.
  }
}

module.exports = {
  BUCKET,
  saveBase64Image,
  deleteImage,
  feedbackPublicPrefix,
  createFeedbackSignedUpload,
  deleteFeedbackMedia,
};
