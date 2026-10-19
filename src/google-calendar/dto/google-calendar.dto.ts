import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SYNC_DIRECTIONS, SyncDirection } from '../sync-rules';

export class CompleteGoogleConnectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  code: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  state: string;
}

export class SourceToggleDto {
  @IsUUID('4')
  sourceId: string;

  @IsBoolean()
  importEnabled: boolean;
}

export class UpdateGoogleSourcesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SourceToggleDto)
  sources: SourceToggleDto[];
}

export class UpdateGoogleSyncDirectionDto {
  @IsIn(SYNC_DIRECTIONS)
  direction: SyncDirection;
}
