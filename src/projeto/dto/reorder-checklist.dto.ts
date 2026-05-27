import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';

class ChecklistOrderItem {
  @IsUUID('4')
  id: string;

  @IsInt()
  @Min(0)
  order: number;
}

export class ReorderChecklistDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ChecklistOrderItem)
  items: ChecklistOrderItem[];
}
