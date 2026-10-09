'use strict';

// Resolve o parâmetro ?range=... (+ ?from=&to= para "personalizado") em
// limites de data concretos, já calculando o período anterior equivalente
// para o comparativo ("▲ 18,4% comparado aos 30 dias anteriores").
//
// Os dias são calculados no fuso de São Paulo. O Brasil aboliu o horário de
// verão em 2019, então um offset fixo de -03:00 é seguro e evita puxar uma
// dependência de timezone só para isso.
const TZ_OFFSET = '-03:00';

function dayStart(dateStr) {
  return new Date(`${dateStr}T00:00:00.000${TZ_OFFSET}`);
}

function todaySaoPaulo() {
  // "Agora" em São Paulo, representado como YYYY-MM-DD.
  const now = new Date(Date.now() - 3 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = dayStart(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function startOfWeek(dateStr) {
  // Semana começando no domingo (convenção BR de calendário comum; o
  // dashboard mostra Dom como último dia da faixa Seg..Dom nos gráficos de
  // dia da semana, então aqui é só o corte do período).
  const d = dayStart(dateStr);
  const dow = d.getUTCDay();
  return addDays(dateStr, -dow);
}

function startOfMonth(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

function startOfYear(dateStr) {
  return `${dateStr.slice(0, 4)}-01-01`;
}

function diffDays(a, b) {
  return Math.round((dayStart(b) - dayStart(a)) / 86400000);
}

// Retorna { start, end } (Date, end exclusivo) + o mesmo intervalo deslocado
// para trás para servir de comparação.
function parseRange(query = {}) {
  const today = todaySaoPaulo();
  const range = String(query.range || '30d').toLowerCase();

  let startStr;
  let endStrExclusive; // dia seguinte ao último dia incluído

  switch (range) {
    case 'today':
      startStr = today;
      endStrExclusive = addDays(today, 1);
      break;
    case 'yesterday':
      startStr = addDays(today, -1);
      endStrExclusive = today;
      break;
    case '7d':
      startStr = addDays(today, -6);
      endStrExclusive = addDays(today, 1);
      break;
    case '30d':
      startStr = addDays(today, -29);
      endStrExclusive = addDays(today, 1);
      break;
    case 'this_week':
      startStr = startOfWeek(today);
      endStrExclusive = addDays(today, 1);
      break;
    case 'last_week': {
      const thisWeekStart = startOfWeek(today);
      startStr = addDays(thisWeekStart, -7);
      endStrExclusive = thisWeekStart;
      break;
    }
    case 'this_month':
      startStr = startOfMonth(today);
      endStrExclusive = addDays(today, 1);
      break;
    case 'last_month': {
      const thisMonthStart = startOfMonth(today);
      endStrExclusive = thisMonthStart;
      startStr = startOfMonth(addDays(thisMonthStart, -1));
      break;
    }
    case 'this_year':
      startStr = startOfYear(today);
      endStrExclusive = addDays(today, 1);
      break;
    case 'last_year': {
      const y = Number(today.slice(0, 4)) - 1;
      startStr = `${y}-01-01`;
      endStrExclusive = `${y + 1}-01-01`;
      break;
    }
    case '12m':
      startStr = addDays(startOfMonth(today), -365);
      endStrExclusive = addDays(today, 1);
      break;
    case 'custom': {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : addDays(today, -29);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : today;
      startStr = from <= to ? from : to;
      endStrExclusive = addDays(from <= to ? to : from, 1);
      break;
    }
    default:
      startStr = addDays(today, -29);
      endStrExclusive = addDays(today, 1);
  }

  const start = dayStart(startStr);
  const end = dayStart(endStrExclusive);
  const spanDays = Math.max(1, diffDays(startStr, endStrExclusive));

  // Período anterior de mesmo tamanho, imediatamente antes do início atual.
  const prevEnd = start;
  const prevStart = dayStart(addDays(startStr, -spanDays));

  // Granularidade do gráfico de linha: dia a dia até ~93 dias (~3 meses);
  // acima disso agrupa por mês para o gráfico continuar legível e a
  // consulta continuar leve.
  const granularity = spanDays > 93 ? 'month' : 'day';

  return { start, end, prevStart, prevEnd, spanDays, granularity, range, startStr, endStrExclusive };
}

module.exports = { parseRange };
