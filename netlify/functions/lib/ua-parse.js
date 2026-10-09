'use strict';

// Parser leve de User-Agent — sem dependência externa (ua-parser-js etc.).
// Cobre os casos comuns o suficiente para os gráficos de dispositivo/
// navegador/SO do Analytics. Não tenta ser 100% preciso (impossível sem uma
// lib grande) nem faz fingerprinting: só classifica em baldes largos.

function parseDeviceType(ua) {
  if (!ua) return 'desconhecido';
  if (/iPad|Tablet(?!.*Mobile)|Android(?!.*Mobile)/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function parseBrowser(ua) {
  if (!ua) return 'Outro';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/FxiOS/i.test(ua)) return 'Firefox';
  if (/CriOS/i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return 'Safari';
  if (/MSIE|Trident/i.test(ua)) return 'Internet Explorer';
  return 'Outro';
}

function parseOS(ua) {
  if (!ua) return 'Outro';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Outro';
}

function parseUserAgent(ua) {
  return {
    deviceType: parseDeviceType(ua || ''),
    browser: parseBrowser(ua || ''),
    os: parseOS(ua || ''),
  };
}

module.exports = { parseUserAgent, parseDeviceType, parseBrowser, parseOS };
