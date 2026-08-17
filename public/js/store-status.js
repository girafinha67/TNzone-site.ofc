// Controla o badge "Loja aberta/fechada" no topo da home com base no
// horário de Brasília (America/Sao_Paulo), independente do fuso horário
// de quem está visitando o site.
//
// Regras:
//   08:30 (inclusive) até 19:30 (exclusive) -> "Loja aberta • Peça já" (bolinha verde)
//   19:30 até 08:30 do dia seguinte         -> "Loja fechada • Abrimos às 08:30" (bolinha vermelha)

(function () {
  const OPEN_MINUTES = 8 * 60 + 30;   // 08:30
  const CLOSE_MINUTES = 19 * 60 + 30; // 19:30

  function getBrasiliaHourMinute() {
    // Intl com timeZone fixo garante o horário de Brasília mesmo que o
    // visitante esteja em outro fuso.
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());

    const hour = Number(parts.find((p) => p.type === 'hour').value);
    const minute = Number(parts.find((p) => p.type === 'minute').value);
    return { hour, minute };
  }

  function isStoreOpen() {
    const { hour, minute } = getBrasiliaHourMinute();
    const totalMinutes = hour * 60 + minute;
    return totalMinutes >= OPEN_MINUTES && totalMinutes < CLOSE_MINUTES;
  }

  function updateStoreStatus() {
    const dot = document.getElementById('store-status-dot');
    const text = document.getElementById('store-status-text');
    if (!dot || !text) return;

    const open = isStoreOpen();

    if (open) {
      dot.classList.add('open');
      dot.classList.remove('closed');
      text.textContent = 'Loja aberta • Peça já';
    } else {
      dot.classList.add('closed');
      dot.classList.remove('open');
      text.textContent = 'Loja fechada • Abrimos às 08:30';
    }
  }

  document.addEventListener('DOMContentLoaded', updateStoreStatus);
  // Revalida a cada 30s — suficiente pra pegar a virada exata de 08:30/19:30
  // sem pesar o navegador do visitante.
  setInterval(updateStoreStatus, 30 * 1000);
})();
