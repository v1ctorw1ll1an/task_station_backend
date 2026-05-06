import { Type } from 'class-transformer';
import { IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';

class ChecklistOrderItem {
  @IsUUID('4')
  id: string;

  @IsInt()
  @Min(0)
  order: number;
}

export class ReorderChecklistDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistOrderItem)
  items: ChecklistOrderItem[];
}
