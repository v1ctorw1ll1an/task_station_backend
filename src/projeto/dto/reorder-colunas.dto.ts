import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

export class ReorderColunasDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true, message: 'Cada item deve ser um UUID válido' })
  columnIds: string[];
}
