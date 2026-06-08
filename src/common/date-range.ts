import { fromZonedTime } from 'date-fns-tz';

/** Timezone padrão da aplicação (espelha o default de `Task.timezone`). */
export const APP_TIMEZONE = 'America/Sao_Paulo';

/**
 * Constrói um intervalo `{ gte, lte }` de instantes UTC cobrindo os dias-mural
 * `fromStr`..`toStr` (YYYY-MM-DD) interpretados no timezone informado. Espelha a
 * convenção de armazenamento da task (wall-clock no tz da task), evitando o
 * off-by-one de misturar meia-noite UTC (`new Date('YYYY-MM-DD')`) com `setHours`
 * local do servidor. `gte` = início do primeiro dia; `lte` = fim do último dia.
 * Retorna `undefined` se nenhum limite for informado.
 */
export function dayRangeInTz(
  fromStr: string | undefined | null,
  toStr: string | undefined | null,
  tz: string = APP_TIMEZONE,
): { gte?: Date; lte?: Date } | undefined {
  const range: { gte?: Date; lte?: Date } = {};
  if (fromStr) range.gte = fromZonedTime(`${fromStr.slice(0, 10)}T00:00:00.000`, tz);
  if (toStr) range.lte = fromZonedTime(`${toStr.slice(0, 10)}T23:59:59.999`, tz);
  return range.gte || range.lte ? range : undefined;
}

/**
 * Núcleo de validação de intervalo de datas, compartilhado por evento e task
 * para garantir as mesmas regras (término ≥ início). Puro: não lança — cada
 * chamador decide a exceção apropriada (evento → Forbidden, task → BadRequest).
 */
export interface DateRangeCheck {
  /** Alguma das datas é inválida/não-parseável. */
  invalid: boolean;
  /** Fim é anterior ao início. */
  outOfOrder: boolean;
}

export function checkDateRange(start: string | Date, end: string | Date): DateRangeCheck {
  const s = start instanceof Date ? start : new Date(start);
  const e = end instanceof Date ? end : new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return { invalid: true, outOfOrder: false };
  }
  return { invalid: false, outOfOrder: e < s };
}
