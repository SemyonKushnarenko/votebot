export function escapeMdV2(s) {
  // Telegram MarkdownV2 escaping (minimal set for our output).
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return new Intl.NumberFormat('ru-RU').format(x);
}

