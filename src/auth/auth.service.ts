import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (user && (await bcrypt.compare(password, user.password))) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { password: _password, ...result } = user.toObject();
      return result;
    }
    return null;
  }

  async login(user: UserDocument) {
    const tokens = await this.getTokens(user._id.toString(), user.email);
    await this.usersService.updateRefreshToken(
      user._id.toString(),
      tokens.refreshToken,
    );
    return tokens;
  }

  async refreshTokens(userId: string, refreshToken: string) {
    const user = await this.usersService.findById(userId);
    if (!user || !user.refreshToken) {
      throw new UnauthorizedException('Access denied');
    }

    const refreshTokenMatches = await bcrypt.compare(
      refreshToken,
      user.refreshToken,
    );
    if (!refreshTokenMatches) {
      throw new UnauthorizedException('Access denied');
    }

    const tokens = await this.getTokens(user._id.toString(), user.email);
    await this.usersService.updateRefreshToken(
      user._id.toString(),
      tokens.refreshToken,
    );
    return tokens;
  }

  async logout(userId: string) {
    await this.usersService.updateRefreshToken(userId, null);
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return {
        message: 'If the email exists, a reset token has been generated',
      };
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await this.usersService.setResetPasswordToken(
      user._id.toString(),
      resetToken,
      expires,
    );

    return {
      message: 'Reset token generated',
      resetToken,
    };
  }

  async resetPassword(email: string, token: string, newPassword: string) {
    const user = await this.usersService.findByResetToken(email);
    if (!user || !user.resetPasswordToken) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const tokenMatches = await bcrypt.compare(token, user.resetPasswordToken);
    if (!tokenMatches) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    await this.usersService.resetPassword(user._id.toString(), newPassword);
    return { message: 'Password reset successfully' };
  }

  private async getTokens(userId: string, email: string) {
    const payload = { email, sub: userId };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: this.configService.get<string>('JWT_EXPIRATION') || '15m',
      } as any),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn:
          this.configService.get<string>('JWT_REFRESH_EXPIRATION') || '7d',
      } as any),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }
}
