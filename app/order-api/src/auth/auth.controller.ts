import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthProfileResponseDto } from './auth.dto';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppResponseDto } from 'src/app/app.dto';
import { ApiResponseWithType } from 'src/app/app.decorator';
import { CurrentUser } from '../user/user.decorator';
import { CurrentUserDto, UserScopeDto } from 'src/user/user.dto';

// Buoc 3.2: SAU route xac minh email/SDT da xoa khoi `trend` (ban that o
// `shared-user`, client goi qua `httpAuth`). Controller nay chi con hai route
// doc: `GET /auth/profile` va `GET /auth/scope` - ca hai GIU NGUYEN shape cu
// (muc 1.4). Vi khong con route `@Post` nao, cac import `Body`, `Post`,
// `Throttle` va nam DTO xac minh cung roi theo.

@ApiTags('Authentication')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @HttpCode(HttpStatus.OK)
  @Get('profile')
  @ApiOperation({ summary: 'Get profile' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  @ApiResponseWithType({
    type: AuthProfileResponseDto,
    description: 'Profile retrieved successful',
  })
  async getProfile(
    @CurrentUser(new ValidationPipe({ validateCustomDecorators: true }))
    user: CurrentUserDto,
  ): Promise<AppResponseDto<AuthProfileResponseDto>> {
    const result = await this.authService.getProfile(user);
    return {
      message: 'Profile retrieved successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result,
    } as AppResponseDto<AuthProfileResponseDto>;
  }

  @HttpCode(HttpStatus.OK)
  @Get('scope')
  @ApiOperation({
    summary: 'Get current user role and authority (permissions)',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  @ApiResponseWithType({
    type: UserScopeDto,
    description: 'Scope retrieved successful',
  })
  async getScope(
    @CurrentUser(new ValidationPipe({ validateCustomDecorators: true }))
    user: CurrentUserDto,
  ): Promise<AppResponseDto<UserScopeDto>> {
    return {
      message: 'Scope retrieved successfully',
      statusCode: HttpStatus.OK,
      timestamp: new Date().toISOString(),
      result: user.scope,
    } as AppResponseDto<UserScopeDto>;
  }

  // PATCH /auth/profile, PATCH /auth/upload va change-password/delete-account
  // da bi xoa khoi trend - identity (ho ten, avatar, mat khau, tai khoan)
  // thuoc ve shared-user, client ghi thang sang cac endpoint tuong ung ben
  // shared-user (PATCH /auth/profile, PATCH /auth/upload,
  // POST /auth/change-password, DELETE /auth/delete-account).
}
