import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });

    if (!user) {
      return null;
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Usuário inativo');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _, ...result } = user;
    return result;
  }

  login(user: { id: string; email: string; isSuperuser: boolean; mustResetPassword: boolean }) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      isSuperuser: user.isSuperuser,
      mustResetPassword: user.mustResetPassword,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        isSuperuser: user.isSuperuser,
        mustResetPassword: user.mustResetPassword,
      },
    };
  }

  async resetPassword(userId: string, dto: ResetPasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('As senhas não coincidem');
    }

    const hash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        mustResetPassword: false,
      },
    });
  }
}
