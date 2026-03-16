import { IsBoolean, IsOptional } from 'class-validator';

export class UpdatePreferenceDto {
  @IsOptional()
  @IsBoolean()
  adminBroadcast?: boolean;

  @IsOptional()
  @IsBoolean()
  mention?: boolean;

  @IsOptional()
  @IsBoolean()
  taskAssigned?: boolean;

  @IsOptional()
  @IsBoolean()
  taskComment?: boolean;

  @IsOptional()
  @IsBoolean()
  taskUpdated?: boolean;
}
