import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateStickyNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  content?: string;

  @IsOptional()
  @IsEnum(['yellow', 'blue', 'green', 'pink', 'purple', 'gray'])
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  x?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  y?: number;

  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @IsOptional()
  @IsBoolean()
  minimized?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  zIndex?: number;
}
