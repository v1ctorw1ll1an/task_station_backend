import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';

export class TransferTaskDto {
  @IsIn(['copy', 'cut'], { message: 'Modo deve ser "copy" ou "cut"' })
  mode: 'copy' | 'cut';

  @IsUUID('4', { message: 'ID do projeto de destino inválido' })
  targetProjectId: string;

  @IsUUID('4', { message: 'ID da coluna de destino inválido' })
  targetColumnId: string;

  @IsOptional()
  @IsBoolean()
  includeAssignees?: boolean;

  @IsOptional()
  @IsIn(['skip', 'match', 'create'], {
    message: 'Opção de labels deve ser "skip", "match" ou "create"',
  })
  includeLabels?: 'skip' | 'match' | 'create';

  @IsOptional()
  @IsBoolean()
  includeComments?: boolean;

  @IsOptional()
  @IsBoolean()
  includeAttachments?: boolean;

  @IsOptional()
  @IsBoolean()
  includeHistory?: boolean;

  @IsOptional()
  @IsBoolean()
  includeDates?: boolean;
}
