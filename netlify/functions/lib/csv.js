'use strict';

// Serializador de CSV bem pequeno — evita puxar uma dependência só para
// isso. Escapa vírgula, aspas e quebra de linha conforme RFC 4180.
function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n;]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

module.exports = { toCsv };
