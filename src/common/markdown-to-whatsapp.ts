// ---------------------------------------------------------------------------
// Markdown → WhatsApp
//
// A descrição da task é armazenada em Markdown. Ao embutir um trecho dela numa
// mensagem de WhatsApp (ver task-guest.service `describeValue`), o Markdown cru
// (`**negrito**`, `## Título`, `[texto](url)`) apareceria literal e "quebrado",
// pois o WhatsApp usa uma sintaxe própria e bem mais limitada:
//   *negrito*  _itálico_  ~riscado~  ```mono```
// (sem títulos `#`, sem links `[](url)`, sem listas reais).
//
// Aqui convertemos o inline (que é o que importa num preview de 1 linha) e
// removemos marcadores de bloco para não vazarem como texto cru.
// ---------------------------------------------------------------------------

// Sentinela temporária para o '*' de negrito — evita que a etapa de itálico
// (que troca '*' simples por '_') reescreva o negrito recém-convertido.
// Caractere de controle que não aparece em texto normal.
const BOLD = '';

/**
 * Converte uma string Markdown para a sintaxe de formatação do WhatsApp.
 */
export function markdownToWhatsapp(md: string): string {
  if (!md) return '';
  let out = md;

  // Code fences ```lang\n...``` → mantém o conteúdo, remove as crases.
  out = out.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1');
  // Código inline `x` → x
  out = out.replace(/`([^`]+)`/g, '$1');

  // --- Marcadores de bloco (ancorados no início da linha) --------------------
  // Títulos "## Texto" → negrito
  out = out.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, `${BOLD}$1${BOLD}`);
  // Citação "> " → remove o marcador
  out = out.replace(/^[ \t]*>[ \t]?/gm, '');
  // Regra horizontal (---, ***, ___) → remove a linha (antes das listas)
  out = out.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  // Listas "- ", "* ", "+ " → "• "
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');

  // --- Inline ----------------------------------------------------------------
  // Imagens ![alt](url) → alt   (antes dos links)
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links [texto](url) → texto (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Negrito **x** / __x__ → sentinela (resolvida no fim)
  out = out.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${BOLD}`);
  out = out.replace(/__([^_]+)__/g, `${BOLD}$1${BOLD}`);

  // Riscado ~~x~~ → ~x~
  out = out.replace(/~~([^~]+)~~/g, '~$1~');

  // Itálico *x* → _x_  (sobraram apenas asteriscos simples)
  out = out.replace(/\*([^*\n]+)\*/g, '_$1_');
  // _x_ já é itálico no WhatsApp → mantém.

  // Resolve o negrito.
  out = out.split(BOLD).join('*');

  return out;
}

/**
 * Remove marcadores de ênfase órfãos (`*`, `_`, `~`) — útil depois de truncar
 * um trecho, quando o corte pode ter separado um par e deixado um marcador
 * solto que o WhatsApp mostraria literal.
 */
export function balanceWhatsappEmphasis(text: string): string {
  let out = text;
  for (const marker of ['*', '_', '~']) {
    const count = out.split(marker).length - 1;
    if (count % 2 === 1) {
      const idx = out.lastIndexOf(marker);
      if (idx !== -1) out = out.slice(0, idx) + out.slice(idx + 1);
    }
  }
  return out;
}
