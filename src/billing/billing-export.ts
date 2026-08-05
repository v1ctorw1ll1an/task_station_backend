type Exportado = {
  legalName: string;
  workspaces: {
    name: string;
    projects: {
      name: string;
      columns: { id: string; name: string }[];
      tasks: {
        taskNumber: number | null;
        title: string;
        description: string | null;
        priority: string;
        columnId: string;
        startDate: Date | null;
        dueDate: Date | null;
        createdAt: Date;
        reporter: { name: string; email: string };
        taskAssignees: { user: { name: string; email: string } }[];
        taskLabels: { label: { name: string } }[];
        taskChecklists: { title: string; completed: boolean }[];
        // O autor do comentário é relação opcional (usuário removido deixa o
        // comentário órfão) — o CSV só conta comentários, então não faz diferença.
        taskComments: { content: string; createdAt: Date; user: { name: string } | null }[];
      }[];
    }[];
  }[];
};

/** Escapa um campo para CSV (aspas duplas dobradas, campo entre aspas). */
function campo(valor: string | number | Date | null | undefined): string {
  if (valor == null) return '""';
  const texto = valor instanceof Date ? valor.toISOString() : String(valor);
  return `"${texto.replace(/"/g, '""')}"`;
}

/**
 * Lista plana de tasks para abrir no Excel — quem exporta em CSV quer conferir o
 * acervo, não reconstruir o banco (para isso existe o JSON).
 */
export function toCsv(dados: Exportado): string {
  const cabecalho = [
    'workspace',
    'projeto',
    'coluna',
    'numero',
    'titulo',
    'descricao',
    'prioridade',
    'responsaveis',
    'etiquetas',
    'checklist_feitos',
    'checklist_total',
    'comentarios',
    'criada_por',
    'inicio',
    'prazo',
    'criada_em',
  ].join(',');

  const linhas: string[] = [cabecalho];
  for (const ws of dados.workspaces) {
    for (const proj of ws.projects) {
      const colunas = new Map(proj.columns.map((c) => [c.id, c.name]));
      for (const t of proj.tasks) {
        linhas.push(
          [
            campo(ws.name),
            campo(proj.name),
            campo(colunas.get(t.columnId) ?? ''),
            campo(t.taskNumber),
            campo(t.title),
            campo(t.description),
            campo(t.priority),
            campo(t.taskAssignees.map((a) => a.user.name).join('; ')),
            campo(t.taskLabels.map((l) => l.label.name).join('; ')),
            campo(t.taskChecklists.filter((c) => c.completed).length),
            campo(t.taskChecklists.length),
            campo(t.taskComments.length),
            campo(t.reporter.name),
            campo(t.startDate),
            campo(t.dueDate),
            campo(t.createdAt),
          ].join(','),
        );
      }
    }
  }
  // BOM para o Excel abrir a acentuação corretamente.
  return `\uFEFF${linhas.join('\n')}\n`;
}
