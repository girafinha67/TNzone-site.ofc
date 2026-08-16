'use strict';

// Em ambiente serverless não há conexões persistentes para push (SSE/WebSocket).
// O frontend agora usa polling (ver public/js/api.js -> subscribeRealtime).
// Esta função fica como no-op só para as rotas não precisarem mudar de assinatura.
function broadcast() {}

module.exports = { broadcast };
