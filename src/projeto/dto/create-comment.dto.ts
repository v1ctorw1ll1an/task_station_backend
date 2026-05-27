import { IsString, MaxLength, MinLength } from 'class-validator';
import { FREE } from '../../common/limits';

export class CreateCommentDto {
  @IsString()
  @MinLength(1, { message: 'Comentário não pode ser vazio' })
  @MaxLength(FREE.comment)
  content: string;
}
